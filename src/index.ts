#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runWithAccount } from './account-context.js';
import { recordQuotaEstimate } from './quota.js';
import { youtubeTools } from './tools.js';
import { accountTools } from './tools-accounts.js';
import { contentTools } from './tools-content.js';
import { liveTools } from './tools-live.js';
import { mediaTools } from './tools-media.js';
import { analyticsTools } from './tools-analytics.js';
import { brandingTools } from './tools-branding.js';
import { communityTools } from './tools-community.js';
import { localizationTools } from './tools-localization.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const server = new McpServer({ name: 'youtube-plugin', version: packageJson.version });

type ToolMap = Record<string, {
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<unknown>;
}>;

const allTools: ToolMap = {
  ...accountTools,
  ...youtubeTools,
  ...contentTools,
  ...liveTools,
  ...mediaTools,
  ...analyticsTools,
  ...brandingTools,
  ...communityTools,
  ...localizationTools,
};
const accountSchema = z.string().optional().describe('Named account alias. Omit to use the configured default.');
const configuredToolset = (process.env.YOUTUBE_PLUGIN_TOOLSET || process.env.YOUTUBE_MCP_TOOLSET || 'full').toLowerCase();
const readOnlyToolsets = new Set(['accounts_list', 'accounts_status', 'quota_status', 'doctor']);
const selectedTools = Object.entries(allTools).filter(([name]) => {
  if (configuredToolset === 'router') return false;
  if (configuredToolset === 'full') return true;
  if (configuredToolset === 'core') return readOnlyToolsets.has(name) || /^(get_|list_|search_)/.test(name);
  const allowlist = configuredToolset.split(',').map((item) => item.trim()).filter(Boolean);
  return allowlist.includes(name) || allowlist.includes(`youtube_${name}`);
});

function titleFor(name: string): string {
  return name.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function inputShape(schema: z.ZodTypeAny): z.ZodRawShape {
  let object: z.ZodTypeAny = schema;
  while (object instanceof z.ZodEffects) object = object.innerType();
  if (!(object instanceof z.ZodObject)) throw new Error('Tool inputs must be a Zod object or a refined Zod object.');
  return object.shape;
}

function isReadOnly(name: string): boolean {
  return /^(get_|list_|search_|probe_|accounts_list$|accounts_status$|quota_status$|doctor$)/.test(name);
}

function isDestructive(name: string): boolean {
  return /(^|_)(delete|remove|report_abuse)(_|$)/.test(name) ||
    name === 'accounts_remove' ||
    /^(set_thumbnail|unset_channel_watermark|transition_live_broadcast|bind_live_broadcast)$/.test(name);
}

function isIdempotent(name: string): boolean {
  return isReadOnly(name) || /^(update_|set_|schedule_|accounts_set_default)/.test(name);
}

function isLocalMedia(name: string): boolean {
  return /^(probe_media|mux_audio|normalize_loudness|extract_thumbnail|burn_subtitles|trim_clip)$/.test(name);
}

function serializeResult(value: unknown): { text: string; structuredContent?: Record<string, unknown> } {
  const json = JSON.stringify(value ?? null);
  if (json.length <= 16_000) {
    const objectValue = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
    return { text: json, ...(objectValue ? { structuredContent: objectValue } : {}) };
  }
  return {
    text: JSON.stringify({
      truncated: true,
      serializedCharacters: json.length,
      message: 'Result omitted because it exceeds the response limit. Narrow the query or use pagination.',
    }),
  };
}

for (const [name, tool] of selectedTools) {
  const nameInProtocol = name.startsWith('accounts_') ? name : `youtube_${name}`;
  const schemaShape = { ...inputShape(tool.inputSchema), account: accountSchema };
  server.registerTool(
    nameInProtocol,
    {
      title: titleFor(name),
      description: tool.description,
      inputSchema: schemaShape,
      annotations: {
        readOnlyHint: isReadOnly(name),
        destructiveHint: isDestructive(name),
        idempotentHint: isIdempotent(name),
        openWorldHint: !name.startsWith('accounts_') && !isLocalMedia(name),
      },
    },
    async (args: any) => {
      try {
        const validated = tool.inputSchema.parse(args);
        const result = await runWithAccount(args.account as string | undefined, () => tool.handler(validated));
        recordQuotaEstimate(nameInProtocol);
        const serialized = serializeResult(result);
        return {
          content: [{ type: 'text' as const, text: serialized.text }],
          ...(serialized.structuredContent ? { structuredContent: serialized.structuredContent } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );
}

if (configuredToolset === 'router') {
  const actionNames = Object.keys(youtubeTools) as [string, ...string[]];
  server.registerTool(
    'youtube',
    {
      title: 'YouTube action router (legacy)',
      description: `Compatibility router for the legacy action-based interface. Prefer the individual youtube_* tools. Actions: ${actionNames.join(', ')}`,
      inputSchema: {
        action: z.enum(actionNames).describe('Legacy YouTube action'),
        params: z.record(z.any()).optional().default({}).describe('Action-specific parameters, including optional account'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args: any) => {
      const action = args.action as keyof typeof youtubeTools;
      const params = (args.params || {}) as Record<string, unknown>;
      const tool = youtubeTools[action];
      try {
        const validated = tool.inputSchema.parse(params);
        const result = await runWithAccount(params.account as string | undefined, () => tool.handler(validated));
        recordQuotaEstimate(`youtube_${String(action)}`);
        const serialized = serializeResult(result);
        return {
          content: [{ type: 'text' as const, text: serialized.text }],
          ...(serialized.structuredContent ? { structuredContent: serialized.structuredContent } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  );
}

async function main() {
  await server.connect(new StdioServerTransport());
  const registeredCount = configuredToolset === 'router' ? 1 : selectedTools.length;
  console.error(`YouTube MCP server ready with ${registeredCount} tools (${configuredToolset} toolset).`);
}

main().catch((error: unknown) => {
  console.error('Fatal server error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
