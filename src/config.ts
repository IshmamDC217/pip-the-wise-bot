import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // Discord
  DISCORD_TOKEN: required('DISCORD_TOKEN'),
  DISCORD_CLIENT_ID: required('DISCORD_CLIENT_ID'),
  DISCORD_GUILD_ID: required('DISCORD_GUILD_ID'),

  // Channels
  CHANNEL_SHOP: required('CHANNEL_SHOP'),
  CHANNEL_WEBSITE: required('CHANNEL_WEBSITE'),
  CHANNEL_GENERAL: required('CHANNEL_GENERAL'),

  // ForgeRealm
  FORGEREALM_API_URL: optional('FORGEREALM_API_URL', 'https://api.forgerealm.co.uk'),
  FORGEREALM_SITE_URL: optional('FORGEREALM_SITE_URL', 'https://forgerealm.co.uk'),

  // MySQL
  DB_HOST: optional('DB_HOST', 'localhost'),
  DB_PORT: parseInt(optional('DB_PORT', '3306')),
  DB_USER: optional('DB_USER', 'root'),
  DB_PASS: optional('DB_PASS', ''),
  DB_NAME: optional('DB_NAME', 'forgerealm'),

  // OpenClaw gateway (replaces direct Anthropic calls)
  OPENCLAW_GATEWAY_URL: optional('OPENCLAW_GATEWAY_URL', 'http://127.0.0.1:18789'),

  // Google (Calendar + Sheets share the same service account)
  GOOGLE_SERVICE_ACCOUNT: optional('GOOGLE_SERVICE_ACCOUNT', ''),
  GOOGLE_CALENDAR_ID: optional('GOOGLE_CALENDAR_ID', ''),

  // Permissions — Discord user IDs allowed to delete products
  ADMIN_USER_IDS: optional('ADMIN_USER_IDS', '447033110773628930,535658393562775562').split(','),

  // ForgeRealm POS API
  POS_API_URL: optional('POS_API_URL', ''),
  POS_USERNAME: optional('POS_USERNAME', ''),
  POS_PASSWORD: optional('POS_PASSWORD', ''),

  // Gmail OAuth2 (run `npx tsx scripts/gmail-auth.ts` to set up)
  GMAIL_CLIENT_ID: optional('GMAIL_CLIENT_ID', ''),
  GMAIL_CLIENT_SECRET: optional('GMAIL_CLIENT_SECRET', ''),
  GMAIL_REFRESH_TOKEN: optional('GMAIL_REFRESH_TOKEN', ''),

  // Polling intervals
  POLL_DATABASE_MS: parseInt(optional('POLL_DATABASE_MS', '60000')),
  POLL_WEBSITE_MS: parseInt(optional('POLL_WEBSITE_MS', '300000')),
  POLL_API_HEALTH_MS: parseInt(optional('POLL_API_HEALTH_MS', '180000')),
  NUDGE_INTERVAL_MS: parseInt(optional('NUDGE_INTERVAL_MS', String(4 * 24 * 60 * 60 * 1000))),
} as const;
