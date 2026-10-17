import { constants, fstatSync, openSync, readFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { getYoutubeService } from './auth.js';

const MAX_BANNER_BYTES = 6 * 1024 * 1024;
const MAX_WATERMARK_BYTES = 10 * 1024 * 1024;

type ImageInfo = {
  mimeType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
};

/**
 * Read only a regular, non-symlink file at an explicit absolute path. Opening
 * with O_NOFOLLOW prevents a symlink swap between validation and file access.
 */
function readLocalImage(filePath: string, maxBytes: number): Buffer {
  if (!path.isAbsolute(filePath)) {
    throw new Error('filePath must be an absolute local file path.');
  }

  let fd: number | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    fd = openSync(filePath, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('The provided image path must point to a regular file.');
    }
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw new Error(`Image file must be non-empty and no larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`);
    }

    const buffer = readFileSync(fd);
    if (buffer.length !== stat.size || buffer.length > maxBytes) {
      throw new Error('Image changed while being read; retry with a stable local file.');
    }
    return buffer;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Image')) throw error;
    if (error instanceof Error && error.message.startsWith('The provided image')) throw error;
    throw new Error(`Could not safely read image at "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function imageInfo(buffer: Buffer): ImageInfo {
  const isPng = buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.toString('ascii', 12, 16) === 'IHDR';
  if (isPng) {
    return {
      mimeType: 'image/png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (frameMarkers.has(marker)) {
        if (segmentLength < 7) break;
        return {
          mimeType: 'image/jpeg',
          height: buffer.readUInt16BE(offset + 3),
          width: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += segmentLength;
    }
    throw new Error('JPEG image is malformed or has no readable dimensions.');
  }

  throw new Error('Unsupported or invalid image. Use a real PNG or JPEG file.');
}

function validateDimensions(info: ImageInfo): void {
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width <= 0 || info.height <= 0) {
    throw new Error('Image has invalid pixel dimensions.');
  }
}

function sectionSummary(section: any) {
  return {
    id: section.id,
    type: section.snippet?.type,
    title: section.snippet?.title,
    position: section.snippet?.position,
    playlists: section.contentDetails?.playlists,
    channels: section.contentDetails?.channels,
  };
}

const sectionType = z.enum([
  'allPlaylists',
  'completedEvents',
  'liveEvents',
  'likedPlaylists',
  'multipleChannels',
  'multiplePlaylists',
  'popularUploads',
  'recentActivity',
  'recentUploads',
  'singlePlaylist',
  'subscriptions',
  'upcomingEvents',
]);

function validateSectionContents(type: string, playlistIds?: string[], channelIds?: string[]): void {
  if (type === 'singlePlaylist' && playlistIds?.length !== 1) {
    throw new Error('A singlePlaylist section requires exactly one playlistId.');
  }
  if (type === 'multiplePlaylists' && !playlistIds?.length) {
    throw new Error('A multiplePlaylists section requires at least one playlistId.');
  }
  if (type === 'multipleChannels' && !channelIds?.length) {
    throw new Error('A multipleChannels section requires at least one channelId.');
  }
  if (!['singlePlaylist', 'multiplePlaylists'].includes(type) && playlistIds?.length) {
    throw new Error(`playlistIds are only valid for singlePlaylist or multiplePlaylists sections.`);
  }
  if (type !== 'multipleChannels' && channelIds?.length) {
    throw new Error('channelIds are only valid for multipleChannels sections.');
  }
}

/**
 * YouTube channel branding and layout tools. Write operations require the
 * youtube OAuth scope (channel banner upload also accepts youtube.upload).
 */
export const brandingTools = {
  upload_channel_banner: {
    description: 'Upload and apply a banner image to your authenticated YouTube channel. Requires youtube scope for channels.update (or youtube.upload for upload); YouTube accepts PNG/JPEG banners at least 2048×1152, 16:9, max 6 MB. Upload plus update are separate API calls.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to a local PNG or JPEG banner image (minimum 2048×1152, 16:9, max 6 MB)'),
    }),
    handler: async (args: any) => {
      const buffer = readLocalImage(args.filePath, MAX_BANNER_BYTES);
      const info = imageInfo(buffer);
      validateDimensions(info);
      if (info.width < 2048 || info.height < 1152 || Math.abs(info.width / info.height - 16 / 9) > 0.01) {
        throw new Error(`Banner must be at least 2048×1152 pixels and 16:9; file is ${info.width}×${info.height}.`);
      }

      const yt = await getYoutubeService();
      const current = await yt.channels.list({ part: ['brandingSettings'], mine: true });
      const channel = current.data.items?.[0];
      if (!channel?.id) throw new Error('No authenticated YouTube channel found.');

      const uploaded = await yt.channelBanners.insert({
        media: { mimeType: info.mimeType, body: Readable.from(buffer) },
      });
      if (!uploaded.data.url) throw new Error('YouTube accepted the banner upload but returned no banner URL; the banner was not applied.');

      const previousBranding = channel.brandingSettings || {};
      const updated = await yt.channels.update({
        part: ['brandingSettings'],
        requestBody: {
          id: channel.id,
          brandingSettings: {
            ...(previousBranding.channel ? { channel: previousBranding.channel } : {}),
            ...(previousBranding.watch ? { watch: previousBranding.watch } : {}),
            ...(previousBranding.hints ? { hints: previousBranding.hints } : {}),
            image: {
              ...(previousBranding.image?.backgroundImageUrl
                ? { backgroundImageUrl: previousBranding.image.backgroundImageUrl }
                : {}),
              bannerExternalUrl: uploaded.data.url,
            },
          },
        },
      });

      return {
        success: true,
        channelId: updated.data.id,
        bannerApplied: Boolean(updated.data.brandingSettings?.image?.bannerExternalUrl),
        dimensions: `${info.width}×${info.height}`,
        mimeType: info.mimeType,
      };
    },
  },

  set_channel_watermark: {
    description: 'Set a channel video watermark from a local PNG/JPEG image. Requires youtube scope; image must be square, at least 150×150, and under 10 MB. The watermark appears on videos for the selected channel and can link to targetChannelId.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to a local square PNG or JPEG watermark image (minimum 150×150, max 10 MB)'),
      channelId: z.string().optional().describe('Channel to brand (omit to use the authenticated channel)'),
      targetChannelId: z.string().optional().describe('Channel opened when viewers select the watermark (defaults to the branded channel)'),
      timingType: z.enum(['offsetFromStart', 'offsetFromEnd']).optional().default('offsetFromStart').describe('Whether offsetMs is measured from video start or end'),
      offsetMs: z.number().int().min(0).optional().default(0).describe('Non-negative display offset in milliseconds'),
      durationMs: z.number().int().positive().optional().describe('Optional display duration in milliseconds; omit to use YouTube default'),
      corner: z.enum(['topLeft', 'topRight', 'bottomLeft', 'bottomRight']).optional().default('bottomRight').describe('Corner in which YouTube places the watermark'),
    }),
    handler: async (args: any) => {
      const buffer = readLocalImage(args.filePath, MAX_WATERMARK_BYTES);
      const info = imageInfo(buffer);
      validateDimensions(info);
      if (info.width !== info.height || info.width < 150) {
        throw new Error(`Watermark must be square and at least 150×150 pixels; file is ${info.width}×${info.height}.`);
      }

      const yt = await getYoutubeService();
      let channelId = args.channelId;
      if (!channelId) {
        const current = await yt.channels.list({ part: ['id'], mine: true });
        channelId = current.data.items?.[0]?.id;
      }
      if (!channelId) throw new Error('No authenticated YouTube channel found; provide channelId or authorize the channel owner.');

      const timing: { type: string; offsetMs: string; durationMs?: string } = {
        type: args.timingType,
        offsetMs: String(args.offsetMs),
      };
      if (args.durationMs !== undefined) timing.durationMs = String(args.durationMs);

      await yt.watermarks.set({
        channelId,
        requestBody: {
          targetChannelId: args.targetChannelId,
          position: { type: 'corner', cornerPosition: args.corner },
          timing,
        },
        media: { mimeType: info.mimeType, body: Readable.from(buffer) },
      });

      return {
        success: true,
        channelId,
        targetChannelId: args.targetChannelId || channelId,
        position: args.corner,
        timing,
        mimeType: info.mimeType,
        dimensions: `${info.width}×${info.height}`,
      };
    },
  },

  unset_channel_watermark: {
    description: 'Remove the channel video watermark permanently. Requires youtube scope and explicit confirm=true because this deletes the current watermark.',
    inputSchema: z.object({
      channelId: z.string().optional().describe('Channel whose watermark to remove (omit for the authenticated channel)'),
      confirm: z.literal(true).describe('Required explicit confirmation that the current watermark will be removed'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      let channelId = args.channelId;
      if (!channelId) {
        const current = await yt.channels.list({ part: ['id'], mine: true });
        channelId = current.data.items?.[0]?.id;
      }
      if (!channelId) throw new Error('No authenticated YouTube channel found; provide channelId or authorize the channel owner.');

      await yt.watermarks.unset({ channelId });
      return { success: true, channelId, watermarkRemoved: true };
    },
  },

  list_channel_sections: {
    description: 'List channel sections (home-page shelves) for your authenticated channel or a specified public channel. Requires youtube.readonly or broader YouTube OAuth scope; access to private layouts is restricted to the channel owner.',
    inputSchema: z.object({
      channelId: z.string().optional().describe('Channel ID (omit to list the authenticated channel)'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const res = await yt.channelSections.list({
        part: ['id', 'snippet', 'contentDetails'],
        ...(args.channelId ? { channelId: args.channelId } : { mine: true }),
      });

      return { sections: (res.data.items || []).map(sectionSummary), count: res.data.items?.length || 0 };
    },
  },

  create_channel_section: {
    description: 'Create a channel home-page section. Requires youtube scope; YouTube allows at most 10 sections per channel and only the documented section types. Private channel changes require the channel owner or eligible CMS access.',
    inputSchema: z.object({
      type: sectionType.describe('Supported YouTube channel-section type'),
      title: z.string().min(1).max(100).optional().describe('Custom title (supported for multiplePlaylists and multipleChannels)'),
      position: z.number().int().nonnegative().optional().describe('Zero-based shelf position'),
      playlistIds: z.array(z.string().min(1)).optional().describe('Playlist IDs for singlePlaylist (exactly one) or multiplePlaylists'),
      channelIds: z.array(z.string().min(1)).optional().describe('Channel IDs for multipleChannels'),
      defaultLanguage: z.string().optional().describe('Language code for the custom title'),
    }),
    handler: async (args: any) => {
      validateSectionContents(args.type, args.playlistIds, args.channelIds);
      if (args.title !== undefined && !['multiplePlaylists', 'multipleChannels'].includes(args.type)) {
        throw new Error('Custom title is only supported for multiplePlaylists and multipleChannels sections.');
      }
      const yt = await getYoutubeService();
      const res = await yt.channelSections.insert({
        part: ['snippet', 'contentDetails'],
        requestBody: {
          snippet: {
            type: args.type,
            title: args.title,
            position: args.position,
            defaultLanguage: args.defaultLanguage,
          },
          contentDetails: {
            ...(args.playlistIds ? { playlists: args.playlistIds } : {}),
            ...(args.channelIds ? { channels: args.channelIds } : {}),
          },
        },
      });

      return { success: true, section: sectionSummary(res.data) };
    },
  },

  update_channel_section: {
    description: 'Update an existing channel section title, position, or playlist/channel contents. Requires youtube scope; only sections owned by the authenticated channel can be changed.',
    inputSchema: z.object({
      sectionId: z.string().min(1).describe('Channel-section ID'),
      title: z.string().min(1).max(100).optional().describe('New custom title (multiplePlaylists or multipleChannels only)'),
      position: z.number().int().nonnegative().optional().describe('New zero-based shelf position'),
      playlistIds: z.array(z.string().min(1)).optional().describe('Replacement playlist IDs for singlePlaylist or multiplePlaylists'),
      channelIds: z.array(z.string().min(1)).optional().describe('Replacement channel IDs for multipleChannels'),
      defaultLanguage: z.string().optional().describe('Language code for the custom title'),
    }),
    handler: async (args: any) => {
      if (args.title === undefined && args.position === undefined && args.playlistIds === undefined
        && args.channelIds === undefined && args.defaultLanguage === undefined) {
        throw new Error('Provide at least one section field to update.');
      }

      const yt = await getYoutubeService();
      const current = await yt.channelSections.list({
        part: ['id', 'snippet', 'contentDetails'],
        mine: true,
      });
      const section = current.data.items?.find((item) => item.id === args.sectionId);
      if (!section?.id || !section.snippet?.type) {
        throw new Error(`Channel section not found or not accessible: ${args.sectionId}`);
      }
      const type = section.snippet.type;
      const playlists = args.playlistIds ?? section.contentDetails?.playlists ?? undefined;
      const channels = args.channelIds ?? section.contentDetails?.channels ?? undefined;
      validateSectionContents(type, playlists, channels);
      if (args.title !== undefined && !['multiplePlaylists', 'multipleChannels'].includes(type)) {
        throw new Error('Custom title is only supported for multiplePlaylists and multipleChannels sections.');
      }

      const snippet: {
        type: string;
        title?: string | null;
        position?: number | null;
        defaultLanguage?: string | null;
      } = { type };
      const contentDetails = { ...(section.contentDetails || {}) };
      if (section.snippet.title !== undefined) snippet.title = section.snippet.title;
      if (section.snippet.position !== undefined) snippet.position = section.snippet.position;
      if (section.snippet.defaultLanguage !== undefined) snippet.defaultLanguage = section.snippet.defaultLanguage;
      if (args.title !== undefined) snippet.title = args.title;
      if (args.position !== undefined) snippet.position = args.position;
      if (args.defaultLanguage !== undefined) snippet.defaultLanguage = args.defaultLanguage;
      if (args.playlistIds !== undefined) contentDetails.playlists = args.playlistIds;
      if (args.channelIds !== undefined) contentDetails.channels = args.channelIds;

      const res = await yt.channelSections.update({
        part: ['snippet', 'contentDetails'],
        requestBody: { id: args.sectionId, snippet, contentDetails },
      });
      return { success: true, section: sectionSummary(res.data) };
    },
  },

  delete_channel_section: {
    description: 'Delete a channel section permanently. Requires youtube scope and explicit confirm=true; the section cannot be restored automatically.',
    inputSchema: z.object({
      sectionId: z.string().min(1).describe('Channel-section ID to delete'),
      confirm: z.literal(true).describe('Required explicit confirmation that this section will be deleted'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      await yt.channelSections.delete({ id: args.sectionId });
      return { success: true, sectionId: args.sectionId, deleted: true };
    },
  },
};
