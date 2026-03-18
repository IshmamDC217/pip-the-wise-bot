import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let cachedToken: string | null = null;
let tokenExpiry = 0;

interface POSSession {
  id: string;
  name: string;
  location: string | null;
  date: string;
  notes: string | null;
  status: string;
  card_fee_applied: boolean;
  card_fee_rate: string;
  total_revenue: string;
  total_units: string;
}

interface POSSessionDetail extends POSSession {
  stats: {
    total_revenue: number;
    total_units: number;
    total_sales: number;
    best_seller: string | null;
  };
}

interface POSSale {
  id: string;
  session_id: string;
  product_id: string;
  quantity: number;
  price_charged: string;
  payment_method: 'cash' | 'card';
  timestamp: string;
  product_name: string;
  product_category: string | null;
}

export interface StallOverview {
  session: POSSessionDetail;
  sales: POSSale[];
  productBreakdown: ProductBreakdown[];
  cashTotal: number;
  cardTotal: number;
}

export interface ProductBreakdown {
  name: string;
  category: string | null;
  units: number;
  revenue: number;
}

export interface StallComparison {
  current: StallOverview;
  previous: StallOverview;
}

async function authenticate(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  if (!config.POS_API_URL || !config.POS_USERNAME || !config.POS_PASSWORD) {
    logger.warn('POS credentials not configured');
    return null;
  }

  try {
    const res = await fetch(`${config.POS_API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: config.POS_USERNAME,
        password: config.POS_PASSWORD,
      }),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'POS auth failed');
      return null;
    }

    const data = await res.json() as { token: string };
    cachedToken = data.token;
    // JWT expires in 7 days, refresh at 6 days
    tokenExpiry = Date.now() + 6 * 24 * 60 * 60 * 1000;
    return cachedToken;
  } catch (err) {
    logger.error({ err }, 'POS auth error');
    return null;
  }
}

async function posGet<T>(path: string): Promise<T | null> {
  const token = await authenticate();
  if (!token) return null;

  try {
    const res = await fetch(`${config.POS_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      logger.error({ status: res.status, path }, 'POS API error');
      return null;
    }

    return await res.json() as T;
  } catch (err) {
    logger.error({ err, path }, 'POS fetch error');
    return null;
  }
}

async function posGetBuffer(path: string): Promise<Buffer | null> {
  const token = await authenticate();
  if (!token) return null;

  try {
    const res = await fetch(`${config.POS_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch (err) {
    logger.error({ err, path }, 'POS download error');
    return null;
  }
}

function buildProductBreakdown(sales: POSSale[]): ProductBreakdown[] {
  const map = new Map<string, ProductBreakdown>();

  for (const sale of sales) {
    const existing = map.get(sale.product_name);
    const revenue = sale.quantity * parseFloat(sale.price_charged);

    if (existing) {
      existing.units += sale.quantity;
      existing.revenue += revenue;
    } else {
      map.set(sale.product_name, {
        name: sale.product_name,
        category: sale.product_category,
        units: sale.quantity,
        revenue,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

function buildOverview(session: POSSessionDetail, sales: POSSale[]): StallOverview {
  let cashTotal = 0;
  let cardTotal = 0;

  for (const sale of sales) {
    const amount = sale.quantity * parseFloat(sale.price_charged);
    if (sale.payment_method === 'card') cardTotal += amount;
    else cashTotal += amount;
  }

  return {
    session,
    sales,
    productBreakdown: buildProductBreakdown(sales),
    cashTotal,
    cardTotal,
  };
}

export const posService = {
  isConfigured(): boolean {
    return !!(config.POS_API_URL && config.POS_USERNAME && config.POS_PASSWORD);
  },

  /** Get all sessions (newest first) */
  async getSessions(): Promise<POSSession[]> {
    return (await posGet<POSSession[]>('/api/sessions')) || [];
  },

  /** Get full overview for a specific session */
  async getStallOverview(sessionId: string): Promise<StallOverview | null> {
    const [session, sales] = await Promise.all([
      posGet<POSSessionDetail>(`/api/sessions/${sessionId}`),
      posGet<POSSale[]>(`/api/sales/session/${sessionId}`),
    ]);

    if (!session || !sales) return null;
    return buildOverview(session, sales);
  },

  /** Get overview of the most recent session */
  async getLastStall(): Promise<StallOverview | null> {
    const sessions = await this.getSessions();
    if (sessions.length === 0) return null;
    return this.getStallOverview(sessions[0].id);
  },

  /** Get comparison of the two most recent sessions */
  async getStallComparison(): Promise<StallComparison | null> {
    const sessions = await this.getSessions();
    if (sessions.length < 2) return null;

    const [current, previous] = await Promise.all([
      this.getStallOverview(sessions[0].id),
      this.getStallOverview(sessions[1].id),
    ]);

    if (!current || !previous) return null;
    return { current, previous };
  },

  /** Search for a specific product across the last stall */
  async getProductFromLastStall(productQuery: string): Promise<{ overview: StallOverview; matches: ProductBreakdown[] } | null> {
    const overview = await this.getLastStall();
    if (!overview) return null;

    const q = productQuery.toLowerCase();
    const matches = overview.productBreakdown.filter((p) =>
      p.name.toLowerCase().includes(q),
    );

    return { overview, matches };
  },

  /** Search for a product across a specific session by name */
  async findSessionByName(nameQuery: string): Promise<POSSession | null> {
    const sessions = await this.getSessions();
    const q = nameQuery.toLowerCase();
    return sessions.find((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.location && s.location.toLowerCase().includes(q)),
    ) || null;
  },

  /** Download export file (CSV or XLSX) */
  async getExport(sessionId: string, format: 'csv' | 'xlsx'): Promise<{ buffer: Buffer; filename: string } | null> {
    const session = await posGet<POSSessionDetail>(`/api/sessions/${sessionId}`);
    if (!session) return null;

    const buffer = await posGetBuffer(`/api/export/${sessionId}?format=${format}`);
    if (!buffer) return null;

    const datePart = new Date(session.date).toLocaleDateString('en-GB').replace(/\//g, '-');
    const namePart = session.name.replace(/[^a-zA-Z0-9]/g, '_');
    const ext = format === 'csv' ? 'csv' : 'xlsx';
    const filename = `ForgeRealm_${namePart}_${datePart}.${ext}`;

    return { buffer, filename };
  },
};
