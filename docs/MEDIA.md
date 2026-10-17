# Local media tools

The media tools are local FFmpeg wrappers, not YouTube API calls. They process files selected by the caller and return paths/metadata for later use with upload and thumbnail tools.

| Tool | Purpose |
|---|---|
| `youtube_probe_media` | Inspect media streams and format metadata with FFprobe |
| `youtube_mux_audio` | Mix local audio/music under a video |
| `youtube_normalize_loudness` | Normalize audio loudness |
| `youtube_extract_thumbnail` | Extract a still frame at a timestamp |
| `youtube_burn_subtitles` | Burn a local subtitle file into a video |
| `youtube_trim_clip` | Trim a local video clip |

## Requirements

Install FFmpeg and FFprobe, or set their executable paths:

```bash
FFMPEG_PATH=/path/to/ffmpeg
FFPROBE_PATH=/path/to/ffprobe
```

Subtitle burn-in requires an FFmpeg build with libass support. Verify with `ffmpeg -filters | grep subtitles`.

## Safety behavior

- Inputs and outputs must be absolute local paths.
- Input files must exist. Output directories must already exist.
- The server invokes FFmpeg with `spawn` and an argument array, not a shell command.
- Existing outputs are not replaced unless `overwrite: true` is explicit.
- Output paths cannot equal input paths. Symlink and non-regular output targets are rejected.
- Processing time and probe-output sizes are capped.
- Error responses omit raw FFmpeg stderr.

`youtube_mux_audio` can optionally sidechain-compress the music bed using the source video's audio as a trigger. This is not speech detection. If the source video has no audio stream, ducking is unavailable.

## Typical workflow

1. Run `youtube_probe_media` on the source.
2. Run `youtube_mux_audio` or `youtube_normalize_loudness` to create a new output file.
3. Optionally run `youtube_burn_subtitles` or `youtube_trim_clip`.
4. Upload the final output with `youtube_upload_video`.
5. Extract a frame with `youtube_extract_thumbnail`, then set it using `youtube_set_thumbnail_from_file`.

You are responsible for rights to the video, music, and subtitle assets. The YouTube Audio Library has no public API for selecting or embedding tracks. The server does not download videos or fetch remote media URLs.
