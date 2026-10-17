import { z } from 'zod';
import { getYoutubeService } from './auth.js';

export const searchBaseTools = {

  search_youtube: {
    description: 'Search YouTube for videos, channels, or playlists',
    inputSchema: z.object({
      query: z.string().describe('Search query'),
      type: z.enum(['video', 'channel', 'playlist']).optional().default('video').describe('Type of result'),
      maxResults: z.number().int().min(1).max(50).optional().default(10).describe('Number of results (max 50)'),
      order: z.enum(['date', 'rating', 'relevance', 'title', 'viewCount']).optional().default('relevance').describe('Sort order'),
      channelId: z.string().optional().describe('Restrict search to this channel'),
      publishedAfter: z.string().optional().describe('ISO 8601 date (e.g., "2024-01-01T00:00:00Z")'),
      publishedBefore: z.string().optional().describe('ISO 8601 date'),
      pageToken: z.string().optional().describe('Page token for pagination'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const params: any = {
        part: ['snippet'],
        q: args.query,
        type: [args.type],
        maxResults: Math.min(args.maxResults, 50),
        order: args.order,
        pageToken: args.pageToken,
      };

      if (args.channelId) params.channelId = args.channelId;
      if (args.publishedAfter) params.publishedAfter = args.publishedAfter;
      if (args.publishedBefore) params.publishedBefore = args.publishedBefore;

      const res = await yt.search.list(params);

      return {
        results: res.data.items?.map((item: any) => ({
          id: item.id?.videoId || item.id?.channelId || item.id?.playlistId,
          kind: item.id?.kind,
          title: item.snippet?.title,
          description: item.snippet?.description,
          channelTitle: item.snippet?.channelTitle,
          publishedAt: item.snippet?.publishedAt,
          thumbnails: item.snippet?.thumbnails,
        })) || [],
        totalResults: res.data.pageInfo?.totalResults,
        nextPageToken: res.data.nextPageToken,
      };
    },
  },
};
