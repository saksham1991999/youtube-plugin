import { z } from 'zod';
import { getYoutubeService } from './auth.js';

export const miscBaseTools = {

  list_captions: {
    description: 'List available captions/subtitles for a video',
    inputSchema: z.object({
      videoId: z.string().describe('YouTube video ID'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const res = await yt.captions.list({
        part: ['snippet'],
        videoId: args.videoId,
      });

      return {
        captions: res.data.items?.map((cap: any) => ({
          id: cap.id,
          language: cap.snippet?.language,
          name: cap.snippet?.name,
          audioTrackType: cap.snippet?.audioTrackType,
          isAutoSynced: cap.snippet?.isAutoSynced,
          isCC: cap.snippet?.isCC,
          isDraft: cap.snippet?.isDraft,
          lastUpdated: cap.snippet?.lastUpdated,
          trackKind: cap.snippet?.trackKind,
        })) || [],
      };
    },
  },

  // ==========================================
  // VIDEO CATEGORIES
  // ==========================================

  list_categories: {
    description: 'List available YouTube video categories for a region',
    inputSchema: z.object({
      regionCode: z.string().optional().default('US').describe('Region code (e.g., "US", "GB", "DE")'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const res = await yt.videoCategories.list({
        part: ['snippet'],
        regionCode: args.regionCode,
      });

      return {
        categories: res.data.items?.map((cat: any) => ({
          id: cat.id,
          title: cat.snippet?.title,
          assignable: cat.snippet?.assignable,
        })).filter((cat: any) => cat.assignable) || [],
      };
    },
  },
};
