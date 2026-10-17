import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MEDIA_EXTENSIONS = new Set([
  '.3gp', '.avi', '.flv', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg',
  '.ogv', '.ts', '.webm', '.wmv', '.mxf',
]);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  duration?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
    size?: string;
    bit_rate?: string;
    format_name?: string;
  };
};

type PreparedOutput = {
  finalPath: string;
  temporaryPath: string;
  overwrite: boolean;
};

function ffmpegBinary(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function timeoutValue(seconds: unknown): number {
  const value = seconds === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(seconds);
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeoutSeconds must be between 1 and ${MAX_TIMEOUT_SECONDS}.`);
  }
  return Math.floor(value * 1000);
}

function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute local file path.`);
  }
}

async function inputFile(inputPath: unknown, label: string): Promise<string> {
  assertAbsolutePath(inputPath, label);
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(inputPath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`${label} must point to an existing local file.`);
  }
  return resolvedPath;
}

function mediaOutputExtension(outputPath: string): string {
  const extension = path.extname(outputPath).toLowerCase();
  if (!extension || !MEDIA_EXTENSIONS.has(extension)) {
    throw new Error('outputPath must use a supported media extension (for example .mp4, .mov, .mkv, or .webm).');
  }
  return extension;
}

async function prepareOutput(
  outputPath: unknown,
  overwrite: unknown,
  forbiddenPaths: string[],
  allowedExtensions?: Set<string>,
): Promise<PreparedOutput> {
  assertAbsolutePath(outputPath, 'outputPath');
  if (typeof overwrite !== 'boolean') throw new Error('overwrite must be a boolean.');

  const requested = path.resolve(outputPath);
  const parent = path.dirname(requested);
  let realParent: string;
  try {
    realParent = await fs.realpath(parent);
    const parentStat = await fs.stat(realParent);
    if (!parentStat.isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('The output directory must already exist and be a directory. Choose an existing output directory.');
  }

  const finalPath = path.join(realParent, path.basename(requested));
  const extension = path.extname(finalPath).toLowerCase();
  if (!extension || (allowedExtensions && !allowedExtensions.has(extension))) {
    throw new Error(allowedExtensions
      ? `outputPath must end with one of: ${[...allowedExtensions].join(', ')}.`
      : 'outputPath must include a file extension.');
  }

  let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    existing = await fs.lstat(finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to inspect outputPath.');
    }
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('outputPath already exists and is not a regular file.');
    }
    if (!overwrite) throw new Error('outputPath already exists. Set overwrite: true to replace it.');
  }

  for (const forbiddenPath of forbiddenPaths) {
    if (path.resolve(forbiddenPath) === finalPath) {
      throw new Error('outputPath must not overwrite an input file.');
    }
  }

  return {
    finalPath,
    temporaryPath: path.join(
      realParent,
      `${path.basename(finalPath, path.extname(finalPath))}.mcp-${randomUUID()}${path.extname(finalPath)}`,
    ),
    overwrite,
  };
}

async function commitOutput(output: PreparedOutput): Promise<void> {
  if (output.overwrite) {
    await fs.rename(output.temporaryPath, output.finalPath);
    return;
  }
  // link() is atomic and fails if another process created the destination meanwhile.
  await fs.link(output.temporaryPath, output.finalPath);
  await fs.unlink(output.temporaryPath);
}

async function removeTemporaryOutput(output: PreparedOutput): Promise<void> {
  try {
    await fs.unlink(output.temporaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Preserve the original media-processing result; the path is a generated UUID sibling.
    }
  }
}

function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
  stdoutLimit = MAX_STDOUT_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      reject(new Error(binary === ffmpegBinary()
        ? 'Unable to start ffmpeg. Install FFmpeg or set FFMPEG_PATH to its executable.'
        : 'Unable to start ffprobe. Install FFmpeg or set FFPROBE_PATH to its executable.'));
      return;
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      child.kill('SIGKILL');
      reject(new Error('Unable to capture local media process output.'));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let stdoutTooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };

    stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) {
        stdoutTooLarge = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const bounded = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes);
      stderrChunks.push(bounded);
      stderrBytes += bounded.length;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        fail(binary === ffmpegBinary()
          ? 'FFmpeg was not found. Install FFmpeg or set FFMPEG_PATH to its executable.'
          : 'FFprobe was not found. Install FFmpeg or set FFPROBE_PATH to its executable.');
      } else {
        fail('Unable to start the local media process.');
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // stderr is intentionally captured only to a fixed bound; never return process diagnostics.
      void stderrChunks;
      if (timedOut) {
        reject(new Error('Media processing timed out. Increase timeoutSeconds or use a shorter input.'));
      } else if (stdoutTooLarge) {
        reject(new Error('Media probe output exceeded the safe response limit.'));
      } else if (code !== 0) {
        reject(new Error('Local media processing failed. Check that the input is valid and the selected codecs are supported.'));
      } else {
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
      }
    });
  });
}

async function probeJson(filePath: string, timeoutMs: number): Promise<ProbeResult> {
  const stdout = await runProcess(ffprobeBinary(), [
    '-v', 'error',
    '-show_entries',
    'format=duration,size,bit_rate,format_name:stream=codec_type,codec_name,width,height,sample_rate,channels,duration',
    '-of', 'json',
    filePath,
  ], timeoutMs);
  try {
    return JSON.parse(stdout) as ProbeResult;
  } catch {
    throw new Error('FFprobe returned invalid metadata for this file.');
  }
}

function mediaDuration(probe: ProbeResult): number | undefined {
  const value = Number(probe.format?.duration);
  if (Number.isFinite(value) && value > 0) return value;
  const streamDuration = (probe.streams ?? [])
    .map((stream) => Number(stream.duration))
    .find((duration) => Number.isFinite(duration) && duration > 0);
  return streamDuration;
}

function ffmpegArgs(options: string[]): string[] {
  return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-n', ...options];
}

async function processToOutput(
  output: PreparedOutput,
  options: string[],
  timeoutMs: number,
): Promise<void> {
  try {
    await runProcess(ffmpegBinary(), ffmpegArgs([...options, output.temporaryPath]), timeoutMs, 0);
    await commitOutput(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('outputPath was created by another process. Choose a different name or set overwrite: true.');
    }
    throw error;
  } finally {
    await removeTemporaryOutput(output);
  }
}

function escapeFilterPath(filePath: string): string {
  if (/[\r\n]/.test(filePath)) throw new Error('Subtitle paths cannot contain line breaks.');
  return filePath.replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

const outputOptions = {
  overwrite: z.boolean().default(false).describe('Replace an existing regular output file only when true'),
  timeoutSeconds: z.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional()
    .describe(`Maximum processing time in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS})`),
};

export const mediaTools = {
  probe_media: {
    description: 'Read compact metadata for a local media file using ffprobe. This does not modify the file.',
    inputSchema: z.object({
      inputPath: z.string().describe('Absolute path to a local media file'),
      timeoutSeconds: outputOptions.timeoutSeconds,
    }),
    handler: async (args: any) => {
      const source = await inputFile(args.inputPath, 'inputPath');
      const probe = await probeJson(source, timeoutValue(args.timeoutSeconds));
      return {
        format: probe.format?.format_name,
        durationSeconds: mediaDuration(probe),
        sizeBytes: probe.format?.size ? Number(probe.format.size) : undefined,
        bitRate: probe.format?.bit_rate ? Number(probe.format.bit_rate) : undefined,
        streams: (probe.streams ?? []).map((stream) => ({
          type: stream.codec_type,
          codec: stream.codec_name,
          width: stream.width,
          height: stream.height,
          sampleRate: stream.sample_rate ? Number(stream.sample_rate) : undefined,
          channels: stream.channels,
          durationSeconds: stream.duration ? Number(stream.duration) : undefined,
        })),
      };
    },
  },

  mux_audio: {
    description: 'Mix a local music/audio file under a local video. Optional sidechain ducking uses the video audio track as its trigger, not speech recognition.',
    inputSchema: z.object({
      videoPath: z.string().describe('Absolute path to a local video file'),
      audioPath: z.string().describe('Absolute path to a local music/audio file'),
      outputPath: z.string().describe('Absolute output path in an existing, user-selected directory'),
      musicVolume: z.number().min(0).max(2).default(0.2).describe('Music gain multiplier from 0 to 2'),
      duckMusic: z.boolean().default(false).describe('Compress music when the original video audio is active'),
      ...outputOptions,
    }),
    handler: async (args: any) => {
      const timeoutMs = timeoutValue(args.timeoutSeconds);
      const video = await inputFile(args.videoPath, 'videoPath');
      const audio = await inputFile(args.audioPath, 'audioPath');
      const output = await prepareOutput(args.outputPath, args.overwrite, [video, audio]);
      mediaOutputExtension(output.finalPath);
      const [videoProbe, audioProbe] = await Promise.all([
        probeJson(video, timeoutMs),
        probeJson(audio, timeoutMs),
      ]);
      const streams = videoProbe.streams ?? [];
      if (!streams.some((stream) => stream.codec_type === 'video')) {
        throw new Error('videoPath does not contain a video stream.');
      }
      if (!(audioProbe.streams ?? []).some((stream) => stream.codec_type === 'audio')) {
        throw new Error('audioPath does not contain an audio stream.');
      }
      const duration = mediaDuration(videoProbe);
      if (!duration) throw new Error('Could not determine the video duration.');

      let options: string[];
      if (streams.some((stream) => stream.codec_type === 'audio')) {
        if (args.duckMusic) {
          options = [
            '-i', video,
            '-i', audio,
            '-filter_complex',
            `[1:a:0]volume=${args.musicVolume}[music];[music][0:a:0]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked];[0:a:0][ducked]amix=inputs=2:duration=longest:dropout_transition=2[mix]`,
            '-map', '0:v:0',
            '-map', '[mix]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-t', String(duration),
          ];
        } else {
          options = [
            '-i', video,
            '-i', audio,
            '-filter_complex',
            `[1:a:0]volume=${args.musicVolume}[music];[0:a:0][music]amix=inputs=2:duration=longest:dropout_transition=2[mix]`,
            '-map', '0:v:0',
            '-map', '[mix]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-t', String(duration),
          ];
        }
      } else {
        options = [
          '-i', video,
          '-i', audio,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-af', `volume=${args.musicVolume}`,
          '-t', String(duration),
        ];
      }
      await processToOutput(output, options, timeoutMs);
      return {
        success: true,
        outputPath: output.finalPath,
        ducking: args.duckMusic && streams.some((stream) => stream.codec_type === 'audio')
          ? 'video-audio sidechain; not speech detection'
          : args.duckMusic ? 'unavailable (video has no audio track)' : 'off',
      };
    },
  },

  normalize_loudness: {
    description: 'Normalize local media audio loudness with FFmpeg loudnorm while copying video streams.',
    inputSchema: z.object({
      inputPath: z.string().describe('Absolute path to local media with audio'),
      outputPath: z.string().describe('Absolute output path in an existing, user-selected directory'),
      integratedLufs: z.number().min(-70).max(-5).default(-16).describe('Integrated loudness target in LUFS'),
      loudnessRange: z.number().min(1).max(20).default(11).describe('Target loudness range in LU'),
      truePeakDb: z.number().min(-9).max(0).default(-1.5).describe('Maximum true peak target in dBTP'),
      ...outputOptions,
    }),
    handler: async (args: any) => {
      const timeoutMs = timeoutValue(args.timeoutSeconds);
      const source = await inputFile(args.inputPath, 'inputPath');
      const output = await prepareOutput(args.outputPath, args.overwrite, [source]);
      mediaOutputExtension(output.finalPath);
      const probe = await probeJson(source, timeoutMs);
      if (!(probe.streams ?? []).some((stream) => stream.codec_type === 'audio')) {
        throw new Error('inputPath does not contain an audio stream.');
      }
      const filter = `loudnorm=I=${args.integratedLufs}:LRA=${args.loudnessRange}:TP=${args.truePeakDb}`;
      await processToOutput(output, [
        '-i', source,
        '-map', '0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-c:s', 'copy',
        '-af', filter,
      ], timeoutMs);
      return { success: true, outputPath: output.finalPath, targetLufs: args.integratedLufs };
    },
  },

  extract_thumbnail: {
    description: 'Extract one still image from a local video at a timestamp.',
    inputSchema: z.object({
      inputPath: z.string().describe('Absolute path to a local video file'),
      outputPath: z.string().describe('Absolute .jpg, .jpeg, .png, or .webp output path in an existing directory'),
      timestampSeconds: z.number().min(0).max(86400).default(1).describe('Timestamp in seconds'),
      ...outputOptions,
    }),
    handler: async (args: any) => {
      const timeoutMs = timeoutValue(args.timeoutSeconds);
      const source = await inputFile(args.inputPath, 'inputPath');
      const output = await prepareOutput(args.outputPath, args.overwrite, [source], IMAGE_EXTENSIONS);
      const probe = await probeJson(source, timeoutMs);
      if (!(probe.streams ?? []).some((stream) => stream.codec_type === 'video')) {
        throw new Error('inputPath does not contain a video stream.');
      }
      await processToOutput(output, [
        '-ss', String(args.timestampSeconds),
        '-i', source,
        '-map', '0:v:0',
        '-frames:v', '1',
        '-q:v', '2',
      ], timeoutMs);
      return { success: true, outputPath: output.finalPath, timestampSeconds: args.timestampSeconds };
    },
  },

  burn_subtitles: {
    description: 'Burn a local subtitle file into local video frames. Requires an FFmpeg build with the subtitles/libass filter.',
    inputSchema: z.object({
      inputPath: z.string().describe('Absolute path to a local video file'),
      subtitlesPath: z.string().describe('Absolute path to a local subtitle file such as .srt or .ass'),
      outputPath: z.string().describe('Absolute output path in an existing, user-selected directory'),
      ...outputOptions,
    }),
    handler: async (args: any) => {
      const timeoutMs = timeoutValue(args.timeoutSeconds);
      const source = await inputFile(args.inputPath, 'inputPath');
      const subtitles = await inputFile(args.subtitlesPath, 'subtitlesPath');
      const output = await prepareOutput(args.outputPath, args.overwrite, [source, subtitles]);
      mediaOutputExtension(output.finalPath);
      const probe = await probeJson(source, timeoutMs);
      if (!(probe.streams ?? []).some((stream) => stream.codec_type === 'video')) {
        throw new Error('inputPath does not contain a video stream.');
      }
      await processToOutput(output, [
        '-i', source,
        '-vf', `subtitles=filename='${escapeFilterPath(subtitles)}'`,
        '-map', '0',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'copy',
        '-c:s', 'copy',
      ], timeoutMs);
      return { success: true, outputPath: output.finalPath };
    },
  },

  trim_clip: {
    description: 'Trim a local video clip by start time and duration. Video/audio are re-encoded for frame-accurate seeking.',
    inputSchema: z.object({
      inputPath: z.string().describe('Absolute path to a local video file'),
      outputPath: z.string().describe('Absolute output path in an existing, user-selected directory'),
      startSeconds: z.number().min(0).max(86400).describe('Clip start timestamp in seconds'),
      durationSeconds: z.number().min(0.01).max(86400).describe('Clip duration in seconds'),
      ...outputOptions,
    }),
    handler: async (args: any) => {
      const timeoutMs = timeoutValue(args.timeoutSeconds);
      const source = await inputFile(args.inputPath, 'inputPath');
      const output = await prepareOutput(args.outputPath, args.overwrite, [source]);
      mediaOutputExtension(output.finalPath);
      const probe = await probeJson(source, timeoutMs);
      if (!(probe.streams ?? []).some((stream) => stream.codec_type === 'video')) {
        throw new Error('inputPath does not contain a video stream.');
      }
      await processToOutput(output, [
        '-i', source,
        '-ss', String(args.startSeconds),
        '-t', String(args.durationSeconds),
        '-map', '0:v:0',
        '-map', '0:a?',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-c:a', 'aac',
      ], timeoutMs);
      return {
        success: true,
        outputPath: output.finalPath,
        startSeconds: args.startSeconds,
        durationSeconds: args.durationSeconds,
      };
    },
  },
};
