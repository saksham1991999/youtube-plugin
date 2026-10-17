import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getDefaultAccount,
  listAccountAliases,
  readAccountTokens,
  removeAccount,
  resolveAccount,
  setDefaultAccount,
  writeAccountTokens,
} from '../src/accounts.js';

const temporaryDirectories: string[] = [];

function useTemporaryConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-plugin-test-'));
  temporaryDirectories.push(directory);
  process.env.YOUTUBE_PLUGIN_CONFIG_DIR = directory;
  delete process.env.YOUTUBE_PLUGIN_ACCOUNT;
  return directory;
}

afterEach(() => {
  delete process.env.YOUTUBE_PLUGIN_CONFIG_DIR;
  delete process.env.YOUTUBE_PLUGIN_ACCOUNT;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('named account storage', () => {
  it('writes tokens with restricted permissions and resolves a sole account', () => {
    const directory = useTemporaryConfig();
    writeAccountTokens('brand_a', { access_token: 'test-token', refresh_token: 'refresh' });

    expect(listAccountAliases()).toEqual(['brand_a']);
    expect(resolveAccount()).toBe('brand_a');
    expect(readAccountTokens('brand_a')?.refresh_token).toBe('refresh');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(directory, 'accounts')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(directory, 'accounts', 'brand_a.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('preserves refresh tokens when Google omits them during refresh', () => {
    useTemporaryConfig();
    writeAccountTokens('main', { access_token: 'first', refresh_token: 'keep-me' });
    writeAccountTokens('main', { access_token: 'refreshed' });
    expect(readAccountTokens('main')).toMatchObject({ access_token: 'refreshed', refresh_token: 'keep-me' });
  });

  it('requires an explicit selection when multiple accounts exist', () => {
    useTemporaryConfig();
    writeAccountTokens('brand_a', { access_token: 'a' });
    writeAccountTokens('brand_b', { access_token: 'b' });
    expect(() => resolveAccount()).toThrow(/Multiple YouTube accounts/);
    setDefaultAccount('brand_b');
    expect(getDefaultAccount()).toBe('brand_b');
    expect(resolveAccount()).toBe('brand_b');
  });

  it('rejects path traversal and removes the selected account', () => {
    useTemporaryConfig();
    expect(() => writeAccountTokens('../outside', { access_token: 'bad' })).toThrow(/alias/);
    writeAccountTokens('brand_a', { access_token: 'a' });
    removeAccount('brand_a');
    expect(listAccountAliases()).toEqual([]);
  });
});
