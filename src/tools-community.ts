import { z } from 'zod';
import { getYoutubeService, requireCurrentScope, MEMBERSHIPS_SCOPE } from './auth.js';

const resourceId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, {
  message: 'Use a valid YouTube resource ID.',
});
const pageToken = z.string().min(1).max(2048).optional();
const maxResults = (defaultValue: number, maximum: number) =>
  z.number().int().min(1).max(maximum).optional().default(defaultValue);
const languageCode = z.string().min(2).max(35).regex(/^[A-Za-z0-9-]+$/, {
  message: 'Use a valid language code.',
});
const regionCode = z.string().length(2).regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase());

function requireConfirmation(confirm: unknown, action: string): void {
  if (confirm !== true) throw new Error(`Not executed: set confirm to true to ${action}.`);
}

function thumbnailUrl(thumbnails: any): string | undefined {
  return thumbnails?.default?.url || thumbnails?.medium?.url || thumbnails?.high?.url || undefined;
}

/**
 * YouTube Data API community and discovery tools. Responses are allow-listed
 * summaries; membership methods require channel eligibility and the sensitive
 * youtube.channel-memberships.creator OAuth scope.
 */
export const communityTools = {
  list_subscriptions: {
    description: 'List subscriptions owned by the authenticated channel, or subscriptions for a specified channel where YouTube permits access. Returns compact channel summaries.',
    inputSchema: z.object({
      channelId: resourceId.optional().describe('Channel whose subscriptions to list; omit to list the authenticated channel subscriptions'),
      maxResults: maxResults(25, 50),
      pageToken,
      order: z.enum(['alphabetical', 'relevance', 'unread']).optional().default('relevance'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.subscriptions.list({
        part: ['snippet', 'contentDetails'],
        ...(args.channelId ? { channelId: args.channelId } : { mine: true }),
        maxResults: args.maxResults,
        pageToken: args.pageToken,
        order: args.order,
      });
      return {
        subscriptions: (response.data.items || []).map((item) => ({
          id: item.id,
          channelId: item.snippet?.resourceId?.channelId,
          title: item.snippet?.title,
          description: item.snippet?.description?.slice(0, 200),
          publishedAt: item.snippet?.publishedAt,
          thumbnailUrl: thumbnailUrl(item.snippet?.thumbnails),
          newItemCount: item.contentDetails?.newItemCount,
        })),
        totalResults: response.data.pageInfo?.totalResults,
        nextPageToken: response.data.nextPageToken,
      };
    },
  },

  subscribe_to_channel: {
    description: 'Subscribe the authenticated YouTube channel to another channel. This changes the external account; explicit confirmation is required.',
    inputSchema: z.object({
      channelId: resourceId.describe('Channel ID to subscribe to'),
      confirm: z.literal(true).describe('Set true to confirm creating this subscription'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `subscribe to channel ${args.channelId}`);
      const yt = await getYoutubeService();
      const response = await yt.subscriptions.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            resourceId: { kind: 'youtube#channel', channelId: args.channelId },
          },
        },
      });
      return {
        success: true,
        subscription: {
          id: response.data.id,
          channelId: response.data.snippet?.resourceId?.channelId,
          title: response.data.snippet?.title,
          publishedAt: response.data.snippet?.publishedAt,
        },
      };
    },
  },

  unsubscribe_from_channel: {
    description: 'Remove one of the authenticated channel subscriptions. This changes the external account; provide the subscription ID twice and confirm=true.',
    inputSchema: z.object({
      subscriptionId: resourceId.describe('Subscription resource ID, not the subscribed channel ID'),
      confirmationSubscriptionId: resourceId.describe('Repeat subscriptionId exactly to confirm which subscription will be removed'),
      confirm: z.literal(true).describe('Set true to confirm removing the subscription'),
    }).refine((args) => args.subscriptionId === args.confirmationSubscriptionId, {
      message: 'confirmationSubscriptionId must exactly match subscriptionId.',
    }),
    handler: async (args: any) => {
      if (args.subscriptionId !== args.confirmationSubscriptionId) {
        throw new Error('Unsubscribe stopped: confirmationSubscriptionId must exactly match subscriptionId.');
      }
      requireConfirmation(args.confirm, `remove subscription ${args.subscriptionId}`);
      const yt = await getYoutubeService();
      await yt.subscriptions.delete({ id: args.subscriptionId });
      return { success: true, deletedSubscriptionId: args.subscriptionId };
    },
  },

  list_channel_activities: {
    description: 'List recent activities for a channel, the authenticated channel, or the authenticated user home feed. Home-feed access depends on YouTube API availability.',
    inputSchema: z.object({
      source: z.enum(['channel', 'mine', 'home']).optional().default('mine'),
      channelId: resourceId.optional().describe('Required when source is channel'),
      regionCode: regionCode.optional(),
      publishedAfter: z.string().datetime({ offset: true }).optional(),
      publishedBefore: z.string().datetime({ offset: true }).optional(),
      maxResults: maxResults(25, 50),
      pageToken,
    }).superRefine((args, ctx) => {
      if (args.source === 'channel' && !args.channelId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channelId'], message: 'channelId is required when source is channel.' });
      }
      if (args.source !== 'channel' && args.channelId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['channelId'], message: 'channelId is only valid when source is channel.' });
      }
      if (args.publishedAfter && args.publishedBefore && Date.parse(args.publishedAfter) > Date.parse(args.publishedBefore)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['publishedBefore'], message: 'publishedBefore must be at or after publishedAfter.' });
      }
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.activities.list({
        part: ['snippet', 'contentDetails'],
        ...(args.source === 'channel' ? { channelId: args.channelId } : args.source === 'home' ? { home: true } : { mine: true }),
        ...(args.regionCode ? { regionCode: args.regionCode } : {}),
        ...(args.publishedAfter ? { publishedAfter: args.publishedAfter } : {}),
        ...(args.publishedBefore ? { publishedBefore: args.publishedBefore } : {}),
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      });
      return {
        activities: (response.data.items || []).map((item) => {
          const content = item.contentDetails;
          return {
            id: item.id,
            type: item.snippet?.type,
            channelId: item.snippet?.channelId,
            channelTitle: item.snippet?.channelTitle,
            title: item.snippet?.title,
            description: item.snippet?.description?.slice(0, 200),
            publishedAt: item.snippet?.publishedAt,
            videoId: content?.upload?.videoId || content?.like?.resourceId?.videoId
              || content?.favorite?.resourceId?.videoId || content?.comment?.resourceId?.videoId
              || content?.playlistItem?.resourceId?.videoId,
            relatedChannelId: content?.subscription?.resourceId?.channelId
              || content?.channelItem?.resourceId?.channelId,
            playlistId: content?.playlistItem?.resourceId?.playlistId,
          };
        }),
        totalResults: response.data.pageInfo?.totalResults,
        nextPageToken: response.data.nextPageToken,
      };
    },
  },

  list_membership_levels: {
    description: 'List channel membership pricing levels. Requires an eligible channel with memberships enabled and the sensitive youtube.channel-memberships.creator OAuth scope; this tool does not grant eligibility or add the scope.',
    inputSchema: z.object({}),
    handler: async () => {
      requireCurrentScope(MEMBERSHIPS_SCOPE, 'Listing channel membership levels');
      const yt = await getYoutubeService();
      const response = await yt.membershipsLevels.list({ part: ['id', 'snippet'] });
      return {
        levels: (response.data.items || []).map((item) => ({
          id: item.id,
          creatorChannelId: item.snippet?.creatorChannelId,
          displayName: item.snippet?.levelDetails?.displayName,
        })),
      };
    },
  },

  list_channel_members: {
    description: 'List channel members and membership metadata. Requires an eligible channel with memberships enabled and the sensitive youtube.channel-memberships.creator OAuth scope. Member information is sensitive; request only the minimum needed.',
    inputSchema: z.object({
      mode: z.enum(['all_current', 'updates']).optional().default('all_current'),
      hasAccessToLevel: resourceId.optional().describe('Filter to members with access to this membership level ID'),
      memberChannelIds: z.array(resourceId).max(50).optional().describe('Optional channel IDs to filter; maximum 50'),
      maxResults: maxResults(25, 100),
      pageToken,
    }),
    handler: async (args: any) => {
      requireCurrentScope(MEMBERSHIPS_SCOPE, 'Listing channel members');
      const yt = await getYoutubeService();
      const response = await yt.members.list({
        part: ['snippet'],
        mode: args.mode,
        hasAccessToLevel: args.hasAccessToLevel,
        filterByMemberChannelId: args.memberChannelIds?.join(','),
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      });
      return {
        members: (response.data.items || []).map((item) => ({
          channelId: item.snippet?.memberDetails?.channelId,
          displayName: item.snippet?.memberDetails?.displayName,
          profileImageUrl: item.snippet?.memberDetails?.profileImageUrl,
          creatorChannelId: item.snippet?.creatorChannelId,
          memberSince: item.snippet?.membershipsDetails?.membershipsDuration?.memberSince,
          memberTotalDurationMonths: item.snippet?.membershipsDetails?.membershipsDuration?.memberTotalDurationMonths,
          highestAccessibleLevel: item.snippet?.membershipsDetails?.highestAccessibleLevel,
          highestAccessibleLevelDisplayName: item.snippet?.membershipsDetails?.highestAccessibleLevelDisplayName,
          accessibleLevels: item.snippet?.membershipsDetails?.accessibleLevels,
        })),
        totalResults: response.data.pageInfo?.totalResults,
        nextPageToken: response.data.nextPageToken,
      };
    },
  },

  list_i18n_languages: {
    description: 'List YouTube UI languages and their localized display names.',
    inputSchema: z.object({
      hl: languageCode.optional().default('en').describe('Language used to localize language names'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.i18nLanguages.list({ part: ['snippet'], hl: args.hl });
      return {
        languages: (response.data.items || []).map((item) => ({
          code: item.id,
          name: item.snippet?.name,
          languageCode: item.snippet?.hl,
        })),
      };
    },
  },

  list_i18n_regions: {
    description: 'List regions where YouTube is available and localized region names.',
    inputSchema: z.object({
      hl: languageCode.optional().default('en').describe('Language used to localize region names'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.i18nRegions.list({ part: ['snippet'], hl: args.hl });
      return {
        regions: (response.data.items || []).map((item) => ({
          code: item.id,
          name: item.snippet?.name,
          regionCode: item.snippet?.gl,
        })),
      };
    },
  },

  get_video_ratings: {
    description: 'Get the authenticated account rating for up to 50 videos. Ratings are private to the authenticated account.',
    inputSchema: z.object({
      videoIds: z.array(resourceId).min(1).max(50).describe('One to 50 YouTube video IDs'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.videos.getRating({ id: args.videoIds });
      return {
        ratings: (response.data.items || []).map((item) => ({
          videoId: item.videoId,
          rating: item.rating,
        })),
      };
    },
  },

  rate_video: {
    description: 'Like, dislike, or clear the authenticated account rating for a video. This changes the external account; explicit confirmation is required.',
    inputSchema: z.object({
      videoId: resourceId,
      rating: z.enum(['like', 'dislike', 'none']),
      confirm: z.literal(true).describe('Set true to confirm changing this account rating'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `set rating "${args.rating}" for video ${args.videoId}`);
      const yt = await getYoutubeService();
      await yt.videos.rate({ id: args.videoId, rating: args.rating });
      return { success: true, videoId: args.videoId, rating: args.rating };
    },
  },

  list_video_abuse_report_reasons: {
    description: 'List valid primary and secondary reasons for reporting a YouTube video.',
    inputSchema: z.object({
      hl: languageCode.optional().default('en').describe('Language for reason labels'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.videoAbuseReportReasons.list({ part: ['snippet'], hl: args.hl });
      return {
        reasons: (response.data.items || []).map((item) => ({
          id: item.id,
          label: item.snippet?.label,
          secondaryReasons: (item.snippet?.secondaryReasons || []).map((reason) => ({
            id: reason.id,
            label: reason.label,
          })),
        })),
      };
    },
  },

  report_video_abuse: {
    description: 'Submit an abuse report for a YouTube video. Reporting is an external account action; confirm=true is mandatory. Use IDs returned by list_video_abuse_report_reasons.',
    inputSchema: z.object({
      videoId: resourceId,
      reasonId: resourceId.describe('Primary reason ID from list_video_abuse_report_reasons'),
      secondaryReasonId: resourceId.optional().describe('Optional secondary reason ID belonging to the selected primary reason'),
      comments: z.string().max(500).optional(),
      language: languageCode.optional().default('en'),
      confirm: z.literal(true).describe('Set true to submit this abuse report'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `report video ${args.videoId} for abuse`);
      const yt = await getYoutubeService();
      const reasons = await yt.videoAbuseReportReasons.list({ part: ['snippet'], hl: args.language });
      const primary = reasons.data.items?.find((item) => item.id === args.reasonId);
      if (!primary) throw new Error(`Unknown abuse reason ID: ${args.reasonId}. Fetch valid IDs with list_video_abuse_report_reasons.`);
      if (args.secondaryReasonId && !primary.snippet?.secondaryReasons?.some((reason) => reason.id === args.secondaryReasonId)) {
        throw new Error('secondaryReasonId is not a valid secondary reason for the selected primary reason.');
      }
      await yt.videos.reportAbuse({
        requestBody: {
          videoId: args.videoId,
          reasonId: args.reasonId,
          secondaryReasonId: args.secondaryReasonId,
          comments: args.comments,
          language: args.language,
        },
      });
      return { success: true, reportedVideoId: args.videoId, reasonId: args.reasonId };
    },
  },

  list_live_chat_moderators: {
    description: 'List moderators for an active live chat.',
    inputSchema: z.object({
      liveChatId: resourceId,
      maxResults: maxResults(25, 50),
      pageToken,
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const response = await yt.liveChatModerators.list({
        part: ['snippet'],
        liveChatId: args.liveChatId,
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      });
      return {
        moderators: (response.data.items || []).map((item) => ({
          id: item.id,
          liveChatId: item.snippet?.liveChatId,
          channelId: item.snippet?.moderatorDetails?.channelId,
          displayName: item.snippet?.moderatorDetails?.displayName,
          profileImageUrl: item.snippet?.moderatorDetails?.profileImageUrl,
        })),
        totalResults: response.data.pageInfo?.totalResults,
        nextPageToken: response.data.nextPageToken,
      };
    },
  },

  add_live_chat_moderator: {
    description: 'Add a channel as a moderator for a live chat. This changes live-chat permissions; explicit confirmation is required.',
    inputSchema: z.object({
      liveChatId: resourceId,
      channelId: resourceId.describe('Channel ID to grant moderator access'),
      confirm: z.literal(true).describe('Set true to grant this channel moderator permissions'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `add channel ${args.channelId} as a moderator`);
      const yt = await getYoutubeService();
      const response = await yt.liveChatModerators.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: args.liveChatId,
            moderatorDetails: { channelId: args.channelId },
          },
        },
      });
      return {
        success: true,
        moderator: {
          id: response.data.id,
          liveChatId: response.data.snippet?.liveChatId,
          channelId: response.data.snippet?.moderatorDetails?.channelId,
          displayName: response.data.snippet?.moderatorDetails?.displayName,
        },
      };
    },
  },

  remove_live_chat_moderator: {
    description: 'Remove a moderator from a live chat. This revokes permissions; provide the moderator ID twice and confirm=true.',
    inputSchema: z.object({
      moderatorId: resourceId.describe('Live-chat moderator resource ID'),
      confirmationModeratorId: resourceId.describe('Repeat moderatorId exactly to confirm removal'),
      confirm: z.literal(true).describe('Set true to revoke this moderator access'),
    }).refine((args) => args.moderatorId === args.confirmationModeratorId, {
      message: 'confirmationModeratorId must exactly match moderatorId.',
    }),
    handler: async (args: any) => {
      if (args.moderatorId !== args.confirmationModeratorId) {
        throw new Error('Moderator removal stopped: confirmationModeratorId must exactly match moderatorId.');
      }
      requireConfirmation(args.confirm, `remove moderator ${args.moderatorId}`);
      const yt = await getYoutubeService();
      await yt.liveChatModerators.delete({ id: args.moderatorId });
      return { success: true, removedModeratorId: args.moderatorId };
    },
  },
};
