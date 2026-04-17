#!/usr/bin/env npx tsx
/**
 * Google Tasks OAuth Authorization Script
 * Generates OAuth tokens for the Google Tasks MCP server.
 *
 * Usage: npx tsx scripts/google-tasks-auth.ts
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'node:readline';

const CONFIG_DIR = path.join(os.homedir(), '.google-tasks-mcp');
const OAUTH_KEYS_PATH = path.join(CONFIG_DIR, 'gcp-oauth.keys.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/tasks';

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  // 1. Read OAuth keys
  if (!fs.existsSync(OAUTH_KEYS_PATH)) {
    console.error(`Error: ${OAUTH_KEYS_PATH} not found.`);
    console.error('Place your GCP OAuth client JSON file there first.');
    process.exit(1);
  }

  const keysData = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const keyObj = keysData.installed || keysData.web;
  if (!keyObj) {
    console.error('Error: gcp-oauth.keys.json must have an "installed" or "web" key.');
    process.exit(1);
  }

  const clientId = keyObj.client_id;
  const clientSecret = keyObj.client_secret;
  const redirectUri = keyObj.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob';

  // 2. Build authorization URL
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });

  const authUrl = `${AUTH_ENDPOINT}?${params.toString()}`;

  console.log('\nOpen this URL in your browser to authorize Google Tasks access:\n');
  console.log(authUrl);
  console.log();

  // 3. Get authorization code from user
  const code = await prompt('Paste the authorization code here: ');
  if (!code) {
    console.error('No authorization code provided.');
    process.exit(1);
  }

  // 4. Exchange code for tokens
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Token exchange failed (${response.status}): ${text}`);
    process.exit(1);
  }

  const tokenData = await response.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  // 5. Write credentials
  const credentials = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type,
    expiry_date: Date.now() + tokenData.expires_in * 1000,
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));

  console.log(`\nSuccess! Credentials saved to ${CREDENTIALS_PATH}`);
  console.log('Google Tasks MCP server is now ready to use.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
