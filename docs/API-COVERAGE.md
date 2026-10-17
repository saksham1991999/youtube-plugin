# API coverage and limitations

Tools are registered individually with Zod input schemas and MCP annotations. Names below omit the `youtube_` prefix. Account operations are named `accounts_*`.

## YouTube Data API v3

| Area | Covered operations |
|---|---|
| Channels | `get_channel`, `update_channel` (branding settings supported by `channels.update`) |
| Channel branding | `upload_channel_banner`, `set_channel_watermark`, `unset_channel_watermark`, `list_channel_sections`, `create_channel_section`, `update_channel_section`, `delete_channel_section` |
| Videos | `list_videos`, `get_video`, `update_video`, `upload_video`, `schedule_video`, `delete_video`, `rate_video`, `get_video_ratings`, `report_video_abuse`, `list_video_abuse_report_reasons`, `get_video_localizations`, `update_video_localizations` |
| Thumbnails | `set_thumbnail`, `set_thumbnail_from_file`, `extract_thumbnail` (local FFmpeg) |
| Playlists | `list_playlists`, `create_playlist`, `update_playlist`, `delete_playlist`, `add_to_playlist`, `remove_from_playlist`, `move_playlist_item` |
| Comments | `list_comments`, `list_comment_replies`, `reply_to_comment`, `add_top_level_comment`, `update_comment`, `delete_comment`, `moderate_comment` |
| Captions | `list_captions`, `list_caption_tracks`, `upload_caption_track`, `update_caption_track`, `download_caption_track`, `delete_caption_track` |
| Search and categories | `search_youtube`, `list_categories`, `list_i18n_languages`, `list_i18n_regions` |
| Channel activity and subscriptions | `list_channel_activities`, `list_subscriptions`, `subscribe_to_channel`, `unsubscribe_from_channel` |
| Memberships | `list_membership_levels`, `list_channel_members` (requires the opt-in sensitive scope and eligible channel) |
| Live | `list_live_broadcasts`, `create_or_update_live_broadcast`, `delete_live_broadcast`, `transition_live_broadcast`, `list_live_streams`, `create_or_update_live_stream`, `delete_live_stream`, `bind_live_broadcast`, `list_live_chat_messages`, `send_live_chat_message`, `delete_live_chat_message`, `insert_live_chat_ban`, `delete_live_chat_ban`, `list_live_chat_moderators`, `add_live_chat_moderator`, `remove_live_chat_moderator`, `list_super_chat_events` |

## YouTube Analytics and Reporting APIs

- `get_analytics`, `get_top_videos`, `get_channel_analytics`
- `get_video_audience_retention`, `get_traffic_source_report`, `get_audience_demographics_report`, `get_device_and_os_report`, `get_content_type_report`
- `list_reporting_report_types`, `create_reporting_job`, `list_reporting_jobs`, `delete_reporting_job`, `list_reporting_job_reports`

Reporting job CSV download is not implemented. Analytics data can be delayed or unavailable for some dimensions, videos, or channels. Monetary analytics require both the monetary OAuth scope and YouTube Partner Program eligibility.

## Local media processing

`probe_media`, `mux_audio`, `normalize_loudness`, `extract_thumbnail`, `burn_subtitles`, and `trim_clip` use local FFmpeg/FFprobe binaries. These tools do not call YouTube APIs. See [`MEDIA.md`](./MEDIA.md).

## Deliberate exclusions and limitations

- No public API feature adds tracks from the YouTube Audio Library or edits a video’s audio; local FFmpeg muxing is the supported workflow.
- No public API feature schedules a Premiere. `publishAt` schedules publication of a private upload/video, not a local process.
- No official YouTube Data API video download, arbitrary public-video transcript scraping, SponsorBlock, or most-replayed heatmap integration.
- `liveChatMessages.streamList`, `liveChatMessages.transition`, and live broadcast cuepoint/ad-break insertion are not currently exposed.
- `guideCategories.list` is omitted because the generated `googleapis` YouTube v3 client does not expose that resource; `videoCategories.list` is available as `list_categories`.
- YouTube Reporting API report-file downloads are not currently exposed.
- Channel metadata updates expose the common branding fields, not every field in the full channel resource.
- Membership operations require `youtube.channel-memberships.creator`; they fail early with a reauthorization hint if the token lacks it.
- Google API access, quota, channel ownership, monetization, and feature availability remain subject to YouTube eligibility and project policies.

## Quota estimate

`youtube_quota_status` tracks successful local tool invocations and estimates Data API units. It is process-local project configuration, not authoritative: it cannot observe other applications or all internal/retry requests. The API documentation lists separate daily call limits for `search.list` and `videos.insert`, with a shared daily unit quota for other Data API methods. Confirm live values in Google Cloud Console.
