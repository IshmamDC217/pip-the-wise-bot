/**
 * One-time OAuth2 setup for Gmail access.
 *
 * Prerequisites:
 *   1. Go to Google Cloud Console → your "forgerealm-bot" project
 *   2. Enable the Gmail API (APIs & Services → Library → search "Gmail API" → Enable)
 *   3. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID
 *      - Application type: Desktop app
 *      - Name: "Pip Gmail"
 *   4. Download the JSON and save it as `scripts/gmail-oauth-creds.json`
 *   5. Run:  npx tsx scripts/gmail-auth.ts
 *   6. It will open a browser — sign in as forgerealmltd@gmail.com and grant access
 *   7. Copy the refresh token it prints and add it to your .env as GMAIL_REFRESH_TOKEN
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { google } from 'googleapis';

const CREDS_PATH = new URL('./gmail-oauth-creds.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

let creds: any;
try {
  creds = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'));
} catch {
  console.error('Missing scripts/gmail-oauth-creds.json — see the instructions at the top of this file.');
  process.exit(1);
}

const { client_id, client_secret } = creds.installed || creds.web || creds;
const REDIRECT_URI = 'http://localhost:3333/callback';

const oauth2 = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
});

console.log('\nOpening browser for Google sign-in...\n');
console.log('If it doesn\'t open automatically, go to:\n');
console.log(authUrl);
console.log();

// Open browser
const { exec } = await import('node:child_process');
exec(`start "${authUrl}"`);

// Tiny HTTP server to catch the callback
const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) return;

  const url = new URL(req.url, 'http://localhost:3333');
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('No code received');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Done! You can close this tab.</h2><p>Check your terminal for the refresh token.</p>');

    console.log('='.repeat(60));
    console.log('SUCCESS! Add this to your .env file:\n');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log(`GMAIL_CLIENT_ID=${client_id}`);
    console.log(`GMAIL_CLIENT_SECRET=${client_secret}`);
    console.log('='.repeat(60));
  } catch (err) {
    res.writeHead(500);
    res.end('Token exchange failed');
    console.error('Token exchange failed:', err);
  }

  server.close();
  process.exit(0);
});

server.listen(3333, () => {
  console.log('Waiting for Google callback on http://localhost:3333/callback ...');
});
