/**
 * Gmail MCP Tools — check important emails from Artsmix, NatWest, IONOS billing
 */
import { google, gmail_v1 } from 'googleapis';

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';

function createGmail(): gmail_v1.Gmail | null {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) return null;
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

const gmail = createGmail();

const WATCHED_QUERY = [
  'from:artsmix',
  'from:natwest',
  '(from:ionos subject:(invoice OR billing OR payment OR renewal OR charge OR receipt))',
].join(' OR ');

function classifySender(from: string, subject: string): string {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();
  if (f.includes('artsmix')) return 'Artsmix (Event/Stall)';
  if (f.includes('natwest')) return 'NatWest (Banking)';
  if (f.includes('ionos') && /invoice|billing|payment|renewal|charge|receipt/.test(s)) return 'IONOS (Billing)';
  return 'Other';
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

export const gmailTools = {
  async checkImportantEmails({ hours_back }: { hours_back: number }) {
    if (!gmail) {
      return { content: [{ type: 'text' as const, text: 'Gmail not configured. Need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.' }] };
    }

    try {
      const afterEpoch = Math.floor((Date.now() - hours_back * 60 * 60 * 1000) / 1000);
      const query = `(${WATCHED_QUERY}) after:${afterEpoch}`;

      const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 15 });
      if (!res.data.messages || res.data.messages.length === 0) {
        return { content: [{ type: 'text' as const, text: `No important emails in the last ${hours_back} hours.` }] };
      }

      const emails: string[] = [`**Important emails (last ${hours_back}h):**`];

      for (const msg of res.data.messages) {
        const detail = await gmail.users.messages.get({
          userId: 'me', id: msg.id!, format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = detail.data.payload?.headers || [];
        const from = getHeader(headers, 'From');
        const subject = getHeader(headers, 'Subject');
        const date = getHeader(headers, 'Date');
        const category = classifySender(from, subject);
        const snippet = detail.data.snippet || '';

        // Skip non-billing IONOS
        if (from.toLowerCase().includes('ionos') && category === 'Other') continue;

        emails.push(`\n**[${category}]** ${subject}`);
        emails.push(`From: ${from}`);
        emails.push(`Date: ${date}`);
        if (snippet) emails.push(`Preview: ${snippet.slice(0, 150)}${snippet.length > 150 ? '...' : ''}`);
      }

      return { content: [{ type: 'text' as const, text: emails.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Gmail error: ${(err as Error).message}` }] };
    }
  },
};
