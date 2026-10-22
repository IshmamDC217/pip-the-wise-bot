import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const BASE = config.POS_URL;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let loginInFlight: Promise<string> | null = null;

export interface POSSession {
  id: string;
  name: string;
  location: string | null;
  date: string;
  notes: string | null;
  status: string;
  total_revenue?: number | string;
  total_units?: number | string;
  created_at: string;
}

export interface POSSessionDetail extends POSSession {
  stats: {
    total_revenue: number | string;
    total_units: number | string;
    total_sales: number | string;
    best_seller: string | null;
  };
}

interface POSSale {
  id: string;
  session_id: string;
  product_id: string;
  quantity: number;
  price_charged: string;
  payment_method: string;
  product_name: string;
  product_category: string | null;
  timestamp: string;
}

// GET /api/global-stock. Stock is one shared pool: this quantity is what's left
// across every stall, and any stall's sale draws it down. Products without a
// stock row are untracked and sell uncapped.
interface POSGlobalStockItem {
  product_id: string;
  product_name: string;
  product_category: string | null;
  default_price: string;
  quantity: number | string;
  tracked: boolean;
}

// The API returns full ISO timestamps; users and the LLM want a plain date.
function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB');
}

const money = (n: number) => `£${n.toFixed(2)}`;

// Bound the per-product lines injected into LLM context. The catalogue is ~70
// products, so this never triggers in practice; it exists so a pathological
// session can't blow the token budget.
const MAX_SUMMARY_ITEMS = 60;

// Short-lived response cache: one user question fans out into several posGet calls
// (sessions, detail, sales) and the embed path used to re-fetch the same session.
// 45s keeps rapid-fire queries free without ever serving stale stall data.
const CACHE_TTL_MS = 45000;
// Sales for a closed stall only change if someone edits history, so they can sit
// in the cache much longer. An all-stalls product total touches every session.
const CLOSED_SALES_TTL_MS = 10 * 60 * 1000;
const responseCache = new Map<string, { at: number; data: unknown }>();

// How many sessions' sales to fetch at once for an all-stalls total. The POS is
// on Netlify functions; a burst of 20+ parallel requests is what gets throttled.
const SALES_FETCH_CONCURRENCY = 4;

async function login(): Promise<string> {
  if (!config.POS_USERNAME || !config.POS_PASSWORD) {
    throw new Error('POS credentials not configured (POS_USERNAME / POS_PASSWORD)');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: config.POS_USERNAME,
        password: config.POS_PASSWORD,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`POS auth failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as { token: string };
    cachedToken = data.token;
    // Token expires in 7 days, cache for 6
    tokenExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
    return cachedToken;
  } finally {
    clearTimeout(timeout);
  }
}

async function authenticate(): Promise<string> {
  // Reuse cached token if still valid (with 1-hour buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 3600000) {
    return cachedToken;
  }

  // Single-flight: concurrent messages while the token is cold share one login.
  if (!loginInFlight) {
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

function invalidateToken() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

async function posGet<T>(path: string, ttlMs = CACHE_TTL_MS): Promise<T> {
  const cached = responseCache.get(path);
  if (cached && Date.now() - cached.at < ttlMs) {
    return cached.data as T;
  }

  let token = await authenticate();

  // One retry for transient failures; a 401 forces a fresh login first, so the bot
  // recovers from a POS redeploy / token rotation without a restart.
  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (res.status === 401 && attempt === 0) {
        await res.text().catch(() => '');
        logger.warn({ path }, 'POS token rejected, re-authenticating');
        invalidateToken();
        token = await authenticate();
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`POS GET ${path} failed (${res.status}): ${body}`);
      }

      const data = (await res.json()) as T;
      responseCache.set(path, { at: Date.now(), data });
      return data;
    } catch (err: any) {
      const transient = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      if (attempt === 0 && transient) {
        logger.warn({ path, attempt }, 'POS request timed out, retrying');
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`POS GET ${path} failed after retries`);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// "hexagon fidgets" has to find "Hexagon Fidget": compare lowercase alphanumerics
// with a trailing s dropped from each word, in either direction.
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
    .join(' ');
}

function productMatches(productName: string, query: string): boolean {
  const a = normaliseName(productName);
  const b = normaliseName(query);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

function stallNumber(name: string): string | null {
  return name.match(/\bstall\s*#?(\d+)\b/i)?.[1] ?? null;
}

function describeSession(s: POSSession): string {
  return `"${s.name}" (${formatDate(s.date)}${s.location ? `, ${s.location}` : ''})`;
}

export const posService = {
  /** Check if POS credentials are configured */
  isConfigured(): boolean {
    return !!(config.POS_USERNAME && config.POS_PASSWORD);
  },

  /** Get all sessions (stalls), newest first */
  async getSessions(): Promise<POSSession[]> {
    return posGet<POSSession[]>('/api/sessions');
  },

  /** Get a single session with detailed stats */
  async getSession(id: string): Promise<POSSessionDetail> {
    return posGet<POSSessionDetail>(`/api/sessions/${id}`);
  },

  /** Get sales for a session */
  async getSessionSales(session: Pick<POSSession, 'id' | 'status'>): Promise<POSSale[]> {
    const ttl = session.status === 'active' ? CACHE_TTL_MS : CLOSED_SALES_TTL_MS;
    return posGet<POSSale[]>(`/api/sales/session/${session.id}`, ttl);
  },

  /** Current shared stock pool, every product */
  async getGlobalStock(): Promise<POSGlobalStockItem[]> {
    return posGet<POSGlobalStockItem[]>('/api/global-stock');
  },

  /**
   * Resolve "23" / "stall 23" / "kirkgate" to a session. Exact-number matching:
   * "stall 1" must never resolve to "Stall 13".
   */
  findSession(sessions: POSSession[], ref: string): POSSession | null {
    const num = ref.match(/\d+/)?.[0];
    if (num && /^\s*(stall\s*#?)?\d+\s*$/i.test(ref)) {
      return sessions.find(s => stallNumber(s.name) === num) ?? null;
    }
    const needle = ref.trim().toLowerCase();
    if (!needle) return null;
    return sessions.find(s =>
      s.name.toLowerCase().includes(needle) || (s.location ?? '').toLowerCase().includes(needle),
    ) ?? null;
  },

  /**
   * Build a text summary of one session (the most recent when no id is given)
   * for the AI: headline stats, per-product breakdown and the cash/card split.
   */
  async buildSessionSummary(sessionId?: string): Promise<string> {
    try {
      let session: POSSessionDetail;

      if (sessionId) {
        session = await this.getSession(sessionId);
      } else {
        const sessions = await this.getSessions();
        if (sessions.length === 0) return 'No sessions found in the POS system.';
        session = await this.getSession(sessions[0].id);
      }

      const stats = session.stats;
      const lines: string[] = [
        `Session: "${session.name}"`,
        `Date: ${formatDate(session.date)}`,
        session.location ? `Location: ${session.location}` : null,
        `Status: ${session.status}`,
        `Total Revenue: ${money(Number(stats.total_revenue))}`,
        `Total Units Sold: ${stats.total_units}`,
        `Total Sales (transactions): ${stats.total_sales}`,
        stats.best_seller ? `Best Seller: ${stats.best_seller}` : null,
      ].filter(Boolean) as string[];

      const sales = await this.getSessionSales(session);
      if (sales.length > 0) {
        const productTotals = new Map<string, { units: number; revenue: number; cash: number; card: number }>();
        for (const sale of sales) {
          const existing = productTotals.get(sale.product_name) || { units: 0, revenue: 0, cash: 0, card: 0 };
          const amount = parseFloat(sale.price_charged) * sale.quantity;
          existing.units += sale.quantity;
          existing.revenue += amount;
          if (sale.payment_method === 'cash') existing.cash += amount;
          else existing.card += amount;
          productTotals.set(sale.product_name, existing);
        }

        // One line per product keeps a 30-product stall around 400 tokens; the
        // cash/card split is reported once for the whole stall below.
        lines.push('', 'Product Breakdown (units sold, highest first):');
        const entries = [...productTotals.entries()].sort((a, b) => b[1].units - a[1].units);
        for (const [name, data] of entries.slice(0, MAX_SUMMARY_ITEMS)) {
          lines.push(`  - ${name}: ${data.units} units, ${money(data.revenue)}`);
        }
        if (entries.length > MAX_SUMMARY_ITEMS) {
          lines.push(`  ...and ${entries.length - MAX_SUMMARY_ITEMS} more products`);
        }

        const totalCash = entries.reduce((s, [, d]) => s + d.cash, 0);
        const totalCard = entries.reduce((s, [, d]) => s + d.card, 0);
        lines.push('', `Payment Split: Cash ${money(totalCash)} | Card ${money(totalCard)}`);
      } else {
        lines.push('', 'No individual sales recorded for this session.');
      }

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build POS session summary');
      throw err;
    }
  },

  /**
   * One product's units and revenue, totalled across every stall (or one stall).
   * Fetches each session's sales: the POS has no cross-session product endpoint.
   */
  async buildProductSalesSummary(productQuery: string, stallRef?: string): Promise<string> {
    try {
      const sessions = await this.getSessions();
      if (sessions.length === 0) return 'No sessions found in the POS system.';

      let targets = sessions;
      if (stallRef) {
        const match = this.findSession(sessions, stallRef);
        if (!match) {
          return `No stall matching "${stallRef}" in the POS. Known stalls (newest first): ${sessions.slice(0, 10).map(s => s.name).join(', ')}.`;
        }
        targets = [match];
      }

      const salesBySession = await mapLimit(targets, SALES_FETCH_CONCURRENCY, s => this.getSessionSales(s));

      const matchedProducts = new Map<string, { units: number; revenue: number }>();
      const perSession: Array<{ session: POSSession; units: number; revenue: number }> = [];
      const seenProducts = new Set<string>();

      targets.forEach((session, i) => {
        let units = 0;
        let revenue = 0;
        for (const sale of salesBySession[i]) {
          seenProducts.add(sale.product_name);
          if (!productMatches(sale.product_name, productQuery)) continue;
          const amount = parseFloat(sale.price_charged) * sale.quantity;
          units += sale.quantity;
          revenue += amount;
          const p = matchedProducts.get(sale.product_name) || { units: 0, revenue: 0 };
          p.units += sale.quantity;
          p.revenue += amount;
          matchedProducts.set(sale.product_name, p);
        }
        perSession.push({ session, units, revenue });
      });

      const scope = stallRef ? `at ${describeSession(targets[0])}` : `across all ${targets.length} stalls in the POS`;

      if (matchedProducts.size === 0) {
        const known = [...seenProducts].slice(0, 25).join(', ');
        return `No sales recorded for any product matching "${productQuery}" ${scope}. Products with recorded sales there: ${known || 'none'}.`;
      }

      const names = [...matchedProducts.keys()];
      const lines = [`Sales of ${names.map(n => `"${n}"`).join(' + ')} ${scope}:`];

      const sold = perSession.filter(p => p.units > 0);
      for (const { session, units, revenue } of sold) {
        lines.push(`  - ${describeSession(session)}: ${units} units, ${money(revenue)}`);
      }
      const none = perSession.filter(p => p.units === 0).map(p => p.session.name);
      if (none.length > 0) lines.push(`  - no sales of it at: ${none.join(', ')}`);

      const totalUnits = sold.reduce((s, p) => s + p.units, 0);
      const totalRevenue = sold.reduce((s, p) => s + p.revenue, 0);
      lines.push('', `TOTAL: ${totalUnits} units, ${money(totalRevenue)} (sold at ${sold.length} of ${targets.length} stalls)`);

      if (names.length > 1) {
        lines.push(`Note: "${productQuery}" matched ${names.length} products and the figures above combine them. Per product: ${names.map(n => {
          const p = matchedProducts.get(n)!;
          return `${n} ${p.units} units / ${money(p.revenue)}`;
        }).join('; ')}`);
      }

      return lines.join('\n');
    } catch (err) {
      logger.error({ err, productQuery, stallRef }, 'Failed to build product sales summary');
      throw err;
    }
  },

  /** Current shared stock levels, optionally narrowed to products matching a name */
  async buildStockSummary(productQuery?: string): Promise<string> {
    try {
      const items = await this.getGlobalStock();
      if (items.length === 0) return 'The POS catalogue is empty.';

      const describe = (i: POSGlobalStockItem) =>
        i.tracked
          ? `  - ${i.product_name}: ${Number(i.quantity)} left (${money(Number(i.default_price))})`
          : `  - ${i.product_name}: not stock-tracked, sells uncapped (${money(Number(i.default_price))})`;

      if (productQuery) {
        const hits = items.filter(i => productMatches(i.product_name, productQuery));
        if (hits.length === 0) return `No product matching "${productQuery}" in the POS catalogue.`;
        return [`Shared stock (one pool across all stalls) for products matching "${productQuery}":`, ...hits.map(describe)].join('\n');
      }

      const tracked = items.filter(i => i.tracked);
      const untracked = items.length - tracked.length;
      const outOfStock = tracked.filter(i => Number(i.quantity) <= 0);
      const lowStock = tracked.filter(i => Number(i.quantity) > 0 && Number(i.quantity) <= 3);

      const lines = ['Shared stock pool (one count across all stalls, drops live as any stall records a sale):'];
      if (outOfStock.length > 0) lines.push(`  OUT OF STOCK: ${outOfStock.map(i => i.product_name).join(', ')}`);
      if (lowStock.length > 0) lines.push(`  LOW STOCK (3 or fewer left): ${lowStock.map(i => `${i.product_name} (${Number(i.quantity)})`).join(', ')}`);
      for (const item of tracked.slice(0, MAX_SUMMARY_ITEMS)) lines.push(describe(item));
      if (tracked.length > MAX_SUMMARY_ITEMS) lines.push(`  ...and ${tracked.length - MAX_SUMMARY_ITEMS} more tracked products`);
      lines.push(`  Totals: ${tracked.reduce((s, i) => s + Number(i.quantity), 0)} units across ${tracked.length} tracked products; ${untracked} products are not stock-tracked.`);

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build stock summary');
      throw err;
    }
  },

  /** Build a summary of all sessions for overview queries */
  async buildAllSessionsSummary(): Promise<string> {
    try {
      const sessions = await this.getSessions();
      if (sessions.length === 0) return 'No sessions found in the POS system.';

      // Every stall, one compact line each: "which was our best stall" needs the
      // whole list, and 60 lines is still only ~1.2k tokens.
      const lines: string[] = [`ForgeRealm POS — ${sessions.length} stall(s), newest first (name | date | location | revenue | units | status):`];
      for (const s of sessions.slice(0, MAX_SUMMARY_ITEMS)) {
        const rev = s.total_revenue != null ? money(Number(s.total_revenue)) : '£0.00';
        const units = s.total_units != null ? `${s.total_units}` : '0';
        lines.push(`  - ${s.name} | ${formatDate(s.date)} | ${s.location ?? '-'} | ${rev} | ${units} units | ${s.status}`);
      }
      if (sessions.length > MAX_SUMMARY_ITEMS) lines.push(`  ... and ${sessions.length - MAX_SUMMARY_ITEMS} older stalls not shown`);

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build POS sessions summary');
      throw err;
    }
  },
};
