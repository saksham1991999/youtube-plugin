import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { getYoutubeService } from './auth.js';

export const videosBaseTools = {

  list_videos: {
    description: 'List videos from your channel or a specific channel/playlist',
    inputSchema: z.object({
      channelId: z.string().optional().describe('Channel ID (omit for your own channel)'),
      playlistId: z.string().optional().describe('Playlist ID to list videos from (overrides channelId)'),
      maxResults: z.number().int().min(1).max(50).optional().default(20).describe('Number of videos to return (max 50)'),
      orderBy: z.enum(['date', 'rating', 'viewCount', 'title']).optional().default('date').describe('Sort order'),
      pageToken: z.string().optional().describe('Page token for pagination'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      if (args.playlistId) {
        const res = await yt.playlistItems.list({
          part: ['snippet', 'contentDetails', 'status'],
          playlistId: args.playlistId,
          maxResults: Math.min(args.maxResults, 50),
          pageToken: args.pageToken,
        });

        return {
          videos: res.data.items?.map((item: any) => ({
            videoId: item.contentDetails?.videoId,
            title: item.snippet?.title,
            description: item.snippet?.description?.substring(0, 200),
            publishedAt: item.snippet?.publishedAt,
            thumbnails: item.snippet?.thumbnails,
            position: item.snippet?.position,
            status: item.status?.privacyStatus,
          })) || [],
          totalResults: res.data.pageInfo?.totalResults,
          nextPageToken: res.data.nextPageToken,
        };
      }

      if (args.orderBy === 'date') {
        const channelResponse = await yt.channels.list({
          part: ['contentDetails'],
          ...(args.channelId ? { id: [args.channelId] } : { mine: true }),
        });
        const uploadsPlaylistId = channelResponse.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsPlaylistId) {
          throw new Error('Could not find the channel uploads playlist. Verify the channel and account access.');
        }

        const res = await yt.playlistItems.list({
          part: ['snippet', 'contentDetails', 'status'],
          playlistId: uploadsPlaylistId,
          maxResults: args.maxResults,
          pageToken: args.pageToken,
        });
        return {
          videos: res.data.items?.map((item: any) => ({
            videoId: item.contentDetails?.videoId,
            title: item.snippet?.title,
            description: item.snippet?.description?.substring(0, 200),
            publishedAt: item.snippet?.publishedAt,
            thumbnails: item.snippet?.thumbnails,
            position: item.snippet?.position,
            status: item.status?.privacyStatus,
          })) || [],
          totalResults: res.data.pageInfo?.totalResults,
          nextPageToken: res.data.nextPageToken,
        };
      }

      const params: any = {
        part: ['snippet'],
        type: ['video'],
        maxResults: Math.min(args.maxResults, 50),
        order: args.orderBy,
        pageToken: args.pageToken,
      };

      if (args.channelId) {
        params.channelId = args.channelId;
      } else {
        params.forMine = true;
      }

      const res = await yt.search.list(params);

      return {
        videos: res.data.items?.map((item: any) => ({
          videoId: item.id?.videoId,
          title: item.snippet?.title,
          description: item.snippet?.description?.substring(0, 200),
          publishedAt: item.snippet?.publishedAt,
          thumbnails: item.snippet?.thumbnails,
          channelTitle: item.snippet?.channelTitle,
        })) || [],
        totalResults: res.data.pageInfo?.totalResults,
        nextPageToken: res.data.nextPageToken,
      };
    },
  },

  get_video: {
    description: 'Get full details for a specific video (stats, tags, description, status, etc.)',
    inputSchema: z.object({
      videoId: z.string().describe('YouTube video ID'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const res = await yt.videos.list({
        part: ['snippet', 'statistics', 'status', 'contentDetails', 'topicDetails'],
        id: [args.videoId],
      });

      const video = res.data.items?.[0];
      if (!video) throw new Error(`Video not found: ${args.videoId}`);

      return {
        id: video.id,
        title: video.snippet?.title,
        description: video.snippet?.description,
        tags: video.snippet?.tags,
        categoryId: video.snippet?.categoryId,
        publishedAt: video.snippet?.publishedAt,
        channelId: video.snippet?.channelId,
        channelTitle: video.snippet?.channelTitle,
        thumbnails: video.snippet?.thumbnails,
        defaultLanguage: video.snippet?.defaultLanguage,
        statistics: {
          viewCount: video.statistics?.viewCount,
          likeCount: video.statistics?.likeCount,
          commentCount: video.statistics?.commentCount,
          favoriteCount: video.statistics?.favoriteCount,
        },
        status: {
          privacyStatus: video.status?.privacyStatus,
          uploadStatus: video.status?.uploadStatus,
          license: video.status?.license,
          embeddable: video.status?.embeddable,
          madeForKids: video.status?.madeForKids,
        },
        contentDetails: {
          duration: video.contentDetails?.duration,
          dimension: video.contentDetails?.dimension,
          definition: video.contentDetails?.definition,
          caption: video.contentDetails?.caption,
        },
        topics: video.topicDetails?.topicCategories,
      };
    },
  },

  update_video: {
    description: 'Update a video title, description, tags, category, privacy, or made-for-kids status',
    inputSchema: z.object({
      videoId: z.string().describe('YouTube video ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      tags: z.array(z.string()).optional().describe('New tags array'),
      categoryId: z.string().optional().describe('Category ID (e.g., "22" for People & Blogs, "28" for Science & Technology)'),
      privacyStatus: z.enum(['public', 'private', 'unlisted']).optional().describe('Privacy status'),
      madeForKids: z.boolean().optional().describe('Whether the video is made for kids'),
      defaultLanguage: z.string().optional().describe('Default language code (e.g., "en")'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const current = await yt.videos.list({
        part: ['snippet', 'status'],
        id: [args.videoId],
      });

      const video = current.data.items?.[0];
      if (!video) throw new Error(`Video not found: ${args.videoId}`);

      const snippet = video.snippet || {};
      const status = video.status || {};

      if (args.title !== undefined) snippet.title = args.title;
      if (args.description !== undefined) snippet.description = args.description;
      if (args.tags !== undefined) snippet.tags = args.tags;
      if (args.categoryId !== undefined) snippet.categoryId = args.categoryId;
      if (args.defaultLanguage !== undefined) snippet.defaultLanguage = args.defaultLanguage;

      if (args.privacyStatus !== undefined) status.privacyStatus = args.privacyStatus;
      if (args.madeForKids !== undefined) status.madeForKids = args.madeForKids;

      const res = await yt.videos.update({
        part: ['snippet', 'status'],
        requestBody: {
          id: args.videoId,
          snippet,
          status,
        },
      });

      return {
        success: true,
        video: {
          id: res.data.id,
          title: res.data.snippet?.title,
          description: res.data.snippet?.description?.substring(0, 200),
          tags: res.data.snippet?.tags,
          privacyStatus: res.data.status?.privacyStatus,
        },
      };
    },
  },

  delete_video: {
    description: 'Delete a video from your channel (permanent, cannot be undone)',
    inputSchema: z.object({
      videoId: z.string().describe('YouTube video ID to delete'),
      confirmTitle: z.string().min(1).describe('Exact current video title, required to confirm permanent deletion'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const current = await yt.videos.list({ part: ['snippet'], id: [args.videoId] });
      const title = current.data.items?.[0]?.snippet?.title;
      if (!title) throw new Error(`Video not found: ${args.videoId}`);
      if (args.confirmTitle !== title) {
        throw new Error(`Deletion stopped. Fetch the video with get_video and retry using its exact current title as confirmTitle.`);
      }
      await yt.videos.delete({ id: args.videoId });
      return { success: true, message: `Video ${args.videoId} deleted permanently` };
    },
  },

  upload_video: {
    description: 'Upload a video file from a local path to YouTube. Supports resumable uploads for large files.',
    inputSchema: z.object({
      filePath: z.string().describe('Absolute path to the video file on disk'),
      title: z.string().describe('Video title'),
      description: z.string().optional().default('').describe('Video description'),
      tags: z.array(z.string()).optional().describe('Tags array'),
      categoryId: z.string().optional().default('22').describe('Category ID (default "22" = People & Blogs, "28" = Science & Technology)'),
      privacyStatus: z.enum(['public', 'private', 'unlisted']).optional().default('private').describe('Privacy status (defaults to private for safety)'),
      madeForKids: z.boolean().optional().default(false).describe('Whether the video is made for kids'),
      defaultLanguage: z.string().optional().default('en').describe('Default language code'),
      playlistId: z.string().optional().describe('Playlist ID to add the video to after upload'),
      notifySubscribers: z.boolean().optional().default(true).describe('Whether to notify subscribers'),
      publishAt: z.string().datetime({ offset: true }).optional()
        .describe('Optional future publish time (RFC3339). Scheduled uploads must use private privacyStatus.'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      if (args.publishAt) {
        if (Date.parse(args.publishAt) <= Date.now()) throw new Error('publishAt must be a future RFC3339 date-time.');
        if (args.privacyStatus !== 'private') throw new Error('Scheduled uploads must have privacyStatus="private".');
      }

      // Validate file exists
      const resolvedPath = path.resolve(args.filePath);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
      }

      const stat = fs.statSync(resolvedPath);
      const fileSizeMB = (stat.size / (1024 * 1024)).toFixed(1);

      // Detect mime type from extension
      const ext = path.extname(resolvedPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.m4v': 'video/mp4',
        '.3gp': 'video/3gpp',
      };

      const mimeType = mimeMap[ext];
      if (!mimeType) {
        throw new Error(`Unsupported video format: ${ext}. Supported: ${Object.keys(mimeMap).join(', ')}`);
      }

      const fileStream = fs.createReadStream(resolvedPath);

      const res = await yt.videos.insert({
        part: ['snippet', 'status'],
        notifySubscribers: args.notifySubscribers,
        requestBody: {
          snippet: {
            title: args.title,
            description: args.description,
            tags: args.tags,
            categoryId: args.categoryId,
            defaultLanguage: args.defaultLanguage,
          },
          status: {
            privacyStatus: args.privacyStatus,
            madeForKids: args.madeForKids,
            selfDeclaredMadeForKids: args.madeForKids,
            ...(args.publishAt ? { publishAt: args.publishAt } : {}),
          },
        },
        media: {
          mimeType,
          body: fileStream,
        },
      });

      const videoId = res.data.id;
      const result: any = {
        success: true,
        video: {
          id: videoId,
          title: res.data.snippet?.title,
          description: res.data.snippet?.description?.substring(0, 200),
          privacyStatus: res.data.status?.privacyStatus,
          uploadStatus: res.data.status?.uploadStatus,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
        },
        fileSize: `${fileSizeMB} MB`,
      };

      // Optionally add to playlist
      if (args.playlistId && videoId) {
        try {
          await yt.playlistItems.insert({
            part: ['snippet'],
            requestBody: {
              snippet: {
                playlistId: args.playlistId,
                resourceId: {
                  kind: 'youtube#video',
                  videoId,
                },
              },
            },
          });
          result.addedToPlaylist = args.playlistId;
        } catch (plError: any) {
          result.playlistError = `Failed to add to playlist: ${plError.message}`;
        }
      }

      return result;
    },
  },

  set_thumbnail: {
    description: 'Set a custom thumbnail for a video. Provide the image as a base64-encoded string.',
    inputSchema: z.object({
      videoId: z.string().describe('YouTube video ID'),
      imageBase64: z.string().describe('Base64-encoded image data (JPEG, PNG, or BMP, max 2MB)'),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/bmp']).optional().default('image/jpeg').describe('Image MIME type'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const { Readable } = await import('stream');

      const buffer = Buffer.from(args.imageBase64, 'base64');
      if (buffer.length > 2 * 1024 * 1024) {
        throw new Error('Thumbnail must be under 2MB');
      }

      const stream = Readable.from(buffer);

      const res = await yt.thumbnails.set({
        videoId: args.videoId,
        media: {
          mimeType: args.mimeType,
          body: stream,
        },
      });

      return {
        success: true,
        thumbnails: res.data.items?.[0]?.default || res.data.items?.[0],
      };
    },
  },

  set_thumbnail_from_file: {
    description: 'Set a custom JPEG or PNG thumbnail from an absolute local file path (maximum 2 MB).',
    inputSchema: z.object({
      videoId: z.string().min(1).describe('YouTube video ID'),
      filePath: z.string().min(1).describe('Absolute path to a local JPEG or PNG image'),
    }),
    handler: async (args: any) => {
      if (!path.isAbsolute(args.filePath)) throw new Error('filePath must be an absolute local path.');
      const resolvedPath = path.resolve(args.filePath);
      const stat = fs.lstatSync(resolvedPath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Thumbnail path must be a regular file, not a symlink.');
      if (stat.size === 0 || stat.size > 2 * 1024 * 1024) throw new Error('Thumbnail image must be non-empty and no larger than 2 MB.');
      const extension = path.extname(resolvedPath).toLowerCase();
      const mimeType = extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.png' ? 'image/png' : undefined;
      if (!mimeType) throw new Error('Thumbnail file must use a .jpg, .jpeg, or .png extension.');

      const yt = await getYoutubeService();
      const response = await yt.thumbnails.set({
        videoId: args.videoId,
        media: { mimeType, body: fs.createReadStream(resolvedPath) },
      });
      return {
        success: true,
        videoId: args.videoId,
        thumbnails: response.data.items?.[0]?.default || response.data.items?.[0],
      };
    },
  },
};
