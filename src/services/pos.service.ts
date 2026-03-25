import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const BASE = config.POS_URL;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

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

interface POSProduct {
  id: string;
  name: string;
  default_price: string;
  category: string | null;
}

interface POSStockSummary {
  items: Array<{
    product_id: string;
    product_name: string;
    initial_quantity: number;
    total_sold: number;
    final_quantity: number | null;
  }>;
  totals: {
    initial: number;
    sold: number;
    remaining: number;
    revenue: string;
    has_final_counts: boolean;
  };
}

async function authenticate(): Promise<string> {
  // Reuse cached token if still valid (with 1-hour buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 3600000) {
    return cachedToken;
  }

  if (!config.POS_USERNAME || !config.POS_PASSWORD) {
    throw new Error('POS credentials not configured (POS_USERNAME / POS_PASSWORD)');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000); // POS cold start can take a while

  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: config.POS_USERNAME,
      password: config.POS_PASSWORD,
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POS auth failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  cachedToken = data.token;
  // Token expires in 7 days, cache for 6
  tokenExpiresAt = Date.now() + 6 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function posGet<T>(path: string, retries = 1): Promise<T> {
  const token = await authenticate();

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attempt === 0 ? 15000 : 45000);

    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`POS GET ${path} failed (${res.status}): ${body}`);
      }

      return (await res.json()) as T;
    } catch (err: any) {
      clearTimeout(timeout);
      if (attempt < retries && (err.name === 'AbortError' || err.code === 'ECONNRESET')) {
        logger.warn({ path, attempt }, 'POS request timed out, retrying (cold start?)');
        continue;
      }
      throw err;
    }
  }

  throw new Error(`POS GET ${path} failed after ${retries + 1} attempts`);
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

  /** Get all products */
  async getProducts(): Promise<POSProduct[]> {
    return posGet<POSProduct[]>('/api/products');
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
        `Date: ${session.date}`,
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
        for (const [name, data] of productTotals) {
          lines.push(`  - ${name}: ${data.units} units, £${data.revenue.toFixed(2)} (cash: £${data.cash.toFixed(2)}, card: £${data.card.toFixed(2)})`);
        }

        // Payment method totals
        const totalCash = [...productTotals.values()].reduce((s, d) => s + d.cash, 0);
        const totalCard = [...productTotals.values()].reduce((s, d) => s + d.card, 0);
        lines.push('', `Payment Split: Cash £${totalCash.toFixed(2)} | Card £${totalCard.toFixed(2)}`);
      }

      // Stock summary if available
      try {
        const stock = await this.getStockSummary(session.id);
        if (stock.items.length > 0) {
          lines.push('', 'Stock Summary:');
          for (const item of stock.items) {
            const remaining = item.final_quantity !== null ? item.final_quantity : item.initial_quantity - item.total_sold;
            lines.push(`  - ${item.product_name}: started ${item.initial_quantity}, sold ${item.total_sold}, remaining ${remaining}`);
          }
          lines.push(`  Totals: ${stock.totals.initial} initial → ${stock.totals.sold} sold, ${stock.totals.remaining} remaining`);
        }
      } catch {
        // Stock data might not exist for all sessions
      }

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build POS session summary');
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
        lines.push(`  - "${s.name}" (${s.date}${s.location ? `, ${s.location}` : ''}) — ${rev} revenue, ${units} units, ${s.status}`);
      }
      if (sessions.length > 10) lines.push(`  ... and ${sessions.length - 10} more`);

      return lines.join('\n');
    } catch (err) {
      logger.error({ err }, 'Failed to build POS sessions summary');
      throw err;
    }
  },
};
