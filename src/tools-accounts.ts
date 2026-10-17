import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { exchangeCode, forgetAuthClient, getAccountAuthStatus, getAuthUrl } from './auth.js';
import { getConfigDirectory, getDefaultAccount, listAccountAliases, removeAccount, setDefaultAccount } from './accounts.js';
import { getQuotaStatus } from './quota.js';

function binaryAvailable(binary: string): boolean {
  const result = spawnSync(binary, ['-version'], { stdio: 'ignore', timeout: 2500 });
  return !result.error && result.status === 0;
}

export const accountTools = {
  accounts_list: {
    description: 'List authorized YouTube account aliases and show the default account.',
    inputSchema: z.object({}),
    handler: async () => ({
      accounts: listAccountAliases(),
      defaultAccount: getDefaultAccount() ?? process.env.YOUTUBE_PLUGIN_ACCOUNT ?? process.env.YOUTUBE_MCP_ACCOUNT ?? null,
    }),
  },
  accounts_status: {
    description: 'Show OAuth expiry and granted scopes for each configured YouTube account.',
    inputSchema: z.object({}),
    handler: async () => ({ accounts: getAccountAuthStatus() }),
  },
  quota_status: {
    description: 'Show estimated local YouTube API usage today; Google Console is authoritative.',
    inputSchema: z.object({}),
    handler: async () => getQuotaStatus(),
  },
  doctor: {
    description: 'Check OAuth configuration, account scopes, credential directory, and optional FFmpeg availability without revealing secrets.',
    inputSchema: z.object({}),
    handler: async () => {
      const accounts = getAccountAuthStatus();
      return {
        oauthClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        configDirectory: getConfigDirectory(),
        configDirectoryExists: fs.existsSync(getConfigDirectory()),
        defaultAccount: getDefaultAccount() ?? process.env.YOUTUBE_PLUGIN_ACCOUNT ?? process.env.YOUTUBE_MCP_ACCOUNT ?? null,
        accounts,
        media: {
          ffmpegAvailable: binaryAvailable(process.env.FFMPEG_PATH || 'ffmpeg'),
          ffprobeAvailable: binaryAvailable(process.env.FFPROBE_PATH || 'ffprobe'),
        },
      };
    },
  },
  accounts_begin_auth: {
    description: 'Create a Google OAuth consent URL for a new or existing named YouTube account.',
    inputSchema: z.object({
      targetAccount: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
        .describe('Local alias to assign to the authorized channel, e.g. brand-a'),
      includeMembershipScope: z.boolean().optional().default(false)
        .describe('Request the sensitive channel-memberships scope only if you need member tools'),
    }),
    handler: async ({ targetAccount, includeMembershipScope }: { targetAccount: string; includeMembershipScope: boolean }) => ({
      account: targetAccount,
      authorizationUrl: getAuthUrl(targetAccount, { includeMembershipScope }),
      nextStep: 'Open the URL, approve access, then pass the returned code to accounts_complete_auth.',
    }),
  },
  accounts_complete_auth: {
    description: 'Exchange a one-time Google OAuth code and save credentials under a named account alias.',
    inputSchema: z.object({
      targetAccount: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
      code: z.string().min(1).describe('One-time authorization code returned by Google'),
    }),
    handler: async ({ targetAccount, code }: { targetAccount: string; code: string }) => {
      await exchangeCode(code, targetAccount);
      return { success: true, account: targetAccount };
    },
  },
  accounts_set_default: {
    description: 'Set the default named account used when a YouTube tool call omits its account parameter.',
    inputSchema: z.object({
      targetAccount: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    }),
    handler: async ({ targetAccount }: { targetAccount: string }) => {
      setDefaultAccount(targetAccount);
      return { success: true, defaultAccount: targetAccount };
    },
  },
  accounts_remove: {
    description: 'Remove a named account OAuth token file. This cannot be undone.',
    inputSchema: z.object({
      targetAccount: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
      confirm: z.literal(true).describe('Must be true to confirm permanent local credential removal'),
    }),
    handler: async ({ targetAccount, confirm }: { targetAccount: string; confirm: true }) => {
      if (!confirm) throw new Error('Set confirm=true to remove the account credentials.');
      forgetAuthClient(targetAccount);
      removeAccount(targetAccount);
      return { success: true, removedAccount: targetAccount };
    },
  },
};
