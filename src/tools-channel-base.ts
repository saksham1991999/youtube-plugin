import { z } from 'zod';
import { getYoutubeService } from './auth.js';

export const channelBaseTools = {

  get_channel: {
    description: 'Get your YouTube channel info (name, description, subscriber count, video count, branding)',
    inputSchema: z.object({
      channelId: z.string().optional().describe('Channel ID (omit for your own channel)'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const params: any = {
        part: ['snippet', 'statistics', 'brandingSettings', 'contentDetails'],
      };

      if (args.channelId) {
        params.id = [args.channelId];
      } else {
        params.mine = true;
      }

      const res = await yt.channels.list(params);
      const channel = res.data.items?.[0];

      if (!channel) {
        throw new Error('Channel not found. Make sure you have a YouTube channel linked to this Google account.');
      }

      return {
        id: channel.id,
        title: channel.snippet?.title,
        description: channel.snippet?.description,
        customUrl: channel.snippet?.customUrl,
        publishedAt: channel.snippet?.publishedAt,
        country: channel.snippet?.country,
        thumbnails: channel.snippet?.thumbnails,
        statistics: {
          viewCount: channel.statistics?.viewCount,
          subscriberCount: channel.statistics?.subscriberCount,
          videoCount: channel.statistics?.videoCount,
          hiddenSubscriberCount: channel.statistics?.hiddenSubscriberCount,
        },
        branding: {
          title: channel.brandingSettings?.channel?.title,
          description: channel.brandingSettings?.channel?.description,
          keywords: channel.brandingSettings?.channel?.keywords,
          defaultLanguage: channel.brandingSettings?.channel?.defaultLanguage,
          country: channel.brandingSettings?.channel?.country,
          unsubscribedTrailer: channel.brandingSettings?.channel?.unsubscribedTrailer,
        },
        uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads,
      };
    },
  },

  update_channel: {
    description: 'Update your YouTube channel description, keywords, default language, country, or trailer video',
    inputSchema: z.object({
      description: z.string().optional().describe('New channel description'),
      keywords: z.string().optional().describe('Channel keywords (space-separated)'),
      defaultLanguage: z.string().optional().describe('Default language (e.g., "en")'),
      country: z.string().optional().describe('Country code (e.g., "US")'),
      unsubscribedTrailer: z.string().optional().describe('Video ID to show as channel trailer for non-subscribers'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const current = await yt.channels.list({
        part: ['brandingSettings'],
        mine: true,
      });

      const channel = current.data.items?.[0];
      if (!channel) throw new Error('No channel found for this account');

      const branding = channel.brandingSettings || {};
      const channelSettings = branding.channel || {};

      if (args.description !== undefined) channelSettings.description = args.description;
      if (args.keywords !== undefined) channelSettings.keywords = args.keywords;
      if (args.defaultLanguage !== undefined) channelSettings.defaultLanguage = args.defaultLanguage;
      if (args.country !== undefined) channelSettings.country = args.country;
      if (args.unsubscribedTrailer !== undefined) channelSettings.unsubscribedTrailer = args.unsubscribedTrailer;

      branding.channel = channelSettings;

      const res = await yt.channels.update({
        part: ['brandingSettings'],
        requestBody: {
          id: channel.id,
          brandingSettings: branding,
        },
      });

      return {
        success: true,
        channelId: res.data.id,
        updated: {
          description: res.data.brandingSettings?.channel?.description,
          keywords: res.data.brandingSettings?.channel?.keywords,
          defaultLanguage: res.data.brandingSettings?.channel?.defaultLanguage,
          country: res.data.brandingSettings?.channel?.country,
        },
      };
    },
  },
};
