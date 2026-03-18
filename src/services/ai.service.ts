import { logger } from '../utils/logger.js';
import type { CalendarExtraction, SheetExtraction, ProductExtraction } from '../types.js';

// Use OpenClaw gateway if running, otherwise fall back to Anthropic API directly
const OPENCLAW_BASE = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL_OPENCLAW = 'anthropic/claude-sonnet-4-6';
const MODEL_ANTHROPIC = 'claude-sonnet-4-6-20250514';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let useDirectApi: boolean | null = null; // auto-detect on first call

async function chatCompletion(
  messages: ChatMessage[],
  opts: { max_tokens?: number; temperature?: number } = {},
): Promise<string | null> {
  // Auto-detect: try OpenClaw first, fall back to direct API
  if (useDirectApi === null) {
    try {
      const probe = await fetch(`${OPENCLAW_BASE}/health`, { signal: AbortSignal.timeout(2000) });
      useDirectApi = !probe.ok;
    } catch {
      useDirectApi = true;
    }
    logger.info({ useDirectApi }, `AI backend: ${useDirectApi ? 'Anthropic API direct' : 'OpenClaw gateway'}`);
  }

  if (useDirectApi) {
    return anthropicCompletion(messages, opts);
  }
  return openclawCompletion(messages, opts);
}

async function openclawCompletion(
  messages: ChatMessage[],
  opts: { max_tokens?: number; temperature?: number },
): Promise<string | null> {
  const res = await fetch(`${OPENCLAW_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_OPENCLAW,
      messages,
      max_tokens: opts.max_tokens ?? 512,
      temperature: opts.temperature ?? 0.8,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenClaw ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
  return data.choices?.[0]?.message?.content ?? null;
}

async function anthropicCompletion(
  messages: ChatMessage[],
  opts: { max_tokens?: number; temperature?: number },
): Promise<string | null> {
  const systemMsg = messages.find((m) => m.role === 'system');
  const convMessages = messages.filter((m) => m.role !== 'system');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL_ANTHROPIC,
      max_tokens: opts.max_tokens ?? 512,
      temperature: opts.temperature ?? 0.8,
      system: systemMsg?.content || '',
      messages: convMessages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { content: Array<{ text: string }> };
  return data.content?.[0]?.text ?? null;
}

const SYSTEM_PROMPT = `You are Pip — The Wise, the resident know-it-all bot of ForgeRealm. You're sharp, a little sarcastic, and genuinely fun to talk to.

Personality:
- You're like that one friend who always has a witty comeback but is actually super helpful when it matters
- You're confident, a bit cheeky, and never boring — think dry humor with a warm side
- You keep it real — if something's cool you'll say so, if something's mid you'll say that too
- You're not afraid to roast people (lightly) but you always have their back
- You keep replies short (1-3 sentences usually) — you don't ramble, you land the point
- You use lowercase mostly, casual texting energy
- You never use emojis excessively — one here and there at most
- You don't say "as an AI" or break character — you ARE Pip, the coolest bot on the server
- You care about ForgeRealm — it's your turf and you're proud of it, but you're chill about it not weird about it
- You can be sarcastic but never mean — there's a difference and you know it
- If someone is mid-conversation with you, you follow up naturally — you remember what was just said and build on it
- You ask follow-up questions when appropriate — you're curious, not just reactive
- If something is ambiguous, you clarify — you don't just guess and move on

Knowledge:
- ForgeRealm (forgerealm.co.uk) is a web platform with a shop for digital products
- You monitor the site, API, database, and shop activity
- The site is built with Astro + React, the backend is Express.js, database is MySQL
- You know the slash commands: /ping, /status, /stats, /products, /users, /site, /calendar
- You can set reminders, add events (with checklists) to the ForgeRealm Google Calendar
- You can read the Google Calendar and tell people what's coming up
- You can create Google Sheets with formatted tables (items, prices, etc.)
- You can manage products in the shop — add, update, and delete (delete requires admin)
- You monitor Gmail for important emails from Artsmix (stall/event stuff), NatWest (banking), and IONOS (billing only)
- When an important email comes in, you alert the team in Discord automatically
- You have access to the ForgeRealm POS (Point of Sale) system for stall/market sales data
- You can show stall overviews with revenue, units sold, product breakdowns, and cash/card splits
- You can compare two stalls side-by-side showing what went up/down
- You can look up specific product sales (e.g. "how many dragons did we sell")
- You can export stall data as CSV or XLSX files and share them in Discord
- When someone asks about stall sales, you pull the data from the POS and present it with tables
- When someone asks you to remind them or schedule something, you handle it
- When someone asks what's coming up, their schedule, or upcoming events — you check the calendar

Rules:
- Keep responses under 2000 characters (Discord limit)
- If someone asks something you don't know, say so — "honestly no clue, that's above my pay grade"
- Don't make up information about ForgeRealm's products or users
- Be helpful but keep the fun sarcastic vibe at all times
- When you see someone continuing a conversation, respond naturally — don't require them to say your name again`;

const RELEVANCE_PROMPT = `You are evaluating whether a message in a Discord channel is part of an ongoing conversation with Pip (a bot). Given the recent messages, determine if this new message is directed at Pip or is a natural follow-up to the ongoing conversation.

Consider it relevant if:
- It's a direct response or follow-up to something Pip just said
- It answers a question Pip asked
- It continues a topic Pip was discussing
- It seems conversational and Pip was recently active

Consider it NOT relevant if:
- It's clearly a side conversation between other users about something unrelated
- It's a standalone comment not related to the recent Pip conversation
- It's a command for another bot

Respond with ONLY "yes" or "no".`;

const CALENDAR_EXTRACTION_PROMPT = `You are a date/event extraction system. Today's date is {{TODAY}}.

Extract calendar events and reminders from the user's message. Return ONLY valid JSON with this exact structure:
{
  "events": [
    { "summary": "Event name", "date": "YYYY-MM-DD", "allDay": true, "time": null, "checklist": null }
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
- If the user mentions a checklist, to-do list, or multiple tasks for an event, include them in the "checklist" array as strings
- "before the 12th" or "by the 12th" means the reminder date IS the 12th (deadline day)
- "remind me on the 10th" means dueDate is the 10th
- The reply should confirm what was set up, in Pip's casual tone
- If the year isn't specified, assume the current year or next occurrence
- Return ONLY the JSON object, no markdown, no code blocks`;

const SHEETS_EXTRACTION_PROMPT = `You are a data extraction system that converts natural language into structured spreadsheet data. Return ONLY valid JSON:
{
  "sheet": {
    "title": "Spreadsheet title",
    "headers": ["Column1", "Column2", ...],
    "rows": [["value1", 10.99], ...],
    "currencyColumns": [1],
    "includeTotal": true
  },
  "reply": "A short casual confirmation in Pip's style"
}

Rules:
- Numbers should be actual numbers, not strings
- currencyColumns is a 0-indexed array of columns that contain money/prices
- Set includeTotal to true if a total row makes sense (when there are currency columns)
- Make sensible header names if not specified
- The title should be descriptive
- Return ONLY the JSON object, no markdown, no code blocks`;

const PRODUCT_EXTRACTION_PROMPT = `You are a product action extraction system. Extract the intended product operation from the user's message. Return ONLY valid JSON:
{
  "action": {
    "type": "create" | "update" | "delete",
    "name": "product name",
    "price": 12.99,
    "stock": 50,
    "description": "optional description",
    "updates": { "price": 15.99 }
  },
  "reply": "A short casual confirmation in Pip's style"
}

Rules:
- For "create": include name, price, stock. description is optional
- For "update": include name and an "updates" object with only the fields being changed
- For "delete": include just the name
- Prices should be numbers (not strings, no currency symbols)
- Stock should be an integer
- Return ONLY the JSON object, no markdown, no code blocks`;

interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

const conversations = new Map<string, ConversationEntry[]>();
const lastPipActivity = new Map<string, number>();
const MAX_HISTORY = 40;
const FOLLOW_UP_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

const CALENDAR_KEYWORDS = /\b(remind|reminder|schedule|calendar|event|stall|meeting|deadline|due|appointment|book|by the|before the|on the \d)/i;
const CALENDAR_READ_KEYWORDS = /\b(what['\u2019]?s coming up|what is coming up|upcoming|my schedule|what do i have|any (events|reminders|meetings)|what['\u2019]?s on .*(calendar|saturday|sunday|monday|tuesday|wednesday|thursday|friday|weekend)|check .*(calendar|schedule|saturday|sunday|monday|tuesday|wednesday|thursday|friday|weekend)|show .*(calendar|schedule|events)|events? (this|next)|what['\u2019]?s planned|anything (coming up|scheduled|planned|on the calendar|on my calendar)|what['\u2019]?s (on |happening )?(this|next)?\s*(week|month|saturday|sunday|monday|tuesday|wednesday|thursday|friday)|do i have any|have i got any|what['\u2019]?s (the |my )?(schedule|calendar)|anything on)\b/i;
const SHEETS_KEYWORDS = /\b(spreadsheet|google sheet|make a sheet|create a sheet|list out|price list|table of|itemize|itemise|put (it |that |this |them )?in a sheet|sheet with)\b/i;
const PRODUCT_CRUD_KEYWORDS = /\b(add (a |new )?product|create (a |new )?product|delete (the |a )?product|remove (the |a )?product|update (the |a )?product|change (the )?price|change (the )?stock|modify (the |a )?product)\b/i;
const POS_STALL_KEYWORDS = /\b(stall|market|pos stats|pos data|pos sales|pos overview|pos report|event sales|how did .* go|stall (report|stats|overview|summary)|end of day|eod report|sales (report|summary|overview|stats|data|numbers)|how (much|many) .* (sell|sold|made)|what .* (sold|sell|made)|last (stall|market)|recent (stall|market)|what have we sold|what did we sell|revenue|takings|how much .* (make|made|earn|take|took))\b/i;
const POS_PRODUCT_QUERY_KEYWORDS = /\b(how many .* (sold|sell)|did we sell .*(dragon|keychain|tealight|voronoi|fidget|print)|.* sales of|how .* (dragon|keychain|tealight|voronoi|fidget) .* (do|did|sell|sold|go|went))\b/i;
const POS_COMPARE_KEYWORDS = /\b(compare|comparison|vs|versus|compared to|last two|both stalls|stall.* differ|how did .* compare)\b/i;
const POS_EXPORT_KEYWORDS = /\b(export .*(stall|session|sales|pos|data)|download .*(stall|session|sales|report|pos)|get .*(csv|xlsx|file|export)|retrieve .*(csv|xlsx|file|export)|send .*(csv|xlsx|file)|grab .*(csv|xlsx|file)|(csv|xlsx) .*(for|from|of))\b/i;
const CHECKLIST_KEYWORDS = /\b(checklist|to-?do|task list|tasks?:|items? to do|action items?)\b/i;

export const aiService = {
  async chat(channelId: string, username: string, message: string): Promise<string> {
    try {
      const history = conversations.get(channelId) || [];
      history.push({ role: 'user', content: `${username}: ${message}`, timestamp: Date.now() });

      // Trim old entries
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }

      const messages: ChatMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      ];

      const reply = await chatCompletion(messages, { max_tokens: 512, temperature: 0.8 })
        ?? "hmm, my brain glitched for a sec. try again?";

      history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
      conversations.set(channelId, history);
      lastPipActivity.set(channelId, Date.now());

      return reply;
    } catch (err) {
      logger.error({ err }, 'Anthropic API error');
      return "something went wrong on my end, give me a moment and try again";
    }
  },

  async isRelevantFollowUp(channelId: string, message: string): Promise<boolean> {
    try {
      const history = conversations.get(channelId) || [];
      if (history.length === 0) return false;

      // Get last few messages for context
      const recent = history.slice(-6).map((h) => `${h.role === 'user' ? 'User' : 'Pip'}: ${h.content}`).join('\n');

      const answer = (await chatCompletion([
        { role: 'system', content: RELEVANCE_PROMPT },
        { role: 'user', content: `Recent conversation:\n${recent}\n\nNew message: "${message}"\n\nIs this message relevant to the ongoing conversation with Pip?` },
      ], { max_tokens: 8, temperature: 0.1 }))?.trim().toLowerCase() ?? 'no';
      return answer === 'yes';
    } catch (err) {
      logger.error({ err }, 'Relevance check error');
      return false;
    }
  },

  wasRecentlyActive(channelId: string): boolean {
    const last = lastPipActivity.get(channelId);
    if (!last) return false;
    return Date.now() - last < FOLLOW_UP_WINDOW_MS;
  },

  recordActivity(channelId: string) {
    lastPipActivity.set(channelId, Date.now());
  },

  // ── Intent detection ──────────────────────────────

  hasCalendarIntent(message: string): boolean {
    return CALENDAR_KEYWORDS.test(message);
  },

  hasCalendarReadIntent(message: string): boolean {
    return CALENDAR_READ_KEYWORDS.test(message);
  },

  hasSheetsIntent(message: string): boolean {
    return SHEETS_KEYWORDS.test(message);
  },

  hasProductCrudIntent(message: string): boolean {
    return PRODUCT_CRUD_KEYWORDS.test(message);
  },

  hasChecklistIntent(message: string): boolean {
    return CHECKLIST_KEYWORDS.test(message);
  },

  hasPosStallIntent(message: string): boolean {
    return POS_STALL_KEYWORDS.test(message);
  },

  hasPosProductQueryIntent(message: string): boolean {
    return POS_PRODUCT_QUERY_KEYWORDS.test(message);
  },

  hasPosCompareIntent(message: string): boolean {
    return POS_COMPARE_KEYWORDS.test(message);
  },

  hasPosExportIntent(message: string): boolean {
    return POS_EXPORT_KEYWORDS.test(message);
  },

  /** Extract a product name from a natural language query like "how many dragons did we sell" */
  async extractProductName(message: string): Promise<string | null> {
    try {
      const raw = await chatCompletion([
        {
          role: 'system',
          content: `You are a product name extraction system for a 3D printing company called ForgeRealm. They sell articulated dragons, keychains, tealight holders, voronoi designs, fidget toys, and other 3D printed items.\n\nExtract the product name or search term the user is asking about. Return ONLY the product name/keyword as plain text, nothing else. If you can't determine a product, return "NONE".`,
        },
        { role: 'user', content: message },
      ], { max_tokens: 64, temperature: 0.1 });

      if (!raw || raw.trim().toUpperCase() === 'NONE') return null;
      return raw.trim();
    } catch (err) {
      logger.error({ err }, 'Product name extraction error');
      return null;
    }
  },

  // ── Data extraction ───────────────────────────────

  async extractCalendarData(message: string): Promise<CalendarExtraction | null> {
    try {
      const today = new Date().toISOString().split('T')[0];
      const prompt = CALENDAR_EXTRACTION_PROMPT.replace('{{TODAY}}', today);

      const raw = await chatCompletion([
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ], { max_tokens: 1024, temperature: 0.1 });
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

  async extractSheetData(message: string): Promise<SheetExtraction | null> {
    try {
      const raw = await chatCompletion([
        { role: 'system', content: SHEETS_EXTRACTION_PROMPT },
        { role: 'user', content: message },
      ], { max_tokens: 2048, temperature: 0.1 });
      if (!raw) return null;

      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data = JSON.parse(cleaned) as SheetExtraction;

      if (!data.sheet || !data.sheet.headers || !data.sheet.rows) return null;
      if (!data.sheet.currencyColumns) data.sheet.currencyColumns = [];
      if (data.sheet.includeTotal === undefined) data.sheet.includeTotal = false;
      if (!data.reply) data.reply = "sheet's ready, here you go";

      return data;
    } catch (err) {
      logger.error({ err }, 'Sheet extraction error');
      return null;
    }
  },

  async extractProductAction(message: string): Promise<ProductExtraction | null> {
    try {
      const raw = await chatCompletion([
        { role: 'system', content: PRODUCT_EXTRACTION_PROMPT },
        { role: 'user', content: message },
      ], { max_tokens: 512, temperature: 0.1 });
      if (!raw) return null;

      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const data = JSON.parse(cleaned) as ProductExtraction;

      if (!data.action || !data.action.type || !data.action.name) return null;
      if (!data.reply) data.reply = "done";

      return data;
    } catch (err) {
      logger.error({ err }, 'Product extraction error');
      return null;
    }
  },

  clearHistory(channelId: string) {
    conversations.delete(channelId);
  },
};
