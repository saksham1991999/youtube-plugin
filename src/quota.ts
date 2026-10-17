import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDirectory } from './accounts.js';

export interface QuotaRecord {
  dayPacific: string;
  estimatedUnits: number;
  searchCalls: number;
  uploadCalls: number;
  byTool: Record<string, { calls: number; estimatedUnits: number }>;
}

const quotaCost: Record<string, number> = {
  accounts_list: 0,
  accounts_status: 0,
  accounts_begin_auth: 0,
  accounts_complete_auth: 0,
  accounts_set_default: 0,
  accounts_remove: 0,
  quota_status: 0,
  doctor: 0,
  search_youtube: 0,
  upload_video: 0,
  get_channel: 1,
  update_channel: 50,
  list_videos: 1,
  get_video: 1,
  update_video: 50,
  delete_video: 50,
  set_thumbnail: 50,
  set_thumbnail_from_file: 50,
  list_playlists: 1,
  create_playlist: 50,
  update_playlist: 50,
  add_to_playlist: 50,
  remove_from_playlist: 50,
  delete_playlist: 50,
  list_comments: 1,
  reply_to_comment: 50,
  delete_comment: 50,
  get_analytics: 0,
  get_top_videos: 1,
  list_captions: 50,
  list_categories: 1,
  schedule_video: 51,
  list_caption_tracks: 50,
  upload_caption_track: 400,
  update_caption_track: 450,
  download_caption_track: 200,
  delete_caption_track: 50,
  moderate_comment: 50,
  list_comment_replies: 1,
  update_comment: 51,
  add_top_level_comment: 50,
  move_playlist_item: 51,
  upload_channel_banner: 100,
  set_channel_watermark: 50,
  unset_channel_watermark: 50,
  list_channel_sections: 1,
  create_channel_section: 50,
  update_channel_section: 50,
  delete_channel_section: 50,
  list_live_chat_messages: 5,
  send_live_chat_message: 20,
  delete_live_chat_message: 20,
  insert_live_chat_ban: 200,
  delete_live_chat_ban: 200,
  list_live_broadcasts: 1,
  create_or_update_live_broadcast: 2,
  delete_live_broadcast: 1,
  transition_live_broadcast: 1,
  list_live_streams: 1,
  create_or_update_live_stream: 2,
  delete_live_stream: 1,
  bind_live_broadcast: 1,
  list_super_chat_events: 1,
  list_subscriptions: 1,
  subscribe_to_channel: 50,
  unsubscribe_from_channel: 50,
  list_channel_activities: 1,
  list_membership_levels: 1,
  list_channel_members: 1,
  list_i18n_languages: 1,
  list_i18n_regions: 1,
  get_video_ratings: 1,
  rate_video: 50,
  list_video_abuse_report_reasons: 1,
  report_video_abuse: 50,
  list_live_chat_moderators: 50,
  add_live_chat_moderator: 200,
  remove_live_chat_moderator: 200,
  probe_media: 0,
  mux_audio: 0,
  normalize_loudness: 0,
  extract_thumbnail: 0,
  burn_subtitles: 0,
  trim_clip: 0,
  get_channel_analytics: 0,
  get_video_audience_retention: 0,
  get_traffic_source_report: 0,
  get_audience_demographics_report: 0,
  get_device_and_os_report: 0,
  get_content_type_report: 0,
  get_video_localizations: 1,
  update_video_localizations: 51,
  list_reporting_report_types: 0,
  create_reporting_job: 0,
  list_reporting_jobs: 0,
  delete_reporting_job: 0,
  list_reporting_job_reports: 0,
};

function pacificDay(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function ledgerPath(): string {
  return path.join(getConfigDirectory(), 'quota-ledger.json');
}

function loadLedger(): QuotaRecord {
  try {
    const record = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8')) as QuotaRecord;
    if (record.dayPacific === pacificDay()) return record;
  } catch {
    // Initialize a fresh local estimate.
  }
  return { dayPacific: pacificDay(), estimatedUnits: 0, searchCalls: 0, uploadCalls: 0, byTool: {} };
}

function saveLedger(record: QuotaRecord): void {
  const directory = getConfigDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = ledgerPath();
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // Windows does not support POSIX mode bits.
  }
  fs.renameSync(temporary, target);
}

export function recordQuotaEstimate(toolName: string): void {
  const action = toolName.replace(/^youtube_/, '');
  const cost = quotaCost[action] ?? (action.includes('caption') ? 50 : 1);
  const ledger = loadLedger();
  ledger.estimatedUnits += cost;
  if (action === 'search_youtube') ledger.searchCalls += 1;
  if (action === 'upload_video') ledger.uploadCalls += 1;
  const previous = ledger.byTool[action] ?? { calls: 0, estimatedUnits: 0 };
  ledger.byTool[action] = { calls: previous.calls + 1, estimatedUnits: previous.estimatedUnits + cost };
  saveLedger(ledger);
}

export function getQuotaStatus(): QuotaRecord & {
    documentedLimits: { sharedDailyUnits: number; searchCalls: number; uploadCalls: number };
  warning: string;
} {
  return {
    ...loadLedger(),
    documentedLimits: { sharedDailyUnits: 10_000, searchCalls: 100, uploadCalls: 100 },
    warning: 'Local estimates can differ from actual API calls, retries, and project-wide use. Verify usage in Google Cloud Console.',
  };
}
