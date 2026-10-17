import { z } from 'zod';
import { getYoutubeService } from './auth.js';

const languageCode = z.string().trim().min(2).max(35).regex(/^[A-Za-z0-9-]+$/);

export const localizationTools = {
  get_video_localizations: {
    description: 'Read localized titles and descriptions for a video.',
    inputSchema: z.object({
      videoId: z.string().trim().min(1).max(128),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.videos.list({
        part: ['localizations'],
        id: [args.videoId],
      });
      const video = response.data.items?.[0];
      if (!video) throw new Error(`Video not found: ${args.videoId}`);
      return {
        videoId: video.id,
        localizations: Object.fromEntries(
          Object.entries(video.localizations || {}).map(([language, value]) => [
            language,
            { title: value?.title, description: value?.description?.slice(0, 1000) },
          ]),
        ),
      };
    },
  },

  update_video_localizations: {
    description: 'Add or replace localized video titles/descriptions while preserving existing language entries.',
    inputSchema: z.object({
      videoId: z.string().trim().min(1).max(128),
      localizations: z.array(z.object({
        language: languageCode.describe('Language/locale tag, for example en or pt-BR'),
        title: z.string().min(1).max(100),
        description: z.string().max(5000).optional(),
      })).min(1).max(50),
      removeLanguages: z.array(languageCode).max(50).optional()
        .describe('Optional languages to remove; requires confirm=true'),
      confirm: z.boolean().optional().default(false)
        .describe('Must be true when removeLanguages is non-empty'),
    }),
    handler: async (args: any) => {
      if (args.removeLanguages?.length && args.confirm !== true) {
        throw new Error('Not executed: set confirm=true to remove localized metadata.');
      }
      const yt = await getYoutubeService();
      const current = await yt.videos.list({
        part: ['localizations'],
        id: [args.videoId],
      });
      const video = current.data.items?.[0];
      if (!video) throw new Error(`Video not found: ${args.videoId}`);

      const localizations: Record<string, { title?: string | null; description?: string | null }> = {
        ...(video.localizations || {}),
      };
      for (const item of args.localizations) {
        localizations[item.language] = { title: item.title, description: item.description };
      }
      for (const language of args.removeLanguages || []) delete localizations[language];

      const updated = await yt.videos.update({
        part: ['localizations'],
        requestBody: { id: args.videoId, localizations },
      });
      return {
        success: true,
        videoId: updated.data.id,
        languages: Object.keys(updated.data.localizations || {}),
        removedLanguages: args.removeLanguages || [],
      };
    },
  },
};
