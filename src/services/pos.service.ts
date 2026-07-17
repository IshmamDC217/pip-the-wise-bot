import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const BASE = config.POS_URL;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let loginInFlight: Promise<string> | null = null;

interface POSSession {
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

interface POSSessionDetail extends POSSession {
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

interface POSStockSummary {
  items: Array<{
    product_id: string;
    product_name: string;
    product_category: string | null;
    default_price: string;
    initial_quantity: number;
    final_quantity: number | null;
    total_sold: number | string;
    total_revenue: string;
    sold_by_count: number | null;
    sold_by_pos: number;
    sold: number;
    remaining: number;
  }>;
  totals: {
    initial: number;
    sold: number;
    remaining: number;
    revenue: number | string;
    has_final_counts: boolean;
  };
}

// The API returns full ISO timestamps; users and the LLM want a plain date.
function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB');
}

// Bound the per-product lines injected into LLM context. The catalogue is ~70
// products and stock-tracked sessions run ~35 items, so this never triggers in
// practice; it exists so a pathological session can't blow the token budget.
const MAX_SUMMARY_ITEMS = 60;

// Short-lived response cache: one user question fans out into several posGet calls
// (sessions, detail, sales, stock) and the embed path used to re-fetch the same
// session. 45s keeps rapid-fire queries free without ever serving stale stall data.
const CACHE_TTL_MS = 45000;
const responseCache = new Map<string, { at: number; data: unknown }>();

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

async function posGet<T>(path: string): Promise<T> {
  const cached = responseCache.get(path);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
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
      if (attempt === 0 && (err.name === 'AbortError' || err.code === 'ECONNRESET')) {
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

function stockLine(item: POSStockSummary['items'][number]): string {
  const sold = Number(item.sold);
  if (sold < 0) {
    // End-of-day recount found MORE than expected; a negative "sold" would confuse
    // the model, so label it for what it is.
    return `  - ${item.product_name}: started ${item.initial_quantity}, recount found ${Math.abs(sold)} extra, ${item.remaining} remaining`;
  }
  return `  - ${item.product_name}: started ${item.initial_quantity}, sold ${sold}, ${item.remaining} remaining`;
}

function stockSection(stock: POSStockSummary): string[] {
  const lines: string[] = [];
  const outOfStock = stock.items.filter(i => Number(i.remaining) <= 0);
  const lowStock = stock.items.filter(i => {
    const remaining = Number(i.remaining);
    return remaining > 0 && remaining <= 3;
  });

  if (outOfStock.length > 0) {
    lines.push(`  OUT OF STOCK: ${outOfStock.map(i => i.product_name).join(', ')}`);
  }
  if (lowStock.length > 0) {
    lines.push(`  LOW STOCK (3 or fewer left): ${lowStock.map(i => `${i.product_name} (${i.remaining})`).join(', ')}`);
  }

  for (const item of stock.items.slice(0, MAX_SUMMARY_ITEMS)) {
    lines.push(stockLine(item));
  }
  if (stock.items.length > MAX_SUMMARY_ITEMS) {
    lines.push(`  ...and ${stock.items.length - MAX_SUMMARY_ITEMS} more products`);
  }

  lines.push(`  Totals: ${stock.totals.initial} initial, ${stock.totals.sold} sold, ${stock.totals.remaining} remaining`);
  if (stock.totals.has_final_counts) {
    lines.push('  (these figures are reconciled against an end-of-day count)');
  }
  return lines;
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
  async getSessionSales(sessionId: string): Promise<POSSale[]> {
    return posGet<POSSale[]>(`/api/sales/session/${sessionId}`);
  },

  /** Get stock summary for a session */
  async getStockSummary(sessionId: string): Promise<POSStockSummary> {
    return posGet<POSStockSummary>(`/api/stock/session/${sessionId}/summary`);
  },

  /**
   * Build a text summary of the most recent session (or a specific one)
   * for injection into the AI context.
   */
  async buildSessionSummary(sessionId?: string): Promise<string> {
    try {
      let session: POSSessionDetail;

      if (sessionId) {
        session = await this.getSession(sessionId);
      } else {
        // Get the most recent session
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
        `Total Revenue: £${Number(stats.total_revenue).toFixed(2)}`,
        `Total Units Sold: ${stats.total_units}`,
        `Total Sales (transactions): ${stats.total_sales}`,
        stats.best_seller ? `Best Seller: ${stats.best_seller}` : null,
      ].filter(Boolean) as string[];

      // Get sales breakdown by product
      const sales = await this.getSessionSales(session.id);
      if (sales.length > 0) {
        const productTotals = new Map<string, { units: number; revenue: number; cash: number; card: number }>();
        for (const sale of sales) {
          const existing = productTotals.get(sale.product_name) || { units: 0, revenue: 0, cash: 0, card: 0 };
          existing.units += sale.quantity;
          existing.revenue += parseFloat(sale.price_charged) * sale.quantity;
          if (sale.payment_method === 'cash') existing.cash += parseFloat(sale.price_charged) * sale.quantity;
          else existing.card += parseFloat(sale.price_charged) * sale.quantity;
          productTotals.set(sale.product_name, existing);
        }

        lines.push('', 'Product Breakdown:');
        const entries = [...productTotals.entries()];
        for (const [name, data] of entries.slice(0, MAX_SUMMARY_ITEMS)) {
          lines.push(`  - ${name}: ${data.units} units, £${data.revenue.toFixed(2)} (cash: £${data.cash.toFixed(2)}, card: £${data.card.toFixed(2)})`);
        }
        if (entries.length > MAX_SUMMARY_ITEMS) {
          lines.push(`  ...and ${entries.length - MAX_SUMMARY_ITEMS} more products`);
        }

        // Payment method totals
        const totalCash = entries.reduce((s, [, d]) => s + d.cash, 0);
        const totalCard = entries.reduce((s, [, d]) => s + d.card, 0);
        lines.push('', `Payment Split: Cash £${totalCash.toFixed(2)} | Card £${totalCard.toFixed(2)}`);
      }

      // Stock summary if available — tolerate missing data
      try {
        const stock = await this.getStockSummary(session.id);
        if (stock.items.length > 0) {
          lines.push('', 'CURRENT STOCK (latest figures from POS):');
          lines.push(...stockSection(stock));
        } else {
          lines.push('', 'CURRENT STOCK: no stock entries set up for this session.');
        }
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, 'Failed to fetch stock summary for session');
        lines.push('', 'CURRENT STOCK: unavailable (failed to fetch).');
      }

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build POS session summary');
      throw err;
    }
  },

  /**
   * Build a focused stock-only summary. Newer sessions often have no stock entries
   * yet, so fall back to the most recent session that actually tracks stock.
   */
  async buildLatestStockSummary(): Promise<string> {
    try {
      const sessions = await this.getSessions();
      if (sessions.length === 0) return 'No sessions found in the POS system.';

      let target: POSSession | null = null;
      let stock: POSStockSummary | null = null;

      for (const candidate of sessions.slice(0, 6)) {
        try {
          const s = await this.getStockSummary(candidate.id);
          if (s.items.length > 0) {
            target = candidate;
            stock = s;
            break;
          }
        } catch (err) {
          logger.warn({ err, sessionId: candidate.id }, 'Failed to fetch stock summary while searching');
        }
      }

      if (!target || !stock) {
        return `No stock entries found in the ${Math.min(sessions.length, 6)} most recent sessions. Stock tracking may not be set up for recent stalls.`;
      }

      const lines: string[] = [
        `Stock from session: "${target.name}" (${formatDate(target.date)}${target.location ? `, ${target.location}` : ''}, ${target.status})`,
      ];
      if (target.id !== sessions[0].id) {
        lines.push(`Note: the newest session "${sessions[0].name}" has no stock entries, so these figures are from the most recent session that tracks stock.`);
      }
      lines.push('');
      lines.push(...stockSection(stock));

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build latest stock summary');
      throw err;
    }
  },

  /** Build a summary of all sessions for overview queries */
  async buildAllSessionsSummary(): Promise<string> {
    try {
      const sessions = await this.getSessions();
      if (sessions.length === 0) return 'No sessions found in the POS system.';

      const lines: string[] = [`ForgeRealm POS — ${sessions.length} session(s):`];
      for (const s of sessions.slice(0, 10)) {
        const rev = s.total_revenue != null ? `£${Number(s.total_revenue).toFixed(2)}` : '£0.00';
        const units = s.total_units != null ? `${s.total_units}` : '0';
        lines.push(`  - "${s.name}" (${formatDate(s.date)}${s.location ? `, ${s.location}` : ''}) — ${rev} revenue, ${units} units, ${s.status}`);
      }
      if (sessions.length > 10) lines.push(`  ... and ${sessions.length - 10} more`);

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build POS sessions summary');
      throw err;
    }
  },
};
