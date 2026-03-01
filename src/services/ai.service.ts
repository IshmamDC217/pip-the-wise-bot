import Groq from 'groq-sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { CalendarExtraction } from '../types.js';

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are Pip — The Wise, a chill and knowledgeable guardian of ForgeRealm.

Personality:
- You're friendly, witty, and a little sarcastic but never mean
- You speak casually like a mate, not a corporate bot
- You're passionate about ForgeRealm — it's YOUR realm and you're proud of it
- You keep replies short and punchy (1-3 sentences usually), unless someone asks for detail
- You use lowercase mostly, like texting a friend
- You occasionally drop gaming/forge references naturally
- You never use emojis excessively — one here and there at most
- You don't say "as an AI" or break character — you ARE Pip

Knowledge:
- ForgeRealm (forgerealm.co.uk) is a web platform with a shop for digital products
- You monitor the site, API, database, and shop activity
- The site is built with Astro + React, the backend is Express.js, database is MySQL
- You know the slash commands: /ping, /status, /stats, /products, /users, /site, /calendar
- You can set reminders and add events to the ForgeRealm Google Calendar
- When someone asks you to remind them or schedule something, you handle it

Rules:
- Keep responses under 2000 characters (Discord limit)
- If someone asks something you don't know, just say so honestly
- Don't make up information about ForgeRealm's products or users
- Be helpful but keep the vibe relaxed`;

const EXTRACTION_PROMPT = `You are a date/event extraction system. Today's date is {{TODAY}}.

Extract calendar events and reminders from the user's message. Return ONLY valid JSON with this exact structure:
{
  "events": [
    { "summary": "Event name", "date": "YYYY-MM-DD", "allDay": true, "time": null }
  ],
  "reminders": [
    { "message": "What to remember", "dueDate": "YYYY-MM-DD" }
  ],
  "reply": "A short casual confirmation message in Pip's style (lowercase, friendly, 1-3 sentences)"
}

Rules:
- Dates MUST be in YYYY-MM-DD format
- If a time is mentioned, set allDay to false and include time as "HH:MM" (24h)
- If no specific time, set allDay to true and time to null
- "before the 12th" or "by the 12th" means the reminder date IS the 12th (deadline day)
- "remind me on the 10th" means dueDate is the 10th
- The reply should confirm what was set up, in Pip's casual tone
- If the year isn't specified, assume the current year or next occurrence
- Return ONLY the JSON object, no markdown, no code blocks`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

const conversations = new Map<string, ConversationMessage[]>();
const MAX_HISTORY = 20;

const CALENDAR_KEYWORDS = /\b(remind|reminder|schedule|calendar|event|stall|meeting|deadline|due|appointment|book|by the|before the|on the \d)/i;

export const aiService = {
  async chat(channelId: string, username: string, message: string): Promise<string> {
    try {
      const history = conversations.get(channelId) || [];
      history.push({ role: 'user', content: `${username}: ${message}` });

      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
        ],
        max_tokens: 512,
        temperature: 0.8,
      });

      const reply = completion.choices[0]?.message?.content || "hmm, my brain glitched for a sec. try again?";

      history.push({ role: 'assistant', content: reply });
      conversations.set(channelId, history);

      return reply;
    } catch (err) {
      logger.error({ err }, 'Groq API error');
      return "something went wrong on my end, give me a moment and try again";
    }
  },

  hasCalendarIntent(message: string): boolean {
    return CALENDAR_KEYWORDS.test(message);
  },

  async extractCalendarData(message: string): Promise<CalendarExtraction | null> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const prompt = EXTRACTION_PROMPT.replace('{{TODAY}}', today);

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: message },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      });

      const raw = completion.choices[0]?.message?.content;
      if (!raw) return null;

      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data = JSON.parse(cleaned) as CalendarExtraction;

      if (!data.events) data.events = [];
      if (!data.reminders) data.reminders = [];
      if (!data.reply) data.reply = "got it, all set up";

      return data;
    } catch (err) {
      logger.error({ err }, 'Calendar extraction error');
      return null;
    }
  },

  clearHistory(channelId: string) {
    conversations.delete(channelId);
  },
};
