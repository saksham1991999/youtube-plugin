import { z } from 'zod';
import { getYoutubeService } from './auth.js';

export const playlistsBaseTools = {

  list_playlists: {
    description: 'List playlists from your channel or a specific channel',
    inputSchema: z.object({
      channelId: z.string().optional().describe('Channel ID (omit for your own channel)'),
      maxResults: z.number().int().min(1).max(50).optional().default(25).describe('Number of playlists to return (max 50)'),
      pageToken: z.string().optional().describe('Page token for pagination'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const params: any = {
        part: ['snippet', 'contentDetails', 'status'],
        maxResults: Math.min(args.maxResults, 50),
        pageToken: args.pageToken,
      };

      if (args.channelId) {
        params.channelId = args.channelId;
      } else {
        params.mine = true;
      }

      const res = await yt.playlists.list(params);

      return {
        playlists: res.data.items?.map((pl: any) => ({
          id: pl.id,
          title: pl.snippet?.title,
          description: pl.snippet?.description,
          publishedAt: pl.snippet?.publishedAt,
          thumbnails: pl.snippet?.thumbnails,
          itemCount: pl.contentDetails?.itemCount,
          privacyStatus: pl.status?.privacyStatus,
        })) || [],
        totalResults: res.data.pageInfo?.totalResults,
        nextPageToken: res.data.nextPageToken,
      };
    },
  },

  create_playlist: {
    description: 'Create a new playlist on your channel',
    inputSchema: z.object({
      title: z.string().describe('Playlist title'),
      description: z.string().optional().describe('Playlist description'),
      privacyStatus: z.enum(['public', 'private', 'unlisted']).optional().default('public').describe('Privacy status'),
      defaultLanguage: z.string().optional().describe('Default language code'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const res = await yt.playlists.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title: args.title,
            description: args.description,
            defaultLanguage: args.defaultLanguage,
          },
          status: {
            privacyStatus: args.privacyStatus,
          },
        },
      });

      return {
        success: true,
        playlist: {
          id: res.data.id,
          title: res.data.snippet?.title,
          description: res.data.snippet?.description,
          privacyStatus: res.data.status?.privacyStatus,
          url: `https://www.youtube.com/playlist?list=${res.data.id}`,
        },
      };
    },
  },

  update_playlist: {
    description: 'Update an existing playlist title, description, or privacy',
    inputSchema: z.object({
      playlistId: z.string().describe('Playlist ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      privacyStatus: z.enum(['public', 'private', 'unlisted']).optional().describe('New privacy status'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const current = await yt.playlists.list({
        part: ['snippet', 'status'],
        id: [args.playlistId],
      });

      const playlist = current.data.items?.[0];
      if (!playlist) throw new Error(`Playlist not found: ${args.playlistId}`);

      const snippet = playlist.snippet || {};
      const status = playlist.status || {};

      if (args.title !== undefined) snippet.title = args.title;
      if (args.description !== undefined) snippet.description = args.description;
      if (args.privacyStatus !== undefined) status.privacyStatus = args.privacyStatus;

      const res = await yt.playlists.update({
        part: ['snippet', 'status'],
        requestBody: {
          id: args.playlistId,
          snippet,
          status,
        },
      });

      return {
        success: true,
        playlist: {
          id: res.data.id,
          title: res.data.snippet?.title,
          description: res.data.snippet?.description,
          privacyStatus: res.data.status?.privacyStatus,
        },
      };
    },
  },

  add_to_playlist: {
    description: 'Add a video to a playlist',
    inputSchema: z.object({
      playlistId: z.string().describe('Playlist ID'),
      videoId: z.string().describe('Video ID to add'),
      position: z.number().optional().describe('Position in playlist (0-based, omit for end)'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const snippet: any = {
        playlistId: args.playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId: args.videoId,
        },
      };

      if (args.position !== undefined) {
        snippet.position = args.position;
      }

      const res = await yt.playlistItems.insert({
        part: ['snippet'],
        requestBody: { snippet },
      });

      return {
        success: true,
        item: {
          id: res.data.id,
          videoId: args.videoId,
          playlistId: args.playlistId,
          position: res.data.snippet?.position,
        },
      };
    },
  },

  remove_from_playlist: {
    description: 'Remove a video from a playlist',
    inputSchema: z.object({
      playlistItemId: z.string().describe('Playlist item ID (from list_videos with playlistId)'),
      confirm: z.literal(true).describe('Set true to confirm removing this playlist item'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      await yt.playlistItems.delete({ id: args.playlistItemId });
      return { success: true, message: `Removed item ${args.playlistItemId} from playlist` };
    },
  },

  delete_playlist: {
    description: 'Delete a playlist (permanent)',
    inputSchema: z.object({
      playlistId: z.string().describe('Playlist ID to delete'),
      confirmTitle: z.string().min(1).describe('Exact current playlist title, required to confirm permanent deletion'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const current = await yt.playlists.list({ part: ['snippet'], id: [args.playlistId] });
      const title = current.data.items?.[0]?.snippet?.title;
      if (!title) throw new Error(`Playlist not found: ${args.playlistId}`);
      if (args.confirmTitle !== title) {
        throw new Error('Deletion stopped. Fetch the playlist and retry using its exact current title as confirmTitle.');
      }
      await yt.playlists.delete({ id: args.playlistId });
      return { success: true, message: `Playlist ${args.playlistId} deleted` };
    },
  },
};
