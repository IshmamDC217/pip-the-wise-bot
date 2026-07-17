/**
 * POS MCP Tools — wraps the ForgeRealm POS REST API
 */

const POS_URL = process.env.POS_API_URL || 'https://forgerealmpos.netlify.app';
const POS_USER = process.env.POS_USERNAME || '';
const POS_PASS = process.env.POS_PASSWORD || '';

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function authenticate(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!POS_URL || !POS_USER || !POS_PASS) return null;

  const res = await fetch(`${POS_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: POS_USER, password: POS_PASS }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { token: string };
  cachedToken = data.token;
  tokenExpiry = Date.now() + 6 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

async function posGet<T>(path: string): Promise<T | null> {
  const token = await authenticate();
  if (!token) return null;
  const res = await fetch(`${POS_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function posGetBuffer(path: string): Promise<Buffer | null> {
  const token = await authenticate();
  if (!token) return null;
  const res = await fetch(`${POS_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

interface Session {
  id: string; name: string; location: string | null; date: string;
  status: string; total_revenue: string; total_units: string;
}
interface SessionDetail extends Session {
  stats: { total_revenue: number; total_units: number; total_sales: number; best_seller: string | null };
}
interface Sale {
  product_name: string; product_category: string | null;
  quantity: number; price_charged: string; payment_method: string; timestamp: string;
}

function formatGBP(n: number): string { return `£${n.toFixed(2)}`; }

function buildBreakdown(sales: Sale[]): { name: string; units: number; revenue: number }[] {
  const map = new Map<string, { name: string; units: number; revenue: number }>();
  for (const s of sales) {
    const rev = s.quantity * parseFloat(s.price_charged);
    const e = map.get(s.product_name);
    if (e) { e.units += s.quantity; e.revenue += rev; }
    else map.set(s.product_name, { name: s.product_name, units: s.quantity, revenue: rev });
  }
  return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
}

export const posTools = {
  async stallOverview({ session_name }: { session_name?: string }) {
    const sessions = await posGet<Session[]>('/api/sessions');
    if (!sessions || sessions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No stall sessions found in the POS.' }] };
    }

    let target = sessions[0];
    if (session_name) {
      const q = session_name.toLowerCase();
      const found = sessions.find(s =>
        s.name.toLowerCase().includes(q) || (s.location && s.location.toLowerCase().includes(q)));
      if (found) target = found;
    }

    const [detail, sales] = await Promise.all([
      posGet<SessionDetail>(`/api/sessions/${target.id}`),
      posGet<Sale[]>(`/api/sales/session/${target.id}`),
    ]);

    if (!detail || !sales) {
      return { content: [{ type: 'text' as const, text: 'Failed to fetch session details from POS.' }] };
    }

    const breakdown = buildBreakdown(sales);
    let cashTotal = 0, cardTotal = 0;
    for (const s of sales) {
      const amt = s.quantity * parseFloat(s.price_charged);
      if (s.payment_method === 'card') cardTotal += amt; else cashTotal += amt;
    }

    const lines = [
      `**Stall: ${detail.name}**`,
      `Location: ${detail.location || 'N/A'} | Date: ${new Date(detail.date).toLocaleDateString('en-GB')} | Status: ${detail.status}`,
      '',
      `Revenue: **${formatGBP(detail.stats.total_revenue)}** | Units: **${detail.stats.total_units}** | Transactions: **${detail.stats.total_sales}**`,
      `Cash: ${formatGBP(cashTotal)} | Card: ${formatGBP(cardTotal)}`,
      `Best seller: ${detail.stats.best_seller || 'N/A'}`,
      '',
      '**Product Breakdown:**',
      ...breakdown.map(p => `- ${p.name}: ${p.units} units, ${formatGBP(p.revenue)}`),
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },

  async stallComparison() {
    const sessions = await posGet<Session[]>('/api/sessions');
    if (!sessions || sessions.length < 2) {
      return { content: [{ type: 'text' as const, text: 'Need at least 2 stall sessions to compare.' }] };
    }

    const [cur, prev] = await Promise.all([
      posGet<SessionDetail>(`/api/sessions/${sessions[0].id}`),
      posGet<SessionDetail>(`/api/sessions/${sessions[1].id}`),
    ]);
    const [curSales, prevSales] = await Promise.all([
      posGet<Sale[]>(`/api/sales/session/${sessions[0].id}`),
      posGet<Sale[]>(`/api/sales/session/${sessions[1].id}`),
    ]);

    if (!cur || !prev || !curSales || !prevSales) {
      return { content: [{ type: 'text' as const, text: 'Failed to fetch session data.' }] };
    }

    const curBreak = buildBreakdown(curSales);
    const prevBreak = buildBreakdown(prevSales);
    const revChange = cur.stats.total_revenue - prev.stats.total_revenue;
    const revPct = prev.stats.total_revenue > 0 ? (revChange / prev.stats.total_revenue * 100).toFixed(1) : '0';

    const lines = [
      `**${cur.name}** vs **${prev.name}**`,
      '',
      `| Metric | ${prev.name} | ${cur.name} | Change |`,
      `|--------|-------------|-------------|--------|`,
      `| Revenue | ${formatGBP(prev.stats.total_revenue)} | ${formatGBP(cur.stats.total_revenue)} | ${revChange >= 0 ? '+' : ''}${formatGBP(revChange)} (${revPct}%) |`,
      `| Units | ${prev.stats.total_units} | ${cur.stats.total_units} | ${cur.stats.total_units - prev.stats.total_units >= 0 ? '+' : ''}${cur.stats.total_units - prev.stats.total_units} |`,
      `| Transactions | ${prev.stats.total_sales} | ${cur.stats.total_sales} | ${cur.stats.total_sales - prev.stats.total_sales >= 0 ? '+' : ''}${cur.stats.total_sales - prev.stats.total_sales} |`,
      '',
      `**Current best seller:** ${cur.stats.best_seller || 'N/A'}`,
      `**Previous best seller:** ${prev.stats.best_seller || 'N/A'}`,
    ];

    // Top movers
    const curMap = new Map(curBreak.map(p => [p.name, p.units]));
    const prevMap = new Map(prevBreak.map(p => [p.name, p.units]));
    const allNames = new Set([...curMap.keys(), ...prevMap.keys()]);
    const movers = Array.from(allNames).map(name => ({
      name, diff: (curMap.get(name) || 0) - (prevMap.get(name) || 0),
    })).sort((a, b) => b.diff - a.diff);

    const risers = movers.filter(m => m.diff > 0).slice(0, 3);
    const fallers = movers.filter(m => m.diff < 0).slice(-3);
    if (risers.length) lines.push(`\n**Rising:** ${risers.map(m => `${m.name} (+${m.diff})`).join(', ')}`);
    if (fallers.length) lines.push(`**Falling:** ${fallers.map(m => `${m.name} (${m.diff})`).join(', ')}`);

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },

  async productQuery({ product }: { product: string }) {
    const sessions = await posGet<Session[]>('/api/sessions');
    if (!sessions || sessions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No stall sessions found.' }] };
    }

    const sales = await posGet<Sale[]>(`/api/sales/session/${sessions[0].id}`);
    if (!sales) return { content: [{ type: 'text' as const, text: 'Failed to fetch sales data.' }] };

    const q = product.toLowerCase();
    const matches = buildBreakdown(sales).filter(p => p.name.toLowerCase().includes(q));

    if (matches.length === 0) {
      return { content: [{ type: 'text' as const, text: `No sales of "${product}" found in stall "${sessions[0].name}".` }] };
    }

    const total = matches.reduce((s, m) => s + m.units, 0);
    const totalRev = matches.reduce((s, m) => s + m.revenue, 0);
    const lines = [
      `**"${product}" sales from ${sessions[0].name}:**`,
      ...matches.map(m => `- ${m.name}: **${m.units}** units, ${formatGBP(m.revenue)}`),
      matches.length > 1 ? `\n**Total: ${total} units, ${formatGBP(totalRev)}**` : '',
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },

  async listSessions() {
    const sessions = await posGet<Session[]>('/api/sessions');
    if (!sessions || sessions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No stall sessions found.' }] };
    }

    const lines = [
      '**Stall Sessions:**',
      ...sessions.map(s => {
        const date = new Date(s.date).toLocaleDateString('en-GB');
        const rev = parseFloat(s.total_revenue);
        return `- **${s.name}** (${s.location || 'N/A'}) — ${date} — ${formatGBP(rev)}, ${s.total_units} units [${s.status}]`;
      }),
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },

  async exportSession({ format, session_name }: { format: 'csv' | 'xlsx'; session_name?: string }) {
    const sessions = await posGet<Session[]>('/api/sessions');
    if (!sessions || sessions.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No stall sessions found.' }] };
    }

    let target = sessions[0];
    if (session_name) {
      const q = session_name.toLowerCase();
      const found = sessions.find(s =>
        s.name.toLowerCase().includes(q) || (s.location && s.location.toLowerCase().includes(q)));
      if (found) target = found;
    }

    const buffer = await posGetBuffer(`/api/export/${target.id}?format=${format}`);
    if (!buffer) {
      return { content: [{ type: 'text' as const, text: 'Failed to download export from POS.' }] };
    }

    const datePart = new Date(target.date).toLocaleDateString('en-GB').replace(/\//g, '-');
    const namePart = target.name.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `ForgeRealm_${namePart}_${datePart}.${format}`;

    return {
      content: [
        { type: 'text' as const, text: `Export ready: **${filename}** for stall "${target.name}"` },
        { type: 'resource' as const, resource: { uri: `data:application/octet-stream;base64,${buffer.toString('base64')}`, mimeType: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text: buffer.toString('base64') } },
      ],
    };
  },
};
