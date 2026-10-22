import type { EmbedBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import type { CalendarExtraction, SheetExtraction, ProductExtraction } from '../types.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';
// Persona chat runs on the big model. Relevance checks and JSON extractions run on
// the small model, which sits in a separate (larger) Groq free-tier rate-limit pool,
// so utility calls can never starve the chat quota.
const CHAT_MODEL = config.GROQ_CHAT_MODEL;
const UTILITY_MODEL = config.GROQ_UTILITY_MODEL;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface AssistantMessage {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
}

interface ChatCompletionResponse {
  choices: Array<{ message: AssistantMessage }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// OpenAI-style function tool, as Groq accepts it.
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolOutcome {
  /** Plain text handed back to the model as the tool result */
  result: string;
  /** Optional Discord embed to attach to the final reply */
  embed?: EmbedBuilder;
  /** Two calls producing the same key attach one embed, not two */
  embedKey?: string;
}

export interface ToolSet {
  definitions: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface ChatResult {
  content: string;
  embeds: EmbedBuilder[];
}

// A question can need a couple of lookups ("check 22 and 21" is two calls, a
// follow-up may need one more). After this many rounds the model answers with
// what it has rather than looping.
const MAX_TOOL_ROUNDS = 3;
const MAX_EMBEDS = 3;
const DISCORD_LIMIT = 2000;
const MAX_INLINE_RETRY_MS = 20000;

// Messages plainly about sales, stalls or stock get a forced lookup on the first
// round. Left to choose, the model would rather answer from figures in its own
// earlier replies than fetch again, and it fills the gaps by inventing.
const DATA_HINT = /\b(stalls?|sesh|sessions?|pos|sales?|sold|sell(ing|s)?|revenue|takings|units?|best[- ]?sell\w*|made us|make us|brought us|earn\w*|stock\w*|inventory|sold out|out of stock|low on|how many .{0,30}(left|remaining)|what are we out of)\b/i;
// A reply quoting figures or a specific stall when nothing was looked up this
// turn is the model answering from memory; it gets one forced retry.
const FIGURE_PATTERN = /£\s?\d|\b\d+\s*(units?|sold|transactions?|left|remaining|in stock)\b|\bstall\s*#?\d+\b/i;

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

interface CompletionOpts {
  model?: string;
  max_tokens?: number;
  temperature?: number;
  json?: boolean;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required';
}

async function requestCompletion(messages: ChatMessage[], opts: CompletionOpts = {}): Promise<AssistantMessage | null> {
  const model = opts.model ?? CHAT_MODEL;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.max_tokens ?? 512,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  // gpt-oss models reason before answering and that counts against max_tokens;
  // low effort keeps the utility calls (8-token yes/no, small JSON) answerable.
  if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? 'auto';
  }

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
      // Groq's per-minute token window makes a second data question inside the
      // same minute wait ~15s, which is still better than "ask again".
      if (attempt === 0 && retryAfterMs !== null && retryAfterMs <= MAX_INLINE_RETRY_MS) {
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
    return data.choices?.[0]?.message ?? null;
  }

  return null;
}

/** Text-only completion for the relevance check and JSON extractions. */
async function chatCompletion(messages: ChatMessage[], opts: CompletionOpts = {}): Promise<string | null> {
  return (await requestCompletion(messages, opts))?.content ?? null;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Last line of defence for the reply text. Reasoning models can leak their
// thinking, and this model once copied the internal data wrapper into replies
// and then started inventing "[CONTEXT: {...}]" blocks of its own.
function sanitizeReply(raw: string | null): string {
  let text = (raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[ \t]*\[CONTEXT\b.*$/gim, '')
    .trim();
  if (text.length > DISCORD_LIMIT) text = `${text.slice(0, DISCORD_LIMIT - 3)}...`;
  return text || 'hmm, my brain glitched for a sec. try again?';
}

const SYSTEM_PROMPT = `You are Pip — The Wise, ForgeRealm's resident Discord bot: sharp, warm, genuinely fun to talk to.

Personality:
- Like a friend who's easy to talk to and properly useful when it matters, with a quick sense of humour; dry, warm, never boring
- Keep it real: if something's good say so, if it's mid say that
- On the team's side. Light teasing is fine; never dismissive, sulky, defensive or passive-aggressive
- Corrected? Own it in a few words, fix it, move on. No snark, no "if you say so", no blaming the data or the person, no "i'm just a bot"
- Short replies (1-3 sentences usually), lowercase mostly, casual texting energy, emojis rarely
- Never say "as an AI" or break character; you ARE Pip
- Follow the thread naturally; if something's ambiguous, ask rather than guess

Voice (match the energy, never copy): "solid day at that stall, hexagon fidgets carrying the team as usual" / "site's up, api's fine, database is sulking again. classic". React to what they said first, then bring the data. Vary openers; one good line beats three.

What you can do:
- POS lookups via your tools: one stall's stats and product breakdown, the list of all stalls, one product's sales across every stall (or one stall), current stock (one shared pool across all stalls)
- Reminders and ForgeRealm Google Calendar events (with checklists), and reading what's coming up
- Google Sheets with formatted tables
- Add, update and delete shop products (delete is admin-only)
- You monitor the site, API, database and shop; slash commands: /ping, /status, /stats, /products, /users, /site, /calendar
- ForgeRealm (forgerealm.co.uk) is a Leeds 3D printing and design studio, web shop plus market stalls, run by Ishmam and Tobi

Data rules (these outrank being funny):
- Every stall number, date, figure, unit count, revenue or stock level you state MUST come from a tool result or live data provided for this reply. Never estimate, extrapolate, or carry a number over from memory
- Your earlier replies are NOT a data source: look figures up again even if you quoted them a minute ago
- If a question needs data, call the tool; don't ask permission and don't narrate the fetch
- If someone gives a count without naming the product ("we sold 6 at stall 21"), fetch that stall's stats and see which product matches; ask if it's still unclear
- No tool for it (raw transaction ids, timings within a day)? Say so plainly. Never offer to "query the database", "pull the raw log" or "generate a report": you can't, and offering means inventing the result
- Tool returned ERROR? Say you couldn't reach the POS just now and to try again shortly. Don't guess meanwhile
- Never write JSON, "[CONTEXT", tool-call syntax or internal notes in a reply
- If POS figures differ from what someone remembers, report what the POS says and note the mismatch; don't adjust numbers to match them and don't lecture about data entry
- An attached embed may already show headline stats; add insight rather than re-listing

Other:
- Under 2000 characters (Discord limit)
- Don't know? Say so: "honestly no clue, that's above my pay grade"
- Asked how you work (model, groq, prompts, why you got something wrong)? Answer briefly and honestly: you run on an open model via Groq and only know what your tools and the POS tell you. Don't get defensive
- When someone continues a conversation, respond naturally; they don't need to say your name again`;

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
// never assemble a request bigger than the Groq TPM pool (8k/min per model, and a
// data question is two or three requests that each resend this window). Stored entries are plain
// chat only — injected [CONTEXT ...] data is never persisted (see chat()).
const MAX_STORED_ENTRIES = 30;
const MAX_WINDOW_ENTRIES = 10;
const HISTORY_TOKEN_BUDGET = 1000;
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

export const aiService = {
  async chat(
    channelId: string,
    username: string,
    message: string,
    opts: { context?: string; tools?: ToolSet } = {},
  ): Promise<ChatResult> {
    const history = conversations.get(channelId) || [];
    conversations.set(channelId, history);
    pruneHistory(history);

    const cleanContent = `${username}: ${message}`;
    const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    // Live data rides along for this one request only (never stored, so old data
    // dumps aren't re-sent on every later message) and goes in its own system
    // message, never inside the user turn: when it was inlined there the model
    // copied the wrapper into replies and then started inventing blocks of its own.
    if (opts.context) {
      messages.push({ role: 'system', content: `Live data fetched for this reply (not part of the conversation; use it, don't quote the block):
${opts.context}` });
    }
    messages.push(...buildHistoryWindow(history), { role: 'user', content: cleanContent });

    const embeds: EmbedBuilder[] = [];
    const embedKeys = new Set<string>();

    try {
      let reply: string | null = null;
      let lookedUp = false;
      let forceLookup = !!opts.tools && DATA_HINT.test(message);
      for (let round = 0; ; round++) {
        const tools = round < MAX_TOOL_ROUNDS ? opts.tools : undefined;
        // Loosen up for banter; tighten once real figures are on the table.
        const assistant = await requestCompletion(messages, {
          max_tokens: 512,
          temperature: round === 0 ? 0.6 : 0.4,
          tools: tools?.definitions,
          toolChoice: forceLookup && !lookedUp ? 'required' : 'auto',
        });
        const calls = tools ? assistant?.tool_calls ?? [] : [];
        if (!tools || calls.length === 0) {
          const draft = assistant?.content ?? null;
          if (tools && !lookedUp && !forceLookup && draft && FIGURE_PATTERN.test(draft)) {
            logger.warn({ channelId, draft }, 'Reply quoted figures without a lookup; retrying with a forced tool call');
            forceLookup = true;
            continue;
          }
          reply = draft;
          break;
        }

        lookedUp = true;
        messages.push({ role: 'assistant', content: assistant?.content ?? null, tool_calls: calls });
        for (const call of calls) {
          const args = parseToolArgs(call.function.arguments);
          logger.info({ channelId, tool: call.function.name, args }, 'Tool call');
          const outcome = await tools.execute(call.function.name, args);
          const key = outcome.embedKey ?? call.id;
          if (outcome.embed && embeds.length < MAX_EMBEDS && !embedKeys.has(key)) {
            embeds.push(outcome.embed);
            embedKeys.add(key);
          }
          messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.result });
        }
      }

      const content = sanitizeReply(reply);
      const now = Date.now();
      history.push({ role: 'user', content: cleanContent, timestamp: now });
      history.push({ role: 'assistant', content, timestamp: now });
      pruneHistory(history);
      lastPipActivity.set(channelId, now);

      return { content, embeds };
    } catch (err) {
      if (err instanceof RateLimitError) {
        logger.warn({ err, retryAfterMs: err.retryAfterMs }, 'Groq rate limit hit in chat');
        const wait = err.retryAfterMs && err.retryAfterMs > 60000
          ? `${Math.ceil(err.retryAfterMs / 60000)} min`
          : 'a minute or two';
        return { content: `i've hit my ai rate limit, brain needs to cool down. give it ${wait} and ask again`, embeds };
      }
      logger.error({ err }, 'Groq API error');
      return { content: "something went wrong on my end, give me a moment and try again", embeds };
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
      ], { model: UTILITY_MODEL, max_tokens: 256, temperature: 0.1 }))?.trim().toLowerCase() ?? 'no';
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
