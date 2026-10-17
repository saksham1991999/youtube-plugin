import { z } from 'zod';
import { getYoutubeService } from './auth.js';

export const commentsBaseTools = {

  list_comments: {
    description: 'List comments on a video (top-level comment threads)',
    inputSchema: z.object({
      videoId: z.string().describe('YouTube video ID'),
      maxResults: z.number().int().min(1).max(100).optional().default(20).describe('Number of comments (max 100)'),
      order: z.enum(['time', 'relevance']).optional().default('time').describe('Sort order'),
      pageToken: z.string().optional().describe('Page token for pagination'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const res = await yt.commentThreads.list({
        part: ['snippet', 'replies'],
        videoId: args.videoId,
        maxResults: Math.min(args.maxResults, 100),
        order: args.order,
        pageToken: args.pageToken,
      });

      return {
        comments: res.data.items?.map((thread: any) => {
          const top = thread.snippet?.topLevelComment?.snippet;
          return {
            threadId: thread.id,
            commentId: thread.snippet?.topLevelComment?.id,
            author: top?.authorDisplayName,
            authorChannelId: top?.authorChannelId?.value,
            text: top?.textDisplay,
            likeCount: top?.likeCount,
            publishedAt: top?.publishedAt,
            updatedAt: top?.updatedAt,
            replyCount: thread.snippet?.totalReplyCount,
            replies: thread.replies?.comments?.map((reply: any) => ({
              commentId: reply.id,
              author: reply.snippet?.authorDisplayName,
              text: reply.snippet?.textDisplay,
              likeCount: reply.snippet?.likeCount,
              publishedAt: reply.snippet?.publishedAt,
            })),
          };
        }) || [],
        totalResults: res.data.pageInfo?.totalResults,
        nextPageToken: res.data.nextPageToken,
      };
    },
  },

  reply_to_comment: {
    description: 'Reply to a comment on a video',
    inputSchema: z.object({
      parentId: z.string().describe('Comment ID to reply to (the commentId from list_comments)'),
      text: z.string().describe('Reply text'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();

      const res = await yt.comments.insert({
        part: ['snippet'],
        requestBody: {
          snippet: {
            parentId: args.parentId,
            textOriginal: args.text,
          },
        },
      });

      return {
        success: true,
        comment: {
          id: res.data.id,
          text: res.data.snippet?.textDisplay,
          publishedAt: res.data.snippet?.publishedAt,
        },
      };
    },
  },

  delete_comment: {
    description: 'Delete a comment you own',
    inputSchema: z.object({
      commentId: z.string().describe('Comment ID to delete'),
      confirm: z.literal(true).describe('Set true to confirm permanent comment deletion'),
    }),
    handler: async (args: any) => {
      const yt = await getYoutubeService();
      await yt.comments.delete({ id: args.commentId });
      return { success: true, message: `Comment ${args.commentId} deleted` };
    },
  },
};
