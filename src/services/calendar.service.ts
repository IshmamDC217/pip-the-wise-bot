import { google } from 'googleapis';
import { googleAuth } from './google-auth.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const calendar = googleAuth ? google.calendar({ version: 'v3', auth: googleAuth }) : null;

// UTC-safe: parsing "date + 'T00:00:00'" without a Z uses LOCAL time, so during
// BST the ISO round trip lost an hour and the exclusive end date collapsed onto
// the start date, which Google rejects — all-day events failed all summer.
function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + 86400000).toISOString().split('T')[0];
}

// Build start/end for a timed event, rolling the date when the +1h end crosses
// midnight (a 23:30 event must not end at 00:30 the same day).
function timedRange(date: string, time: string): { start: string; end: string } {
  const start = new Date(`${date}T${time}:00Z`);
  const end = new Date(start.getTime() + 3600000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19);
  // These strings carry no Z and are paired with timeZone: 'Europe/London',
  // so the wall-clock time the user asked for is preserved.
  return { start: fmt(start), end: fmt(end) };
}

export const calendarService = {
  isConfigured(): boolean {
    return !!calendar && !!config.GOOGLE_CALENDAR_ID;
  },

  async createEvent(
    summary: string,
    date: string,
    options: { allDay?: boolean; time?: string; description?: string; checklist?: string[] } = {},
  ): Promise<string | null> {
    if (!calendar) return null;

    try {
      let description = options.description || '';

      if (options.checklist && options.checklist.length > 0) {
        const checklistText = options.checklist.map((item) => `[ ] ${item}`).join('\n');
        description = description
          ? `${description}\n\nChecklist:\n${checklistText}`
          : `Checklist:\n${checklistText}`;
      }

      const event: any = { summary, description };

      if (options.allDay || !options.time) {
        // Google requires end date = start + 1 day for all-day events
        event.start = { date };
        event.end = { date: nextDay(date) };
      } else {
        const range = timedRange(date, options.time);
        event.start = { dateTime: range.start, timeZone: 'Europe/London' };
        event.end = { dateTime: range.end, timeZone: 'Europe/London' };
      }

      event.reminders = {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 1440 },
        ],
      };

      const res = await calendar.events.insert({
        calendarId: config.GOOGLE_CALENDAR_ID,
        requestBody: event,
      });

      logger.info({ summary, date, hasChecklist: !!options.checklist }, 'Calendar event created');
      return res.data.id || null;
    } catch (err) {
      logger.error({ err }, 'Failed to create calendar event');
      return null;
    }
  },

  async updateEvent(
    eventId: string,
    updates: { summary?: string; description?: string; date?: string; time?: string },
  ): Promise<boolean> {
    if (!calendar) return false;

    try {
      const existing = await calendar.events.get({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId,
      });

      const body: any = { ...existing.data };

      if (updates.summary) body.summary = updates.summary;
      if (updates.description !== undefined) body.description = updates.description;
      if (updates.date) {
        if (updates.time) {
          const range = timedRange(updates.date, updates.time);
          body.start = { dateTime: range.start, timeZone: 'Europe/London' };
          body.end = { dateTime: range.end, timeZone: 'Europe/London' };
        } else {
          body.start = { date: updates.date };
          body.end = { date: nextDay(updates.date) };
        }
      }

      await calendar.events.update({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId,
        requestBody: body,
      });
      return true;
    } catch (err) {
      logger.error({ err }, 'Failed to update calendar event');
      return false;
    }
  },

  /**
   * Throws on API/auth errors so callers can tell "calendar is empty" apart from
   * "couldn't reach the calendar" (swallowing errors made failures look like a
   * clear schedule). Returns [] only when unconfigured or genuinely empty.
   */
  async getUpcomingEvents(maxResults = 10): Promise<any[]> {
    if (!calendar) return [];

    try {
      const res = await calendar.events.list({
        calendarId: config.GOOGLE_CALENDAR_ID,
        timeMin: new Date().toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });

      return res.data.items || [];
    } catch (err) {
      logger.error({ err }, 'Failed to fetch calendar events');
      throw err;
    }
  },

  async deleteEvent(eventId: string): Promise<boolean> {
    if (!calendar) return false;

    try {
      await calendar.events.delete({
        calendarId: config.GOOGLE_CALENDAR_ID,
        eventId,
      });
      return true;
    } catch (err) {
      logger.error({ err }, 'Failed to delete calendar event');
      return false;
    }
  },
};
