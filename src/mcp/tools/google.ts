/**
 * Google MCP Tools — Calendar events, Sheets creation
 */
import { google } from 'googleapis';
import { parseServiceAccountJson } from '../../utils/google-sa.js';

function createAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    // Shared parser handles the literal newlines in private_key; a raw
    // JSON.parse rejects the credential and silently disabled every Google tool
    const credentials = parseServiceAccountJson(raw);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.file',
      ],
    });
  } catch {
    return null;
  }
}

const auth = createAuth();
const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;
const sheets = auth ? google.sheets({ version: 'v4', auth }) : null;
const drive = auth ? google.drive({ version: 'v3', auth }) : null;

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'forgerealmltd@gmail.com';

export const googleTools = {
  async getCalendarEvents({ max_results }: { max_results: number }) {
    if (!calendar) {
      return { content: [{ type: 'text' as const, text: 'Google Calendar not configured.' }] };
    }

    try {
      const res = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: new Date().toISOString(),
        maxResults: max_results,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const events = res.data.items || [];
      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No upcoming events on the calendar.' }] };
      }

      const lines = ['**Upcoming Events:**'];
      for (const e of events) {
        const date = e.start?.date || e.start?.dateTime?.split('T')[0] || 'TBD';
        const time = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'All day';
        lines.push(`- **${e.summary}** — ${date} (${time})`);
        if (e.description) lines.push(`  ${e.description.slice(0, 100)}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Calendar error: ${(err as Error).message}` }] };
    }
  },

  async createCalendarEvent({ summary, date, time, description }: { summary: string; date: string; time?: string; description?: string }) {
    if (!calendar) {
      return { content: [{ type: 'text' as const, text: 'Google Calendar not configured.' }] };
    }

    try {
      const event: any = { summary, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 1440 }] } };
      if (description) event.description = description;

      if (time) {
        const dateTime = `${date}T${time}:00`;
        const endTime = new Date(new Date(dateTime).getTime() + 60 * 60 * 1000).toISOString();
        event.start = { dateTime, timeZone: 'Europe/London' };
        event.end = { dateTime: endTime, timeZone: 'Europe/London' };
      } else {
        const nextDay = new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        event.start = { date };
        event.end = { date: nextDay };
      }

      const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
      return { content: [{ type: 'text' as const, text: `Event created: **${summary}** on ${date}${time ? ` at ${time}` : ''} (ID: ${res.data.id})` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to create event: ${(err as Error).message}` }] };
    }
  },

  async createSheet({ title, headers, rows, currency_columns, include_total }: {
    title: string; headers: string[]; rows: (string | number)[][];
    currency_columns: number[]; include_total: boolean;
  }) {
    if (!sheets || !drive) {
      return { content: [{ type: 'text' as const, text: 'Google Sheets not configured.' }] };
    }

    try {
      // Build row data
      const allRows: any[][] = [headers, ...rows];

      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: [{ properties: { title: 'Sheet1', gridProperties: { frozenRowCount: 1 } } }],
        },
      });

      const spreadsheetId = res.data.spreadsheetId!;

      // Write data
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Sheet1!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: allRows },
      });

      // Make viewable
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: { role: 'reader', type: 'anyone' },
      });

      const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
      return { content: [{ type: 'text' as const, text: `Sheet created: **${title}** (${rows.length} rows)\n${url}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to create sheet: ${(err as Error).message}` }] };
    }
  },
};
