import { google, gmail_v1 } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

function createGmailClient(): gmail_v1.Gmail | null {
  if (!config.GMAIL_CLIENT_ID || !config.GMAIL_CLIENT_SECRET || !config.GMAIL_REFRESH_TOKEN) {
    logger.warn('Gmail credentials not configured — gmail monitor disabled');
    return null;
  }

  const oauth2 = new google.auth.OAuth2(
    config.GMAIL_CLIENT_ID,
    config.GMAIL_CLIENT_SECRET,
  );

  oauth2.setCredentials({ refresh_token: config.GMAIL_REFRESH_TOKEN });

  return google.gmail({ version: 'v1', auth: oauth2 });
}

const gmail = createGmailClient();

export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  sender: 'artsmix' | 'natwest' | 'ionos-billing' | 'unknown';
}

/**
 * Gmail query that matches:
 * - Artsmix (any email)
 * - NatWest (any email)
 * - IONOS billing only (invoice, payment, billing — not general service/marketing)
 */
const WATCHED_QUERY = [
  'from:artsmix',
  'from:natwest',
  '(from:ionos subject:(invoice OR billing OR payment OR renewal OR charge OR receipt))',
].join(' OR ');

function classifySender(from: string, subject: string): ParsedEmail['sender'] {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();

  if (f.includes('artsmix')) return 'artsmix';
  if (f.includes('natwest')) return 'natwest';
  if (f.includes('ionos') && /invoice|billing|payment|renewal|charge|receipt/.test(s)) return 'ionos-billing';

  return 'unknown';
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

export const gmailService = {
  isConfigured(): boolean {
    return !!gmail;
  },

  /**
   * Fetch recent important emails newer than `afterEpoch` (seconds since epoch).
   */
  async getNewImportantEmails(afterEpoch: number): Promise<ParsedEmail[]> {
    if (!gmail) return [];

    try {
      const query = `(${WATCHED_QUERY}) after:${afterEpoch}`;
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      if (!res.data.messages || res.data.messages.length === 0) return [];

      const emails: ParsedEmail[] = [];

      for (const msg of res.data.messages) {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });

          const headers = detail.data.payload?.headers || [];
          const from = getHeader(headers, 'From');
          const subject = getHeader(headers, 'Subject');
          const date = getHeader(headers, 'Date');
          const snippet = detail.data.snippet || '';

          const sender = classifySender(from, subject);

          // Skip non-billing IONOS emails that somehow slipped through
          if (from.toLowerCase().includes('ionos') && sender === 'unknown') continue;

          emails.push({
            id: msg.id!,
            threadId: msg.threadId || msg.id!,
            from,
            subject,
            snippet,
            date,
            sender,
          });
        } catch (err) {
          logger.error({ err, msgId: msg.id }, 'Failed to fetch email detail');
        }
      }

      return emails;
    } catch (err) {
      logger.error({ err }, 'Gmail API error');
      return [];
    }
  },
};
