import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { getRequestedAccount } from './account-context.js';
import {
  listAccountAliases,
  readAccountTokens,
  resolveAccount,
  writeAccountTokens,
  type StoredTokens,
} from './accounts.js';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
];
export const MEMBERSHIPS_SCOPE = 'https://www.googleapis.com/auth/youtube.channel-memberships.creator';

const clients = new Map<string, OAuth2Client>();

export function forgetAuthClient(account: string): void {
  clients.delete(account);
}

function getCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET environment variables. See README.md for setup.');
  }
  return { clientId, clientSecret };
}

export async function getAuthClient(account?: string): Promise<OAuth2Client> {
  const alias = resolveAccount(account ?? getRequestedAccount());
  let client = clients.get(alias);
  if (client) {
    if (client.credentials.expiry_date && client.credentials.expiry_date <= Date.now() + 60_000) {
      try {
        const { credentials } = await client.refreshAccessToken();
        client.setCredentials(credentials);
        writeAccountTokens(alias, credentials as StoredTokens);
      } catch (error) {
        throw new Error(`OAuth refresh failed for account "${alias}". Run \`npm run auth -- ${alias}\` to reconnect. ${errorMessage(error)}`);
      }
    }
    return client;
  }

  const tokens = readAccountTokens(alias);
  if (!tokens) throw new Error(`No credentials found for account "${alias}". Run \`npm run auth -- ${alias}\` to authorize.`);

  const { clientId, clientSecret } = getCredentials();
  client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => writeAccountTokens(alias, newTokens as StoredTokens));
  clients.set(alias, client);

  if (client.credentials.expiry_date && client.credentials.expiry_date <= Date.now() + 60_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      writeAccountTokens(alias, credentials as StoredTokens);
    } catch (error) {
      clients.delete(alias);
      throw new Error(`Stored OAuth token expired for account "${alias}". Run \`npm run auth -- ${alias}\` to reconnect. ${errorMessage(error)}`);
    }
  }
  return client;
}

export async function getYoutubeService() {
  return google.youtube({ version: 'v3', auth: await getAuthClient() });
}

export async function getYoutubeAnalyticsService() {
  return google.youtubeAnalytics({ version: 'v2', auth: await getAuthClient() });
}

export async function getYoutubeReportingService() {
  return google.youtubereporting({ version: 'v1', auth: await getAuthClient() });
}

export function getAuthUrl(account = 'default', options: { includeMembershipScope?: boolean } = {}): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(account)) {
    throw new Error('Account alias must be 1-64 letters, numbers, underscores, or hyphens.');
  }
  const { clientId, clientSecret } = getCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: options.includeMembershipScope ? [...YOUTUBE_SCOPES, MEMBERSHIPS_SCOPE] : YOUTUBE_SCOPES,
    prompt: 'consent',
    state: account,
  });
}

export function requireCurrentScope(scope: string, capability: string): void {
  const alias = resolveAccount(getRequestedAccount());
  const scopes = (readAccountTokens(alias)?.scope || '').split(/\s+/);
  if (!scopes.includes(scope)) {
    throw new Error(
      `${capability} requires OAuth scope ${scope}. Re-authorize account "${alias}" with the optional scope enabled.`,
    );
  }
}

export async function exchangeCode(code: string, account = 'default'): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(account)) {
    throw new Error('Account alias must be 1-64 letters, numbers, underscores, or hyphens.');
  }
  const { clientId, clientSecret } = getCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret, 'http://localhost');
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token && !tokens.refresh_token) throw new Error('Google returned no usable OAuth tokens.');
  writeAccountTokens(account, tokens as StoredTokens);
  clients.delete(account);
}

export function getAccountAuthStatus() {
  return listAccountAliases().map((alias) => {
    const tokens = readAccountTokens(alias);
    const scopes = (tokens?.scope || '').split(/\s+/).filter(Boolean);
    return {
      account: alias,
      authorized: Boolean(tokens),
      expiresAt: tokens?.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      hasRefreshToken: Boolean(tokens?.refresh_token),
      scopes,
      missingScopes: YOUTUBE_SCOPES.filter((scope) => !scopes.includes(scope)),
      membershipScopeGranted: scopes.includes(MEMBERSHIPS_SCOPE),
    };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
