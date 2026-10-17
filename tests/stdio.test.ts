import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('stdio MCP contract', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let configDirectory: string;

  beforeAll(async () => {
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-plugin-stdio-'));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/index.js')],
      cwd: process.cwd(),
      env: { ...process.env, YOUTUBE_PLUGIN_TOOLSET: 'full', YOUTUBE_PLUGIN_CONFIG_DIR: configDirectory },
      stderr: 'pipe',
    });
    client = new Client({ name: 'youtube-plugin-contract-test', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    if (configDirectory) fs.rmSync(configDirectory, { recursive: true, force: true });
  });

  it('registers individual typed tools with annotations', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    expect(tools.some((tool) => tool.name === 'youtube_get_channel')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_upload_video')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_schedule_video')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_upload_caption_track')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_get_channel_analytics')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_create_or_update_live_broadcast')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_mux_audio')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_upload_channel_banner')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_rate_video')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_set_thumbnail_from_file')).toBe(true);
    expect(tools.some((tool) => tool.name === 'youtube_doctor')).toBe(true);
    expect(names.size).toBeGreaterThan(80);
    expect(tools.every((tool) => tool.inputSchema && tool.annotations)).toBe(true);
    expect(tools.find((tool) => tool.name === 'youtube_get_channel')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === 'youtube_delete_video')?.annotations?.destructiveHint).toBe(true);
    expect(
      (tools.find((tool) => tool.name === 'youtube_get_channel')?.inputSchema.properties as Record<string, unknown>)
        .account,
    ).toBeDefined();
  });

  it('returns account discovery without requiring OAuth', async () => {
    const result = await client.callTool({ name: 'accounts_list', arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
  });

  it('rejects malformed arguments before any OAuth call', async () => {
    const result = await client.callTool({
      name: 'youtube_schedule_video',
      arguments: { videoId: 'video-id', publishAt: 'tomorrow' },
    });
    expect(result.isError).toBe(true);
  });
});
