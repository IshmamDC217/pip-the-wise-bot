import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { CalendarExtraction, SheetExtraction, ProductExtraction } from '../types.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
// Persona chat runs on the big model. Relevance checks and JSON extractions run on
// the small model, which sits in a separate (larger) Groq free-tier rate-limit pool,
// so utility calls can never starve the chat quota.
const CHAT_MODEL = config.GROQ_CHAT_MODEL;
const UTILITY_MODEL = config.GROQ_UTILITY_MODEL;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class RateLimitError extends Error {
  retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Usage tracking (per model, reset daily) ─────────
interface ModelUsage {
  requests: number;
  tokens: number;
  since: number;
}

const usageByModel = new Map<string, ModelUsage>();
const USAGE_RESET_MS = 24 * 60 * 60 * 1000;

function recordUsage(model: string, usage: ChatCompletionResponse['usage']) {
  const now = Date.now();
  let entry = usageByModel.get(model);
  if (!entry || now - entry.since > USAGE_RESET_MS) {
    entry = { requests: 0, tokens: 0, since: now };
    usageByModel.set(model, entry);
  }
  entry.requests += 1;
  entry.tokens += usage?.total_tokens ?? 0;
  logger.info(
    { model, requestTokens: usage?.total_tokens ?? 0, dayTokens: entry.tokens, dayRequests: entry.requests },
    'Groq usage',
  );
}

function parseRetryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = parseFloat(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chatCompletion(
  messages: ChatMessage[],
  opts: { model?: string; max_tokens?: number; temperature?: number; json?: boolean } = {},
): Promise<string | null> {
  const model = opts.model ?? CHAT_MODEL;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.max_tokens ?? 512,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res: Response;
    try {
      res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.GROQ_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res);
      await res.text().catch(() => '');
      // Short waits (burst TPM limits) are worth riding out once; anything longer
      // (daily quota) surfaces to the caller so the user gets an honest answer.
      if (attempt === 0 && retryAfterMs !== null && retryAfterMs <= 8000) {
        logger.warn({ model, retryAfterMs }, 'Groq rate limited, retrying after wait');
        await sleep(retryAfterMs);
        continue;
      }
      throw new RateLimitError(`Groq 429 on ${model}`, retryAfterMs);
    }

    if (res.status >= 500 && attempt === 0) {
      await res.text().catch(() => '');
      logger.warn({ model, status: res.status }, 'Groq server error, retrying once');
      await sleep(2000);
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Groq ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    recordUsage(model, data.usage);
    return data.choices?.[0]?.message?.content ?? null;
  }

  return null;
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

Voice — match this energy, never copy these verbatim:
- "sold 31 units at stall 13, hexagon fidgets carrying the team as usual"
- "reminder set for friday 18:00. i'd say don't forget but that's literally my job now"
- "site's up, api's fine, database is sulking again. classic"
- React to what the person actually said first, then bring the data
- Vary your openers — never start two replies in a row the same way
- One good line lands harder than three; don't pad

Knowledge:
- ForgeRealm (forgerealm.co.uk) is a web platform with a shop for digital products
- You monitor the site, API, database, and shop activity
- The site is built with Astro + React, the backend is Express.js, database is MySQL
- You know the slash commands: /ping, /status, /stats, /products, /users, /site, /calendar
- You can set reminders, add events (with checklists) to the ForgeRealm Google Calendar, and read it to say what's coming up
- You can create Google Sheets with formatted tables (items, prices, etc.)
- You can manage products in the shop — add, update, and delete (delete requires admin)
- You have access to the ForgeRealm POS (Point of Sale) system — stall/event session data, sales figures, revenue breakdowns, best sellers, stock levels, and payment method splits
- When a message includes a [CONTEXT ...] block, that data was fetched live for THIS reply — trust it over anything you remember from earlier in the conversation, and don't mention the block itself

Rules:
- Keep responses under 2000 characters (Discord limit)
- If someone asks something you don't know, say so — "honestly no clue, that's above my pay grade"
- Don't make up information about ForgeRealm's products, sales numbers, or users — if the data isn't in front of you, say you'd need to check
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

const CALENDAR_EXTRACTION_PROMPT = `You are a date/event extraction system. Right now it is {{NOW}} (Europe/London).

Extract calendar events and reminders from the user's message. Return ONLY valid JSON with this exact structure:
{
  "events": [
    { "summary": "Event name", "date": "YYYY-MM-DD", "allDay": true, "time": null, "checklist": null }
  ],
  "reminders": [
    { "message": "What to remember", "dueDate": "YYYY-MM-DD", "time": "HH:MM" }
  ],
  "reply": "A short casual confirmation message in Pip's style (lowercase, friendly, 1-3 sentences)"
}

Rules:
- Dates MUST be in YYYY-MM-DD format, times in "HH:MM" 24-hour format with zero-padded hours
- Events: if a time is mentioned, set allDay to false and fill time; otherwise allDay true, time null
- Reminders: if the user gives a time ("at 6pm", "this evening"), set time; otherwise time null (it defaults to 9am)
- RELATIVE times ("tonight", "tomorrow morning", "this evening"): compute the actual date and time from the current date/time above. "tonight" = 19:00 TODAY (the current date, not tomorrow), "morning" = 09:00, "afternoon" = 14:00, "evening" = 19:00. Only move to the next day when the phrase says tomorrow or the computed time has already passed today
- If the user mentions a checklist, to-do list, or multiple tasks for an event, include them in the "checklist" array as strings
- "before the 12th" or "by the 12th" means the reminder date IS the 12th (deadline day)
- "remind me on the 10th" means dueDate is the 10th
- The reply must state the RESOLVED day and time so the user can catch mistakes, e.g. "sorted, i'll ping you friday at 18:00 about the float"
- If the year isn't specified, assume the current year or next occurrence
- If the message contains no actual event or reminder, return empty arrays
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

// History is budgeted by estimated tokens, not just entry count, so one channel can
// never assemble a request bigger than the Groq TPM pool. Stored entries are plain
// chat only — injected [CONTEXT ...] data is never persisted (see chat()).
const MAX_STORED_ENTRIES = 30;
const MAX_WINDOW_ENTRIES = 16;
const HISTORY_TOKEN_BUDGET = 1800;
const HISTORY_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const FOLLOW_UP_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function pruneHistory(history: ConversationEntry[]) {
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  while (history.length > 0 && (history.length > MAX_STORED_ENTRIES || history[0].timestamp < cutoff)) {
    history.shift();
  }
}

/** Newest entries first, walking back until the token budget or entry cap is hit. */
function buildHistoryWindow(history: ConversationEntry[]): ChatMessage[] {
  const window: ChatMessage[] = [];
  let budget = HISTORY_TOKEN_BUDGET;
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;

  for (let i = history.length - 1; i >= 0 && window.length < MAX_WINDOW_ENTRIES; i--) {
    const entry = history[i];
    if (entry.timestamp < cutoff) break;
    const cost = estimateTokens(entry.content);
    if (cost > budget && window.length > 0) break;
    budget -= cost;
    window.unshift({ role: entry.role, content: entry.content });
    if (budget <= 0) break;
  }

  return window;
}

// Cheap lexical signals that a SHORT message is a direct follow-up to Pip, so the
// most common cases skip the LLM call. Deliberately narrow: broad words like
// "why"/"and"/"lol" appear constantly in human side-conversations, and matching
// them would make Pip butt in uninvited. Longer or ambiguous messages still go
// through the (cheap, 8B) relevance check, which is prompted to filter side talk.
const FOLLOW_UP_STARTERS = /^(yes|yeah|yep|yup|no|nah|nope|ok(ay)?|thanks|thank you|ty|sure|please do|do it|go on|what about|how about)\b/i;
const FOLLOW_UP_MAX_LENGTH = 20;

const CALENDAR_KEYWORDS = /\b(remind(er)?s?\b|schedule (a|an|the|it|that|this)?\b|calendar|meeting|appointment|deadline|due (on|by|date)|book (a|an|the|us|me)\b|(add|create|set up|new) (an? )?event)/i;
const CALENDAR_READ_KEYWORDS = /\b(what['’]?s coming up|what is coming up|upcoming (events?|reminders?|meetings?)|my schedule|(any|got any|do (i|we) have any) (events?|reminders?|meetings?|appointments?)|what['’]?s on (the |my )?calendar|check (the |my )?(calendar|schedule|reminders)|(show|list) (the |my )?(calendar|schedule|events|reminders)|events? (this|next) (week|month|weekend)|what['’]?s planned|anything (scheduled|planned|on the calendar|on my calendar|coming up)|what['’]?s (the |my )?(schedule|calendar)|what(['’]?s| is) (on |happening )(this |next )?(week|month|weekend|saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b)/i;
const SHEETS_KEYWORDS = /\b(spreadsheet|google sheet|make a sheet|create a sheet|list out|price list|table of|itemize|itemise|put (it |that |this |them )?in a sheet|sheet with)\b/i;
const PRODUCT_CRUD_KEYWORDS = /\b(add (a |new )?product|create (a |new )?product|delete (the |a )?product|remove (the |a )?product|update (the |a )?product|change (the )?price|change (the )?stock|modify (the |a )?product)\b/i;
const POS_KEYWORDS = /\b(pos|point of sale|stall (performance|sales|revenue|report|stats|summary|data|numbers|\d+)|how did (we|the stall|the event|the market) (do|perform|go|sell)|how much (did|has) (we|the stall|the market|the event) ?(make|made|sell|sold|earn(ed)?|take)|sales (report|data|summary|numbers|today|yesterday|last|this)|revenue (report|today|yesterday|last|this)|stall (report|recap|breakdown)|what did (we|the stall) (make|sell|earn)|cash vs card|payment (split|breakdown)|best[- ]sell(er|ers|ing)|stock (report|summary|level|check|count)|how many did we sell|total (sales|revenue|units)|all (stalls|sessions|events)|session(s)? (list|overview|history)|most (stock|products|items)|check (the )?pos|check (the )?stall)\b/i;
// Stock questions need stock-ish context: bare "left" / "out of" / "remaining" used to
// misfire on ordinary chat ("he just left", "out of curiosity") and trigger POS fetches.
const STOCK_KEYWORDS = /\b(stock\b|inventory|restock|sold out|out of stock|left in stock|are we (out of|low on|running (low|out))|what are we (out of|low on)|(how many|how much) [\w\s'’-]{0,40}(left|remaining|in stock)|do we have any [\w\s'’-]{0,40}(left|in stock)|running (low|out) on)/i;

export const aiService = {
  async chat(
    channelId: string,
    username: string,
    message: string,
    opts: { context?: string } = {},
  ): Promise<string> {
    const history = conversations.get(channelId) || [];
    conversations.set(channelId, history);
    pruneHistory(history);

    const cleanContent = `${username}: ${message}`;
    // Context rides along for this one request only — it is never stored, so old
    // data dumps stop being re-sent (and re-billed) on every later message.
    const outbound = opts.context
      ? `[CONTEXT — live data fetched for this reply, not part of the conversation:\n${opts.context}]\n${cleanContent}`
      : cleanContent;

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...buildHistoryWindow(history),
      { role: 'user', content: outbound },
    ];

    try {
      const reply = await chatCompletion(messages, { max_tokens: 512, temperature: 0.8 })
        ?? "hmm, my brain glitched for a sec. try again?";

      const now = Date.now();
      history.push({ role: 'user', content: cleanContent, timestamp: now });
      history.push({ role: 'assistant', content: reply, timestamp: now });
      pruneHistory(history);
      lastPipActivity.set(channelId, now);

      return reply;
    } catch (err) {
      if (err instanceof RateLimitError) {
        logger.warn({ err, retryAfterMs: err.retryAfterMs }, 'Groq rate limit hit in chat');
        const wait = err.retryAfterMs && err.retryAfterMs > 60000
          ? `${Math.ceil(err.retryAfterMs / 60000)} min`
          : 'a minute or two';
        return `i've hit my ai rate limit, brain needs to cool down. give it ${wait} and ask again`;
      }
      logger.error({ err }, 'Groq API error');
      return "something went wrong on my end, give me a moment and try again";
    }
  },

  async isRelevantFollowUp(channelId: string, message: string): Promise<boolean> {
    const history = conversations.get(channelId) || [];
    if (history.length === 0) return false;

    const trimmed = message.trim();
    if (trimmed.length < 2) return false;
    if (trimmed.length <= FOLLOW_UP_MAX_LENGTH && FOLLOW_UP_STARTERS.test(trimmed)) return true;

    try {
      const recent = history.slice(-4).map((h) => `${h.role === 'user' ? 'User' : 'Pip'}: ${h.content}`).join('\n');

      const answer = (await chatCompletion([
        { role: 'system', content: RELEVANCE_PROMPT },
        { role: 'user', content: `Recent conversation:\n${recent}\n\nNew message: "${message}"\n\nIs this message relevant to the ongoing conversation with Pip?` },
      ], { model: UTILITY_MODEL, max_tokens: 8, temperature: 0.1 }))?.trim().toLowerCase() ?? 'no';
      return answer.startsWith('yes');
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

  /** Rolling daily Groq usage per model, for the admin "pip usage" check. */
  getUsageStats(): Array<{ model: string; requests: number; tokens: number; since: number }> {
    return [...usageByModel.entries()].map(([model, u]) => ({ model, ...u }));
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

  hasPosIntent(message: string): boolean {
    return POS_KEYWORDS.test(message);
  },

  hasStockIntent(message: string): boolean {
    return STOCK_KEYWORDS.test(message);
  },

  // ── Data extraction ───────────────────────────────

  async extractCalendarData(message: string): Promise<CalendarExtraction | null> {
    try {
      // Local wall-clock time (not UTC) so "tomorrow" resolves correctly around
      // midnight during BST and relative asks ("in 2 hours") can be computed.
      const now = new Date();
      const weekday = now.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });
      const stamp = now.toLocaleString('sv-SE', { timeZone: 'Europe/London' }).slice(0, 16);
      const prompt = CALENDAR_EXTRACTION_PROMPT.replace('{{NOW}}', `${weekday} ${stamp}`);

      const raw = await chatCompletion([
        { role: 'system', content: prompt },
        { role: 'user', content: message },
      ], { model: UTILITY_MODEL, max_tokens: 1024, temperature: 0.1, json: true });
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
      ], { model: UTILITY_MODEL, max_tokens: 2048, temperature: 0.1, json: true });
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
      ], { model: UTILITY_MODEL, max_tokens: 512, temperature: 0.1, json: true });
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
