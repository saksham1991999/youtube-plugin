#!/usr/bin/env tsx
import * as readline from 'node:readline';
import { exchangeCode, getAuthUrl } from './auth.js';
import { readAccountTokens } from './accounts.js';

const args = process.argv.slice(2);
const alias = args.find((value) => !value.startsWith('--')) || 'default';
const includeMembershipScope = args.includes('--memberships');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

async function main() {
  try {
    if (readAccountTokens(alias)) {
      const answer = await ask(`Credentials already exist for "${alias}". Re-authorize? (y/N): `);
      if (answer.toLowerCase() !== 'y') {
        console.error('Keeping existing credentials.');
        return;
      }
    }

    const authUrl = getAuthUrl(alias, { includeMembershipScope });
    console.error(`\nAuthorize YouTube account "${alias}" by opening:\n\n${authUrl}\n`);
    console.error('After approval, copy the "code" parameter from the localhost redirect URL.');
    const code = await ask('Authorization code: ');
    if (!code) throw new Error('No authorization code provided.');
    await exchangeCode(code, alias);
    console.error(`Authorized "${alias}". Credentials are stored outside the repository.`);
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error('Authorization failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
