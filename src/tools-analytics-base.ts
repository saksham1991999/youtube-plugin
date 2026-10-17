import { z } from 'zod';
import { getYoutubeService, getYoutubeAnalyticsService } from './auth.js';

export const analyticsBaseTools = {

  get_analytics: {
    description: 'Get YouTube channel analytics (views, watch time, subscribers, revenue). Requires YouTube Analytics scope.',
    inputSchema: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date (YYYY-MM-DD)'),
      metrics: z.array(z.string()).min(1).max(10).optional().default(['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments']).describe('Metrics to retrieve'),
      dimensions: z.array(z.string()).optional().describe('Dimensions for breakdown (e.g., ["day"], ["video"], ["country"])'),
      sort: z.string().optional().describe('Sort field (prefix with - for descending, e.g., "-views")'),
      maxResults: z.number().int().min(1).max(200).optional().default(25).describe('Max rows returned'),
    }).refine((args) => args.endDate >= args.startDate, {
      path: ['endDate'],
      message: 'endDate must be the same as or later than startDate.',
    }),
    handler: async (args: any) => {
      const analytics = await getYoutubeAnalyticsService();

      const params: any = {
        ids: 'channel==MINE',
        startDate: args.startDate,
        endDate: args.endDate,
        metrics: args.metrics.join(','),
        maxResults: args.maxResults,
      };

      if (args.dimensions?.length) params.dimensions = args.dimensions.join(',');
      if (args.sort) params.sort = args.sort;

      const res = await analytics.reports.query(params);

      return {
        columnHeaders: res.data.columnHeaders?.map((h: any) => ({
          name: h.name,
          type: h.columnType,
          dataType: h.dataType,
        })),
        rows: res.data.rows || [],
        kind: res.data.kind,
      };
    },
  },

  get_top_videos: {
    description: 'Get your top-performing videos by views, watch time, or other metrics',
    inputSchema: z.object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date (YYYY-MM-DD)'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date (YYYY-MM-DD)'),
      metric: z.enum(['views', 'estimatedMinutesWatched', 'likes', 'comments', 'subscribersGained']).optional().default('views').describe('Metric to rank by'),
      maxResults: z.number().int().min(1).max(200).optional().default(10).describe('Number of top videos'),
    }).refine((args) => args.endDate >= args.startDate, {
      path: ['endDate'],
      message: 'endDate must be the same as or later than startDate.',
    }),
    handler: async (args: any) => {
      const analytics = await getYoutubeAnalyticsService();

      const res = await analytics.reports.query({
        ids: 'channel==MINE',
        startDate: args.startDate,
        endDate: args.endDate,
        metrics: [...new Set([args.metric, 'views', 'estimatedMinutesWatched', 'likes', 'comments'])].join(','),
        dimensions: 'video',
        sort: `-${args.metric}`,
        maxResults: args.maxResults,
      });

      const videoIds = res.data.rows?.map((row: any) => row[0]) || [];
      const videoMap: Record<string, string> = {};

      if (videoIds.length > 0) {
        const yt = await getYoutubeService();
        const videos = await yt.videos.list({
          part: ['snippet'],
          id: videoIds,
        });
        videos.data.items?.forEach((v: any) => {
          videoMap[v.id!] = v.snippet?.title || 'Unknown';
        });
      }

      const metricNames = res.data.columnHeaders?.map((header: any) => header.name).slice(1) || [];
      return {
        rankedBy: args.metric,
        period: `${args.startDate} to ${args.endDate}`,
        videos: res.data.rows?.map((row: any) => ({
          videoId: row[0],
          title: videoMap[row[0]] || row[0],
          metrics: Object.fromEntries(metricNames.map((name: string, index: number) => [name, row[index + 1]])),
        })) || [],
      };
    },
  },
};
