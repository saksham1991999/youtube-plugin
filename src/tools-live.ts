import { z } from 'zod';
import { getYoutubeService } from './auth.js';

const isoDateTime = z.string().datetime({ offset: true }).describe('RFC 3339 date-time with a timezone offset');

function requireConfirmation(confirm: unknown, action: string): void {
  if (confirm !== true) {
    throw new Error(`Not executed: set confirm to true to ${action}.`);
  }
}

function apiError(error: unknown, action: string): Error {
  const candidate = error as {
    code?: number;
    message?: string;
    response?: {
      data?: {
        error?: {
          message?: string;
          errors?: Array<{ reason?: string; message?: string }>;
        };
      };
    };
  };
  const apiError = candidate?.response?.data?.error;
  const reason = apiError?.errors?.[0]?.reason;
  const message = apiError?.message || candidate?.message || 'Unknown YouTube API error';
  const code = candidate?.code ? ` (HTTP ${candidate.code})` : '';
  const reasonText = reason ? ` [${reason}]` : '';
  return new Error(`YouTube Live API failed to ${action}${code}${reasonText}: ${message}`);
}

async function liveCall<T>(action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw apiError(error, action);
  }
}

function broadcastSummary(item: {
  id?: string | null;
  snippet?: {
    title?: string | null;
    description?: string | null;
    scheduledStartTime?: string | null;
    scheduledEndTime?: string | null;
    actualStartTime?: string | null;
    actualEndTime?: string | null;
    liveChatId?: string | null;
  } | null;
  status?: {
    lifeCycleStatus?: string | null;
    privacyStatus?: string | null;
    recordingStatus?: string | null;
  } | null;
}) {
  return {
    id: item.id,
    title: item.snippet?.title,
    description: item.snippet?.description,
    scheduledStartTime: item.snippet?.scheduledStartTime,
    scheduledEndTime: item.snippet?.scheduledEndTime,
    actualStartTime: item.snippet?.actualStartTime,
    actualEndTime: item.snippet?.actualEndTime,
    lifecycleStatus: item.status?.lifeCycleStatus,
    privacyStatus: item.status?.privacyStatus,
    recordingStatus: item.status?.recordingStatus,
    liveChatId: item.snippet?.liveChatId,
  };
}

function streamSummary(item: {
  id?: string | null;
  snippet?: { title?: string | null; description?: string | null; isDefaultStream?: boolean | null } | null;
  status?: { streamStatus?: string | null; healthStatus?: { status?: string | null } | null } | null;
  cdn?: { format?: string | null; ingestionType?: string | null; resolution?: string | null; frameRate?: string | null } | null;
}) {
  // Do not include cdn.ingestionInfo: it contains the stream key and ingest URLs.
  return {
    id: item.id,
    title: item.snippet?.title,
    description: item.snippet?.description,
    isDefaultStream: item.snippet?.isDefaultStream,
    streamStatus: item.status?.streamStatus,
    healthStatus: item.status?.healthStatus?.status,
    format: item.cdn?.format,
    ingestionType: item.cdn?.ingestionType,
    resolution: item.cdn?.resolution,
    frameRate: item.cdn?.frameRate,
  };
}

const maxResults = (defaultValue: number, max: number) =>
  z.number().int().min(1).max(max).optional().default(defaultValue);

/**
 * YouTube Live Streaming API tools. Each handler returns compact, allow-listed
 * fields; ingestion credentials are intentionally omitted.
 */
export const liveTools = {
  list_live_broadcasts: {
    description: 'List your YouTube live broadcasts. Scheduled start time is an API event time, not a local scheduler.',
    inputSchema: z.object({
      status: z.enum(['all', 'active', 'completed', 'upcoming']).optional().default('all'),
      maxResults: maxResults(20, 50),
      pageToken: z.string().optional(),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const res = await liveCall('list live broadcasts', () => yt.liveBroadcasts.list({
        part: ['snippet', 'status', 'contentDetails'],
        mine: true,
        broadcastStatus: args.status,
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      }));
      return {
        broadcasts: (res.data.items || []).map(broadcastSummary),
        totalResults: res.data.pageInfo?.totalResults,
        nextPageToken: res.data.nextPageToken,
      };
    },
  },

  create_or_update_live_broadcast: {
    description: 'Create a broadcast or update its title, description, privacy, or API scheduled event times.',
    inputSchema: z.object({
      action: z.enum(['create', 'update']),
      broadcastId: z.string().min(1).optional().describe('Required for update'),
      title: z.string().min(1).max(100).optional(),
      description: z.string().max(5000).optional(),
      scheduledStartTime: isoDateTime.optional().describe('YouTube API event start time; does not schedule a local process'),
      scheduledEndTime: isoDateTime.optional(),
      privacyStatus: z.enum(['public', 'private', 'unlisted']).optional(),
    }).superRefine((args, ctx) => {
      if (args.action === 'create') {
        if (!args.title) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: 'Title is required for create' });
        if (!args.scheduledStartTime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduledStartTime'], message: 'Scheduled start time is required for create' });
      } else {
        if (!args.broadcastId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['broadcastId'], message: 'Broadcast ID is required for update' });
        if (![args.title, args.description, args.scheduledStartTime, args.scheduledEndTime, args.privacyStatus].some((value) => value !== undefined)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one field to update' });
        }
      }
      if (
        args.scheduledStartTime &&
        args.scheduledEndTime &&
        Date.parse(args.scheduledEndTime) <= Date.parse(args.scheduledStartTime)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scheduledEndTime'],
          message: 'Scheduled end time must be later than start time',
        });
      }
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      if (args.action === 'create') {
        const res = await liveCall('create live broadcast', () => yt.liveBroadcasts.insert({
          part: ['snippet', 'status', 'contentDetails'],
          requestBody: {
            snippet: {
              title: args.title,
              description: args.description,
              scheduledStartTime: args.scheduledStartTime,
              scheduledEndTime: args.scheduledEndTime,
            },
            status: { privacyStatus: args.privacyStatus || 'private' },
          },
        }));
        return { success: true, broadcast: broadcastSummary(res.data) };
      }

      const current = await liveCall('read live broadcast before update', () => yt.liveBroadcasts.list({
        part: ['snippet', 'status'],
        id: [args.broadcastId],
      }));
      const existing = current.data.items?.[0];
      if (!existing) throw new Error(`Live broadcast not found: ${args.broadcastId}`);
      const snippet = { ...existing.snippet };
      const status = { ...existing.status };
      if (args.title !== undefined) snippet.title = args.title;
      if (args.description !== undefined) snippet.description = args.description;
      if (args.scheduledStartTime !== undefined) snippet.scheduledStartTime = args.scheduledStartTime;
      if (args.scheduledEndTime !== undefined) snippet.scheduledEndTime = args.scheduledEndTime;
      if (args.privacyStatus !== undefined) status.privacyStatus = args.privacyStatus;
      const res = await liveCall('update live broadcast', () => yt.liveBroadcasts.update({
        part: ['snippet', 'status'],
        requestBody: { id: args.broadcastId, snippet, status },
      }));
      return { success: true, broadcast: broadcastSummary(res.data) };
    },
  },

  delete_live_broadcast: {
    description: 'Permanently delete a live broadcast. Requires explicit confirmation.',
    inputSchema: z.object({
      broadcastId: z.string().min(1),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to execute the delete'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `permanently delete broadcast ${args.broadcastId}`);
      const yt = await getYoutubeService();
      await liveCall('delete live broadcast', () => yt.liveBroadcasts.delete({ id: args.broadcastId }));
      return { success: true, deletedBroadcastId: args.broadcastId };
    },
  },

  transition_live_broadcast: {
    description: 'Transition a broadcast to testing, live, or complete. Completing a broadcast requires explicit confirmation.',
    inputSchema: z.object({
      broadcastId: z.string().min(1),
      broadcastStatus: z.enum(['testing', 'live', 'complete']),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to execute the lifecycle transition'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `transition broadcast ${args.broadcastId} to ${args.broadcastStatus}`);
      const yt = await getYoutubeService();
      const res = await liveCall('transition live broadcast', () => yt.liveBroadcasts.transition({
        id: args.broadcastId,
        broadcastStatus: args.broadcastStatus,
        part: ['snippet', 'status'],
      }));
      return { success: true, broadcast: broadcastSummary(res.data) };
    },
  },

  list_live_streams: {
    description: 'List live streams. Stream keys and ingestion URLs are never returned.',
    inputSchema: z.object({
      maxResults: maxResults(20, 50),
      pageToken: z.string().optional(),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const res = await liveCall('list live streams', () => yt.liveStreams.list({
        part: ['snippet', 'cdn', 'status'],
        mine: true,
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      }));
      return {
        streams: (res.data.items || []).map(streamSummary),
        totalResults: res.data.pageInfo?.totalResults,
        nextPageToken: res.data.nextPageToken,
      };
    },
  },

  create_or_update_live_stream: {
    description: 'Create a live stream or update its title and description. Stream keys are not returned.',
    inputSchema: z.object({
      action: z.enum(['create', 'update']),
      streamId: z.string().min(1).optional().describe('Required for update'),
      title: z.string().min(1).max(100).optional(),
      description: z.string().max(5000).optional(),
      ingestionType: z.enum(['rtmp', 'dash', 'hls']).optional().describe('Required for create'),
      resolution: z.enum(['240p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'variable']).optional(),
      frameRate: z.enum(['30fps', '60fps', 'variable']).optional(),
    }).superRefine((args, ctx) => {
      if (args.action === 'create') {
        if (!args.title) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['title'], message: 'Title is required for create' });
        if (!args.ingestionType) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ingestionType'], message: 'Ingestion type is required for create' });
      } else {
        if (!args.streamId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['streamId'], message: 'Stream ID is required for update' });
        if (args.title === undefined && args.description === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide title or description to update' });
        }
      }
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      if (args.action === 'create') {
        const res = await liveCall('create live stream', () => yt.liveStreams.insert({
          part: ['snippet', 'cdn'],
          requestBody: {
            snippet: { title: args.title, description: args.description },
            cdn: {
              ingestionType: args.ingestionType,
              resolution: args.resolution || '1080p',
              frameRate: args.frameRate || '30fps',
            },
          },
        }));
        return { success: true, stream: streamSummary(res.data) };
      }

      const current = await liveCall('read live stream before update', () => yt.liveStreams.list({
        part: ['snippet', 'cdn', 'status'],
        id: [args.streamId],
      }));
      const existing = current.data.items?.[0];
      if (!existing) throw new Error(`Live stream not found: ${args.streamId}`);
      const snippet = { ...existing.snippet };
      if (args.title !== undefined) snippet.title = args.title;
      if (args.description !== undefined) snippet.description = args.description;
      const res = await liveCall('update live stream', () => yt.liveStreams.update({
        part: ['snippet'],
        requestBody: { id: args.streamId, snippet },
      }));
      return { success: true, stream: streamSummary(res.data) };
    },
  },

  delete_live_stream: {
    description: 'Permanently delete a live stream. Requires explicit confirmation.',
    inputSchema: z.object({
      streamId: z.string().min(1),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to execute the delete'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `permanently delete stream ${args.streamId}`);
      const yt = await getYoutubeService();
      await liveCall('delete live stream', () => yt.liveStreams.delete({ id: args.streamId }));
      return { success: true, deletedStreamId: args.streamId };
    },
  },

  bind_live_broadcast: {
    description: 'Bind a broadcast to a stream or unbind its stream. Unbinding requires explicit confirmation.',
    inputSchema: z.object({
      action: z.enum(['bind', 'unbind']),
      broadcastId: z.string().min(1),
      streamId: z.string().min(1).optional().describe('Required for bind'),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to unbind'),
    }).superRefine((args, ctx) => {
      if (args.action === 'bind' && !args.streamId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['streamId'], message: 'Stream ID is required for bind' });
      }
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      if (args.action === 'unbind') {
        requireConfirmation(args.confirm, `unbind stream from broadcast ${args.broadcastId}`);
        await liveCall('unbind live broadcast', () => yt.liveBroadcasts.bind({
          id: args.broadcastId,
          part: ['id', 'snippet', 'contentDetails'],
        }));
        return { success: true, broadcastId: args.broadcastId, streamId: null };
      }
      const res = await liveCall('bind live broadcast', () => yt.liveBroadcasts.bind({
        id: args.broadcastId,
        streamId: args.streamId,
        part: ['id', 'snippet', 'contentDetails'],
      }));
      return {
        success: true,
        broadcastId: res.data.id,
        streamId: res.data.contentDetails?.boundStreamId,
        liveChatId: res.data.snippet?.liveChatId,
      };
    },
  },

  list_live_chat_messages: {
    description: 'List messages in an active live chat.',
    inputSchema: z.object({
      liveChatId: z.string().min(1),
      maxResults: maxResults(50, 200),
      pageToken: z.string().optional(),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const res = await liveCall('list live chat messages', () => yt.liveChatMessages.list({
        part: ['snippet', 'authorDetails'],
        liveChatId: args.liveChatId,
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      }));
      return {
        messages: (res.data.items || []).map((item) => ({
          id: item.id,
          type: item.snippet?.type,
          text: item.snippet?.textMessageDetails?.messageText,
          publishedAt: item.snippet?.publishedAt,
          author: item.authorDetails?.displayName,
          authorChannelId: item.authorDetails?.channelId,
          isChatModerator: item.authorDetails?.isChatModerator,
          isChatOwner: item.authorDetails?.isChatOwner,
          isChatSponsor: item.authorDetails?.isChatSponsor,
        })),
        nextPageToken: res.data.nextPageToken,
        pollingIntervalMillis: res.data.pollingIntervalMillis,
      };
    },
  },

  send_live_chat_message: {
    description: 'Send a plain-text message to a live chat.',
    inputSchema: z.object({
      liveChatId: z.string().min(1),
      text: z.string().trim().min(1).max(200),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to publish this message'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `send a message to live chat ${args.liveChatId}`);
      const yt = await getYoutubeService();
      const res = await liveCall('send live chat message', () => yt.liveChatMessages.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: args.liveChatId,
            type: 'textMessageEvent',
            textMessageDetails: { messageText: args.text },
          },
        },
      }));
      return {
        success: true,
        message: {
          id: res.data.id,
          liveChatId: res.data.snippet?.liveChatId,
          text: res.data.snippet?.textMessageDetails?.messageText,
          publishedAt: res.data.snippet?.publishedAt,
        },
      };
    },
  },

  delete_live_chat_message: {
    description: 'Delete a live chat message. Requires explicit confirmation.',
    inputSchema: z.object({
      messageId: z.string().min(1),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to execute the delete'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `delete live chat message ${args.messageId}`);
      const yt = await getYoutubeService();
      await liveCall('delete live chat message', () => yt.liveChatMessages.delete({ id: args.messageId }));
      return { success: true, deletedMessageId: args.messageId };
    },
  },

  insert_live_chat_ban: {
    description: 'Ban a channel from a live chat, temporarily or permanently.',
    inputSchema: z.object({
      liveChatId: z.string().min(1),
      channelId: z.string().min(1),
      type: z.enum(['temporary', 'permanent']),
      banDurationSeconds: z.number().int().min(1).max(31_536_000).optional().describe('Required for temporary bans; maximum one year'),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to execute the ban'),
    }).superRefine((args, ctx) => {
      if (args.type === 'temporary' && args.banDurationSeconds === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['banDurationSeconds'], message: 'Duration is required for a temporary ban' });
      }
      if (args.type === 'permanent' && args.banDurationSeconds !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['banDurationSeconds'], message: 'Do not provide a duration for a permanent ban' });
      }
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `ban channel ${args.channelId} from live chat ${args.liveChatId}`);
      const yt = await getYoutubeService();
      const res = await liveCall('insert live chat ban', () => yt.liveChatBans.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            liveChatId: args.liveChatId,
            type: args.type,
            bannedUserDetails: { channelId: args.channelId },
            banDurationSeconds: args.banDurationSeconds,
          },
        },
      }));
      return {
        success: true,
        ban: {
          id: res.data.id,
          liveChatId: res.data.snippet?.liveChatId,
          channelId: res.data.snippet?.bannedUserDetails?.channelId,
          type: res.data.snippet?.type,
          banDurationSeconds: res.data.snippet?.banDurationSeconds,
        },
      };
    },
  },

  delete_live_chat_ban: {
    description: 'Lift a live chat ban. Requires explicit confirmation.',
    inputSchema: z.object({
      banId: z.string().min(1),
      confirm: z.boolean().optional().default(false).describe('Must be exactly true to execute the delete'),
    }),
    handler: async (args: any) => {
      requireConfirmation(args.confirm, `delete live chat ban ${args.banId}`);
      const yt = await getYoutubeService();
      await liveCall('delete live chat ban', () => yt.liveChatBans.delete({ id: args.banId }));
      return { success: true, deletedBanId: args.banId };
    },
  },

  list_super_chat_events: {
    description: 'List Super Chat and Super Sticker events on your channel.',
    inputSchema: z.object({
      maxResults: maxResults(50, 50),
      pageToken: z.string().optional(),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      const res = await liveCall('list Super Chat events', () => yt.superChatEvents.list({
        part: ['snippet'],
        maxResults: args.maxResults,
        pageToken: args.pageToken,
      }));
      return {
        events: (res.data.items || []).map((item) => ({
          id: item.id,
          amountMicros: item.snippet?.amountMicros,
          currency: item.snippet?.currency,
          displayString: item.snippet?.displayString,
          commentText: item.snippet?.commentText,
          createdAt: item.snippet?.createdAt,
          isSuperStickerEvent: item.snippet?.isSuperStickerEvent,
          messageType: item.snippet?.messageType,
          supporter: item.snippet?.supporterDetails?.displayName,
          supporterChannelId: item.snippet?.supporterDetails?.channelId,
        })),
        nextPageToken: res.data.nextPageToken,
      };
    },
  },
};
