import { google } from 'googleapis';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

function getAuth() {
  if (!config.GOOGLE_SERVICE_ACCOUNT) return null;

  const credentials = JSON.parse(
    Buffer.from(config.GOOGLE_SERVICE_ACCOUNT, 'base64').toString('utf-8'),
  );

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

const auth = getAuth();
const calendar = auth ? google.calendar({ version: 'v3', auth }) : null;

export const calendarService = {
  isConfigured(): boolean {
    return !!calendar && !!config.GOOGLE_CALENDAR_ID;
  },

  async createEvent(
    summary: string,
    date: string,
    options: { allDay?: boolean; time?: string; description?: string } = {},
  ): Promise<string | null> {
    if (!calendar) return null;

    try {
      const event: any = {
        summary,
        description: options.description || '',
      };

      if (options.allDay || !options.time) {
        event.start = { date };
        event.end = { date };
      } else {
        const dateTime = `${date}T${options.time}:00`;
        event.start = { dateTime, timeZone: 'Europe/London' };
        event.end = {
          dateTime: new Date(new Date(dateTime).getTime() + 3600000).toISOString(),
          timeZone: 'Europe/London',
        };
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

      logger.info({ summary, date }, 'Calendar event created');
      return res.data.id || null;
    } catch (err) {
      logger.error({ err }, 'Failed to create calendar event');
      return null;
    }
  },

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
      return [];
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
