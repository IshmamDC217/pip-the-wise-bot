import { google } from 'googleapis';
import { googleAuth } from './google-auth.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const calendar = googleAuth ? google.calendar({ version: 'v3', auth: googleAuth }) : null;

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
        const endDate = new Date(date + 'T00:00:00');
        endDate.setDate(endDate.getDate() + 1);
        const endDateStr = endDate.toISOString().split('T')[0];
        event.start = { date };
        event.end = { date: endDateStr };
      } else {
        const dateTime = `${date}T${options.time}:00`;
        // Keep end time in the same format as start (not ISO/UTC)
        const [hours, minutes] = options.time.split(':').map(Number);
        const endHour = String((hours + 1) % 24).padStart(2, '0');
        const endTime = `${endHour}:${String(minutes).padStart(2, '0')}`;
        const endDateTime = `${date}T${endTime}:00`;
        event.start = { dateTime, timeZone: 'Europe/London' };
        event.end = { dateTime: endDateTime, timeZone: 'Europe/London' };
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
          const dateTime = `${updates.date}T${updates.time}:00`;
          body.start = { dateTime, timeZone: 'Europe/London' };
          body.end = {
            dateTime: new Date(new Date(dateTime).getTime() + 3600000).toISOString(),
            timeZone: 'Europe/London',
          };
        } else {
          body.start = { date: updates.date };
          body.end = { date: updates.date };
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
