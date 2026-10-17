import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getYoutubeService } from './auth.js';

const absolutePath = z.string().refine((value) => path.isAbsolute(value), {
  message: 'Provide an absolute local file path.',
});

const captionFormats: Record<string, string> = {
  '.ass': 'application/octet-stream',
  '.cap': 'application/octet-stream',
  '.scc': 'application/octet-stream',
  '.sbv': 'text/plain',
  '.srt': 'text/plain',
  '.ssa': 'application/octet-stream',
  '.ttml': 'application/ttml+xml',
  '.vtt': 'text/vtt',
};

function isFutureRfc3339(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));

  if (
    month < 1 ||
    month > 12 ||
    dateCheck.getUTCFullYear() !== year ||
    dateCheck.getUTCMonth() !== month - 1 ||
    dateCheck.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (zone !== 'Z') {
    const offsetMatch = /^[+-](\d{2}):(\d{2})$/.exec(zone);
    if (!offsetMatch || Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59) return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function getCaptionUpload(pathValue: string): Promise<{ resolvedPath: string; mimeType: string }> {
  const resolvedPath = path.resolve(pathValue);
  let stat: fs.Stats;
  try {
    const linkStat = await fs.promises.lstat(resolvedPath);
    if (linkStat.isSymbolicLink()) {
      throw new Error('Symbolic links are not accepted for caption media files.');
    }
    stat = await fs.promises.stat(resolvedPath);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Symbolic links')) throw error;
    throw new Error(`Caption media file is unavailable: ${resolvedPath}`);
  }

  if (!stat.isFile()) throw new Error(`Caption media path is not a regular file: ${resolvedPath}`);
  if (stat.size === 0) throw new Error(`Caption media file is empty: ${resolvedPath}`);

  const extension = path.extname(resolvedPath).toLowerCase();
  const mimeType = captionFormats[extension];
  if (!mimeType) {
    throw new Error(`Unsupported caption format "${extension || '(no extension)'}". Use .srt, .vtt, .sbv, .ttml, .scc, .cap, .ass, or .ssa.`);
  }

  return { resolvedPath, mimeType };
}

function apiError(action: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Unknown YouTube API error';
  return new Error(`${action} failed: ${message}`);
}

export const contentTools = {
  schedule_video: {
    description: 'Schedule an uploaded video for publication at a future RFC3339 instant. The video must currently be private; YouTube requires an authorized channel owner.',
    inputSchema: z.object({
      videoId: z.string().min(1).describe('ID of the already uploaded video'),
      publishAt: z.string().refine(isFutureRfc3339, {
        message: 'Provide a valid future RFC3339 instant, including seconds and a timezone (for example 2030-05-15T18:30:00Z).',
      }).describe('Future RFC3339 date/time with timezone'),
    }),
    handler: async (args: any) => {
      if (!isFutureRfc3339(args.publishAt)) {
        throw new Error('publishAt must be a valid future RFC3339 instant with an explicit timezone.');
      }

      const yt = await getYoutubeService();
      try {
        const current = await yt.videos.list({ part: ['status'], id: [args.videoId] });
        const video = current.data.items?.[0];
        if (!video) throw new Error(`Video not found: ${args.videoId}`);
        if (!video.status || video.status.privacyStatus !== 'private') {
          throw new Error('The video must be private before it can be scheduled. Set privacyStatus to private, then retry.');
        }

        const response = await yt.videos.update({
          part: ['status'],
          requestBody: {
            id: args.videoId,
            status: {
              privacyStatus: 'private',
              publishAt: args.publishAt,
              license: video.status.license,
              embeddable: video.status.embeddable,
              publicStatsViewable: video.status.publicStatsViewable,
              madeForKids: video.status.madeForKids,
              selfDeclaredMadeForKids: video.status.selfDeclaredMadeForKids,
            },
          },
        });

        return {
          success: true,
          videoId: response.data.id,
          privacyStatus: response.data.status?.privacyStatus,
          publishAt: response.data.status?.publishAt,
        };
      } catch (error) {
        throw apiError(`Scheduling video ${args.videoId}`, error);
      }
    },
  },

  list_caption_tracks: {
    description: 'List caption/subtitle track metadata for a video. The API does not return caption text in this operation.',
    inputSchema: z.object({
      videoId: z.string().min(1).describe('YouTube video ID'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      try {
        const response = await yt.captions.list({ part: ['snippet'], videoId: args.videoId });
        return {
          videoId: args.videoId,
          captions: (response.data.items || []).map((caption) => ({
            id: caption.id,
            language: caption.snippet?.language,
            name: caption.snippet?.name,
            trackKind: caption.snippet?.trackKind,
            isDraft: caption.snippet?.isDraft,
            isAutoSynced: caption.snippet?.isAutoSynced,
            isCC: caption.snippet?.isCC,
            lastUpdated: caption.snippet?.lastUpdated,
          })),
        };
      } catch (error) {
        throw apiError(`Listing caption tracks for video ${args.videoId}`, error);
      }
    },
  },

  upload_caption_track: {
    description: 'Upload a caption/subtitle file for an existing video. Reads media from a local absolute path; caption data is never accepted as base64.',
    inputSchema: z.object({
      videoId: z.string().min(1).describe('YouTube video ID'),
      language: z.string().min(2).max(35).describe('BCP-47 language code, for example en or en-US'),
      name: z.string().max(150).optional().describe('Optional caption track name'),
      filePath: absolutePath.describe('Absolute path to a local .srt, .vtt, .sbv, .ttml, .scc, .cap, .ass, or .ssa file'),
      isDraft: z.boolean().optional().default(false).describe('Upload as a draft, not yet publicly visible'),
    }),
    handler: async (args: any) => {
      const { resolvedPath, mimeType } = await getCaptionUpload(args.filePath);
      const yt = await getYoutubeService();
      try {
        const response = await yt.captions.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              videoId: args.videoId,
              language: args.language,
              name: args.name,
              isDraft: args.isDraft,
            },
          },
          media: { mimeType, body: fs.createReadStream(resolvedPath) },
        });
        return {
          success: true,
          captionTrack: {
            id: response.data.id,
            videoId: response.data.snippet?.videoId,
            language: response.data.snippet?.language,
            name: response.data.snippet?.name,
            isDraft: response.data.snippet?.isDraft,
          },
        };
      } catch (error) {
        throw apiError(`Uploading caption track for video ${args.videoId}`, error);
      }
    },
  },

  update_caption_track: {
    description: 'Update caption track metadata and/or replace its media from a local absolute path. Supply at least one change.',
    inputSchema: z.object({
      captionTrackId: z.string().min(1).describe('Caption track ID'),
      name: z.string().max(150).optional().describe('New caption track name'),
      isDraft: z.boolean().optional().describe('Whether the track should remain a draft'),
      filePath: absolutePath.optional().describe('Optional absolute path to replacement caption media'),
    }).refine((args) => args.name !== undefined || args.isDraft !== undefined || args.filePath !== undefined, {
      message: 'Supply name, isDraft, or filePath to update.',
    }),
    handler: async (args: any) => {
      const upload = args.filePath ? await getCaptionUpload(args.filePath) : undefined;
      const yt = await getYoutubeService();
      try {
        const response = await yt.captions.update({
          part: ['snippet'],
          requestBody: {
            id: args.captionTrackId,
            snippet: {
              name: args.name,
              isDraft: args.isDraft,
            },
          },
          ...(upload ? { media: { mimeType: upload.mimeType, body: fs.createReadStream(upload.resolvedPath) } } : {}),
        });
        return {
          success: true,
          captionTrack: {
            id: response.data.id,
            videoId: response.data.snippet?.videoId,
            language: response.data.snippet?.language,
            name: response.data.snippet?.name,
            isDraft: response.data.snippet?.isDraft,
            lastUpdated: response.data.snippet?.lastUpdated,
          },
        };
      } catch (error) {
        throw apiError(`Updating caption track ${args.captionTrackId}`, error);
      }
    },
  },

  download_caption_track: {
    description: 'Download a caption track to a new local file. Output path must be absolute; existing files are never overwritten.',
    inputSchema: z.object({
      captionTrackId: z.string().min(1).describe('Caption track ID'),
      filePath: absolutePath.describe('Absolute destination path for the downloaded caption file'),
      format: z.enum(['srt', 'sbv', 'vtt']).optional().describe('Optional output format supported by YouTube; omit to keep the original'),
      language: z.string().min(2).max(35).optional().describe('Optional translation language code, for example es'),
    }),
    handler: async (args: any) => {
      const outputPath = path.resolve(args.filePath);
      let output: fs.WriteStream | undefined;
      let createdOutput = false;
      try {
        const parent = path.dirname(outputPath);
        const parentStat = await fs.promises.stat(parent);
        if (!parentStat.isDirectory()) throw new Error(`Output parent is not a directory: ${parent}`);

        output = fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
          output!.once('open', () => {
            createdOutput = true;
            resolve();
          });
          output!.once('error', reject);
        });

        const yt = await getYoutubeService();
        const response = await yt.captions.download(
          {
            id: args.captionTrackId,
            tfmt: args.format,
            tlang: args.language,
          },
          { responseType: 'stream' },
        );
        await pipeline(response.data, output);
        return {
          success: true,
          captionTrackId: args.captionTrackId,
          filePath: outputPath,
          format: args.format || 'original',
          translatedLanguage: args.language,
        };
      } catch (error) {
        output?.destroy();
        if (createdOutput) {
          try {
            await fs.promises.unlink(outputPath);
          } catch {
            // Preserve the original failure if cleanup is unavailable.
          }
        }
        throw apiError(`Downloading caption track ${args.captionTrackId}`, error);
      }
    },
  },

  delete_caption_track: {
    description: 'Permanently delete a caption track. confirmationCaptionTrackId must exactly match captionTrackId.',
    inputSchema: z.object({
      captionTrackId: z.string().min(1).describe('Caption track ID to permanently delete'),
      confirmationCaptionTrackId: z.string().min(1).describe('Repeat captionTrackId exactly to confirm deletion'),
    }).refine((args) => args.captionTrackId === args.confirmationCaptionTrackId, {
      message: 'confirmationCaptionTrackId must exactly match captionTrackId.',
    }),
    handler: async (args: any) => {
      if (args.captionTrackId !== args.confirmationCaptionTrackId) {
        throw new Error('Deletion not confirmed: confirmationCaptionTrackId must exactly match captionTrackId.');
      }
      const yt = await getYoutubeService();
      try {
        await yt.captions.delete({ id: args.captionTrackId });
        return { success: true, deletedCaptionTrackId: args.captionTrackId };
      } catch (error) {
        throw apiError(`Deleting caption track ${args.captionTrackId}`, error);
      }
    },
  },

  moderate_comment: {
    description: 'Set a comment to heldForReview, published, or rejected. Requires channel/video-owner authorization; rejecting with banAuthor blocks future comments by that author.',
    inputSchema: z.object({
      commentId: z.string().min(1).describe('YouTube comment ID'),
      moderationStatus: z.enum(['heldForReview', 'published', 'rejected']),
      banAuthor: z.boolean().optional().describe('When rejecting, also prevent the author from commenting again'),
      confirmationCommentId: z.string().min(1).describe('Repeat commentId exactly to confirm the moderation action'),
    }).refine((args) => args.commentId === args.confirmationCommentId, {
      message: 'confirmationCommentId must exactly match commentId.',
    }).refine((args) => !args.banAuthor || args.moderationStatus === 'rejected', {
      message: 'banAuthor can only be used with moderationStatus rejected.',
    }),
    handler: async (args: any) => {
      if (args.commentId !== args.confirmationCommentId) {
        throw new Error('Moderation not confirmed: confirmationCommentId must exactly match commentId.');
      }
      if (args.banAuthor && args.moderationStatus !== 'rejected') {
        throw new Error('banAuthor can only be used with moderationStatus rejected.');
      }
      const yt = await getYoutubeService();
      try {
        await yt.comments.setModerationStatus({
          id: [args.commentId],
          moderationStatus: args.moderationStatus,
          banAuthor: args.banAuthor,
        });
        return {
          success: true,
          commentId: args.commentId,
          moderationStatus: args.moderationStatus,
          authorBanned: args.banAuthor === true,
        };
      } catch (error) {
        throw apiError(`Moderating comment ${args.commentId}`, error);
      }
    },
  },

  list_comment_replies: {
    description: 'List replies to a YouTube comment using the official comments.list endpoint.',
    inputSchema: z.object({
      parentId: z.string().trim().min(1),
      maxResults: z.number().int().min(1).max(100).optional().default(50),
      pageToken: z.string().optional(),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.comments.list({
        part: ['snippet'],
        parentId: args.parentId,
        maxResults: args.maxResults,
        pageToken: args.pageToken,
        textFormat: 'plainText',
      });
      return {
        replies: (response.data.items || []).map((item) => ({
          commentId: item.id,
          parentId: item.snippet?.parentId,
          author: item.snippet?.authorDisplayName,
          authorChannelId: item.snippet?.authorChannelId?.value,
          text: item.snippet?.textDisplay,
          publishedAt: item.snippet?.publishedAt,
          updatedAt: item.snippet?.updatedAt,
          likeCount: item.snippet?.likeCount,
        })),
        totalResults: response.data.pageInfo?.totalResults,
        nextPageToken: response.data.nextPageToken,
      };
    },
  },

  update_comment: {
    description: 'Edit a comment owned by the authorized channel. The API rejects comments the channel does not own.',
    inputSchema: z.object({
      commentId: z.string().trim().min(1),
      text: z.string().trim().min(1).max(10000),
      confirmationCommentId: z.string().trim().min(1)
        .describe('Repeat commentId exactly to confirm the edit'),
    }).refine((args) => args.commentId === args.confirmationCommentId, {
      message: 'confirmationCommentId must exactly match commentId.',
    }),
    handler: async (args: any) => {
      if (args.commentId !== args.confirmationCommentId) {
        throw new Error('Comment edit not confirmed: confirmationCommentId must exactly match commentId.');
      }
      const yt = await getYoutubeService();
      const current = await yt.comments.list({ part: ['snippet'], id: [args.commentId] });
      const comment = current.data.items?.[0];
      if (!comment?.id) throw new Error(`Comment not found: ${args.commentId}`);
      const response = await yt.comments.update({
        part: ['snippet'],
        requestBody: {
          id: args.commentId,
          snippet: { parentId: comment.snippet?.parentId, textOriginal: args.text },
        },
      });
      return {
        success: true,
        commentId: response.data.id,
        parentId: response.data.snippet?.parentId,
        text: response.data.snippet?.textDisplay,
        updatedAt: response.data.snippet?.updatedAt,
      };
    },
  },

  add_top_level_comment: {
    description: 'Post a new top-level comment on a video. The comment is published using the authorized channel account and must comply with YouTube policies.',
    inputSchema: z.object({
      videoId: z.string().min(1).describe('YouTube video ID'),
      text: z.string().trim().min(1).max(10000).describe('Comment text'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      try {
        const response = await yt.commentThreads.insert({
          part: ['snippet'],
          requestBody: {
            snippet: {
              videoId: args.videoId,
              topLevelComment: { snippet: { textOriginal: args.text } },
            },
          },
        });
        const comment = response.data.snippet?.topLevelComment;
        return {
          success: true,
          threadId: response.data.id,
          commentId: comment?.id,
          videoId: comment?.snippet?.videoId,
          text: comment?.snippet?.textDisplay,
          publishedAt: comment?.snippet?.publishedAt,
        };
      } catch (error) {
        throw apiError(`Posting a top-level comment on video ${args.videoId}`, error);
      }
    },
  },

  move_playlist_item: {
    description: 'Move an existing playlist item to a zero-based position. Reads the item first to preserve its playlist and video resource IDs.',
    inputSchema: z.object({
      playlistItemId: z.string().min(1).describe('Playlist item ID, not video ID'),
      position: z.number().int().min(0).describe('New zero-based position in the playlist'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      try {
        const current = await yt.playlistItems.list({
          part: ['snippet'],
          id: [args.playlistItemId],
        });
        const item = current.data.items?.[0];
        if (!item?.id || !item.snippet?.playlistId || !item.snippet.resourceId?.videoId) {
          throw new Error(`Playlist item not found or missing required IDs: ${args.playlistItemId}`);
        }

        const response = await yt.playlistItems.update({
          part: ['snippet'],
          requestBody: {
            id: item.id,
            snippet: {
              playlistId: item.snippet.playlistId,
              resourceId: item.snippet.resourceId,
              position: args.position,
            },
          },
        });
        return {
          success: true,
          playlistItemId: response.data.id,
          playlistId: response.data.snippet?.playlistId,
          videoId: response.data.snippet?.resourceId?.videoId,
          position: response.data.snippet?.position,
        };
      } catch (error) {
        throw apiError(`Moving playlist item ${args.playlistItemId}`, error);
      }
    },
  },
};
