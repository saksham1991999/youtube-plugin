import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

export interface StoredTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
  [key: string]: unknown;
}

const DEFAULT_ALIAS = 'default';

export function getConfigDirectory(): string {
  return path.resolve(
    process.env.YOUTUBE_PLUGIN_CONFIG_DIR ||
      process.env.YOUTUBE_MCP_CONFIG_DIR ||
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'youtube-plugin'),
  );
}

function accountsDirectory(): string {
  return path.join(getConfigDirectory(), 'accounts');
}

function validateAlias(alias: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias)) {
    throw new Error('Account alias must be 1-64 letters, numbers, underscores, or hyphens.');
  }
  return alias;
}

function ensureSecureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows does not support POSIX mode bits.
  }
}

export function listAccountAliases(): string[] {
  try {
    const aliases = fs
      .readdirSync(accountsDirectory(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .filter((alias) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(alias))
      .sort();
    if (!aliases.includes(DEFAULT_ALIAS) && fs.existsSync(legacyTokenPath())) aliases.push(DEFAULT_ALIAS);
    return aliases.sort();
  } catch {
    return fs.existsSync(legacyTokenPath()) ? [DEFAULT_ALIAS] : [];
  }
}

export function getDefaultAccount(): string | undefined {
  const filePath = path.join(getConfigDirectory(), 'default-account');
  try {
    const alias = fs.readFileSync(filePath, 'utf8').trim();
    return alias ? validateAlias(alias) : undefined;
  } catch {
    return undefined;
  }
}

export function setDefaultAccount(alias: string): void {
  validateAlias(alias);
  if (!readAccountTokens(alias)) {
    throw new Error(`No credentials found for account "${alias}". Authorize it first.`);
  }
  const directory = getConfigDirectory();
  ensureSecureDirectory(directory);
  const target = path.join(directory, 'default-account');
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, alias, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function resolveAccount(requested?: string): string {
  if (requested) return validateAlias(requested);
  const configured = process.env.YOUTUBE_PLUGIN_ACCOUNT || process.env.YOUTUBE_MCP_ACCOUNT;
  if (configured) return validateAlias(configured);

  const defaultAccount = getDefaultAccount();
  if (defaultAccount) return defaultAccount;

  const accounts = listAccountAliases();
  if (accounts.length === 1) return accounts[0]!;
  if (accounts.length > 1) {
    throw new Error(`Multiple YouTube accounts are configured (${accounts.join(', ')}). Pass account or set a default account.`);
  }
  if (legacyTokenPath() && fs.existsSync(legacyTokenPath())) return DEFAULT_ALIAS;
  throw new Error('No YouTube accounts are authorized. Run `npm run auth -- <account-alias>` to authorize one.');
}

function legacyTokenPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tokens.json');
}

export function readAccountTokens(alias: string): StoredTokens | null {
  validateAlias(alias);
  const filePath = path.join(accountsDirectory(), `${alias}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredTokens;
    return parsed.access_token || parsed.refresh_token ? parsed : null;
  } catch {
    if (alias === DEFAULT_ALIAS) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacyTokenPath(), 'utf8')) as StoredTokens;
        return parsed.access_token || parsed.refresh_token ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function writeAccountTokens(alias: string, tokens: StoredTokens): void {
  validateAlias(alias);
  const directory = accountsDirectory();
  ensureSecureDirectory(directory);
  const target = path.join(directory, `${alias}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  const existing = readAccountTokens(alias);
  const merged = {
    ...tokens,
    ...(tokens.refresh_token || !existing?.refresh_token ? {} : { refresh_token: existing.refresh_token }),
  };
  fs.writeFileSync(temporary, JSON.stringify(merged, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // Windows does not support POSIX mode bits.
  }
  fs.renameSync(temporary, target);
}

export function removeAccount(alias: string): void {
  validateAlias(alias);
  const filePath = path.join(accountsDirectory(), `${alias}.json`);
  const legacyPath = alias === DEFAULT_ALIAS ? legacyTokenPath() : undefined;
  const hasAccountFile = fs.existsSync(filePath);
  const hasLegacyFile = Boolean(legacyPath && fs.existsSync(legacyPath));
  if (!hasAccountFile && !hasLegacyFile) throw new Error(`Account "${alias}" was not found.`);
  if (hasAccountFile) fs.unlinkSync(filePath);
  if (hasLegacyFile && legacyPath) fs.unlinkSync(legacyPath);
  if (getDefaultAccount() === alias) {
    fs.rmSync(path.join(getConfigDirectory(), 'default-account'), { force: true });
  }
}
