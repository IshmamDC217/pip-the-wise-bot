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

  // Groq AI
  GROQ_API_KEY: required('GROQ_API_KEY'),

  // Polling intervals
  POLL_DATABASE_MS: parseInt(optional('POLL_DATABASE_MS', '60000')),
  POLL_WEBSITE_MS: parseInt(optional('POLL_WEBSITE_MS', '300000')),
  POLL_API_HEALTH_MS: parseInt(optional('POLL_API_HEALTH_MS', '180000')),
} as const;
