import { z } from 'zod';
import { getYoutubeAnalyticsService, getYoutubeReportingService } from './auth.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Date must be a real calendar date');

const analyticsPeriodFields = z.object({
  startDate: dateSchema,
  endDate: dateSchema,
});

const analyticsPeriodSchema = analyticsPeriodFields.refine(({ startDate, endDate }) => endDate >= startDate, {
  message: 'endDate must be on or after startDate',
  path: ['endDate'],
});

const maxResultsSchema = z.number().int().min(1).max(200).default(50)
  .describe('Maximum rows to return (1-200)');

const analyticsQuerySchema = analyticsPeriodFields.extend({
  metrics: z.array(z.string().trim().min(1).max(100)).min(1).max(10)
    .default(['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'subscribersLost', 'likes', 'comments'])
    .describe('YouTube Analytics API metric names'),
  dimensions: z.array(z.string().trim().min(1).max(100)).max(5).optional()
    .describe('Supported Analytics API dimensions, e.g. day, video, country'),
  filters: z.string().trim().min(1).max(500).optional()
    .describe('Analytics API filter expression, e.g. video==VIDEO_ID or country==US'),
  sort: z.string().trim().min(1).max(100).optional()
    .describe('Analytics API sort expression; prefix a metric with - for descending order'),
  maxResults: maxResultsSchema,
}).refine(({ startDate, endDate }) => endDate >= startDate, {
  message: 'endDate must be on or after startDate',
  path: ['endDate'],
});

function selectedAnalyticsResult(data: any, period?: { startDate: string; endDate: string }) {
  return {
    ...(period ? { period } : {}),
    columnHeaders: data.columnHeaders?.map((header: any) => ({
      name: header.name,
      type: header.columnType,
      dataType: header.dataType,
    })) ?? [],
    rows: data.rows ?? [],
  };
}

async function queryAnalytics(params: Record<string, unknown>, period?: { startDate: string; endDate: string }) {
  try {
    const analytics = await getYoutubeAnalyticsService();
    const result = await analytics.reports.query(params as any);
    return selectedAnalyticsResult(result.data, period);
  } catch (error) {
    throw analyticsError(error, params.metrics);
  }
}

function analyticsError(error: unknown, metrics: unknown): Error {
  const status = (error as any)?.response?.status ?? (error as any)?.code;
  if (status === 403 || status === '403') {
    const revenueRequested = typeof metrics === 'string' && /estimatedRevenue|estimatedAdRevenue|grossRevenue|adImpressions|monetizedPlaybacks/.test(metrics);
    const hint = revenueRequested
      ? ' Revenue reports require YouTube Analytics monetary scope and an eligible YouTube Partner Program channel; reconnect with OAuth scope https://www.googleapis.com/auth/yt-analytics-monetary.readonly and verify YPP access.'
      : ' Verify the YouTube Analytics read-only OAuth scope and that the account can access this channel.';
    return new Error(`YouTube Analytics returned 403.${hint}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function reportingError(error: unknown): Error {
  const status = (error as any)?.response?.status ?? (error as any)?.code;
  if (status === 403 || status === '403') {
    return new Error('YouTube Reporting API returned 403. Verify the YouTube Analytics read-only OAuth scope, channel access, and that the YouTube Reporting API is enabled in the Google Cloud project.');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function compactJob(job: any) {
  return {
    id: job.id,
    name: job.name,
    reportTypeId: job.reportTypeId,
    createTime: job.createTime,
    expireTime: job.expireTime,
    systemManaged: job.systemManaged,
  };
}

function compactReport(report: any) {
  return {
    id: report.id,
    jobId: report.jobId,
    startTime: report.startTime,
    endTime: report.endTime,
    createTime: report.createTime,
    jobExpireTime: report.jobExpireTime,
  };
}

export const analyticsTools = {
  get_channel_analytics: {
    description: 'Query channel metrics with the YouTube Analytics API. Revenue metrics require monetary scope and YPP eligibility; 403 errors include setup guidance.',
    inputSchema: analyticsQuerySchema,
    handler: async (args: any) => {
      const params: Record<string, unknown> = {
        ids: 'channel==MINE',
        startDate: args.startDate,
        endDate: args.endDate,
        metrics: args.metrics.join(','),
        maxResults: args.maxResults,
      };
      if (args.dimensions?.length) params.dimensions = args.dimensions.join(',');
      if (args.filters) params.filters = args.filters;
      if (args.sort) params.sort = args.sort;
      return queryAnalytics(params, { startDate: args.startDate, endDate: args.endDate });
    },
  },

  get_video_audience_retention: {
    description: 'Get official audience-retention metrics for one video, sampled by elapsed video percentage.',
    inputSchema: analyticsPeriodFields.extend({
      videoId: z.string().trim().min(1).max(128),
    }).refine(({ startDate, endDate }) => endDate >= startDate, {
      message: 'endDate must be on or after startDate',
      path: ['endDate'],
    }),
    handler: async ({ startDate, endDate, videoId }: any) => queryAnalytics({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      dimensions: 'elapsedVideoTimeRatio',
      filters: `video==${videoId}`,
    }, { startDate, endDate }),
  },

  get_traffic_source_report: {
    description: 'Break down channel views and watch time by official YouTube traffic source type.',
    inputSchema: analyticsPeriodSchema,
    handler: async ({ startDate, endDate }: any) => queryAnalytics({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'trafficSourceType',
      sort: '-views',
      maxResults: 200,
    }, { startDate, endDate }),
  },

  get_audience_demographics_report: {
    description: 'Get the supported age-group and gender breakdown. Demographic data is aggregated as viewerPercentage.',
    inputSchema: analyticsPeriodSchema,
    handler: async ({ startDate, endDate }: any) => queryAnalytics({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'viewerPercentage',
      dimensions: 'ageGroup,gender',
      maxResults: 200,
    }, { startDate, endDate }),
  },

  get_device_and_os_report: {
    description: 'Break down channel views and watch time by device type and operating system.',
    inputSchema: analyticsPeriodSchema,
    handler: async ({ startDate, endDate }: any) => queryAnalytics({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,estimatedMinutesWatched',
      dimensions: 'deviceType,operatingSystem',
      sort: '-views',
      maxResults: 200,
    }, { startDate, endDate }),
  },

  get_content_type_report: {
    description: 'Break down channel performance by creator content type, including SHORTS, LIVE_STREAM, STORY, and VIDEO_ON_DEMAND when available.',
    inputSchema: analyticsPeriodSchema,
    handler: async ({ startDate, endDate }: any) => queryAnalytics({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration',
      dimensions: 'creatorContentType',
      sort: '-views',
      maxResults: 200,
    }, { startDate, endDate }),
  },

  list_reporting_report_types: {
    description: 'List report types available through the official YouTube Reporting API.',
    inputSchema: z.object({
      includeSystemManaged: z.boolean().optional().default(false),
      pageSize: z.number().int().min(1).max(200).optional().default(50),
      pageToken: z.string().optional(),
    }),
    handler: async ({ includeSystemManaged, pageSize, pageToken }: any) => {
      try {
        const reporting = await getYoutubeReportingService();
        const result = await reporting.reportTypes.list({ includeSystemManaged, pageSize, pageToken });
        return {
          reportTypes: result.data.reportTypes?.map((type: any) => ({
            id: type.id,
            name: type.name,
            systemManaged: type.systemManaged,
            deprecateTime: type.deprecateTime,
          })) ?? [],
          nextPageToken: result.data.nextPageToken,
        };
      } catch (error) {
        throw reportingError(error);
      }
    },
  },

  create_reporting_job: {
    description: 'Create a recurring YouTube Reporting API job for a non-system-managed report type.',
    inputSchema: z.object({
      reportTypeId: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(100).optional(),
    }),
    handler: async ({ reportTypeId, name }: any) => {
      try {
        const reporting = await getYoutubeReportingService();
        const result = await reporting.jobs.create({ requestBody: { reportTypeId, ...(name ? { name } : {}) } });
        return { job: compactJob(result.data) };
      } catch (error) {
        throw reportingError(error);
      }
    },
  },

  list_reporting_jobs: {
    description: 'List YouTube Reporting API jobs. System-managed jobs are excluded unless requested.',
    inputSchema: z.object({
      includeSystemManaged: z.boolean().optional().default(false),
      pageSize: z.number().int().min(1).max(200).optional().default(50),
      pageToken: z.string().optional(),
    }),
    handler: async ({ includeSystemManaged, pageSize, pageToken }: any) => {
      try {
        const reporting = await getYoutubeReportingService();
        const result = await reporting.jobs.list({ includeSystemManaged, pageSize, pageToken });
        return {
          jobs: result.data.jobs?.map(compactJob) ?? [],
          nextPageToken: result.data.nextPageToken,
        };
      } catch (error) {
        throw reportingError(error);
      }
    },
  },

  delete_reporting_job: {
    description: 'Delete a user-created YouTube Reporting API job. This stops future report generation; repeat the job ID to confirm.',
    inputSchema: z.object({
      jobId: z.string().trim().min(1).max(100),
      confirmJobId: z.string().trim().min(1).max(100).describe('Must exactly match jobId'),
    }),
    handler: async ({ jobId, confirmJobId }: any) => {
      if (jobId !== confirmJobId) throw new Error('confirmJobId must exactly match jobId.');
      try {
        const reporting = await getYoutubeReportingService();
        await reporting.jobs.delete({ jobId });
        return { success: true, deletedJobId: jobId };
      } catch (error) {
        throw reportingError(error);
      }
    },
  },

  list_reporting_job_reports: {
    description: 'List metadata for reports generated by one YouTube Reporting API job. Report file downloads are not performed.',
    inputSchema: z.object({
      jobId: z.string().trim().min(1).max(100),
      pageSize: z.number().int().min(1).max(200).optional().default(50),
      pageToken: z.string().optional(),
      createdAfter: z.string().datetime({ offset: true }).optional()
        .describe('Only include reports created after this RFC3339 timestamp'),
    }),
    handler: async ({ jobId, pageSize, pageToken, createdAfter }: any) => {
      try {
        const reporting = await getYoutubeReportingService();
        const result = await reporting.jobs.reports.list({ jobId, pageSize, pageToken, createdAfter });
        return {
          reports: result.data.reports?.map(compactReport) ?? [],
          nextPageToken: result.data.nextPageToken,
        };
      } catch (error) {
        throw reportingError(error);
      }
    },
  },
};
