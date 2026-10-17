/**
 * YouTube MCP Tools
 *
 * 22 actions for full YouTube channel management via the YouTube Data API v3
 * and YouTube Analytics API v2.
 */
import { channelBaseTools } from './tools-channel-base.js';
import { videosBaseTools } from './tools-videos-base.js';
import { playlistsBaseTools } from './tools-playlists-base.js';
import { commentsBaseTools } from './tools-comments-base.js';
import { searchBaseTools } from './tools-search-base.js';
import { analyticsBaseTools } from './tools-analytics-base.js';
import { miscBaseTools } from './tools-misc-base.js';

export const youtubeTools = {
  ...channelBaseTools,
  ...videosBaseTools,
  ...playlistsBaseTools,
  ...commentsBaseTools,
  ...searchBaseTools,
  ...analyticsBaseTools,
  ...miscBaseTools,
};
