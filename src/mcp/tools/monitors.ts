/**
 * ForgeRealm Monitor MCP Tools — website health, API health, DB queries
 */
import mysql from 'mysql2/promise';

const SITE_URL = process.env.FORGEREALM_SITE_URL || 'https://forgerealm.co.uk';
const API_URL = process.env.FORGEREALM_API_URL || 'https://api.forgerealm.co.uk';

function getPool() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'forgerealm',
    connectionLimit: 2,
    connectTimeout: 10000,
  });
}

let pool: mysql.Pool | null = null;
function db() {
  if (!pool) pool = getPool();
  return pool;
}

async function httpCheck(url: string): Promise<{ ok: boolean; status: number; latency: number }> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status, latency: Date.now() - start };
  } catch {
    return { ok: false, status: 0, latency: Date.now() - start };
  }
}

export const monitorTools = {
  async checkHealth() {
    const [site, api] = await Promise.all([
      httpCheck(SITE_URL),
      httpCheck(`${API_URL}/health`),
    ]);

    const lines = [
      '**ForgeRealm Health Check:**',
      `- Website (${SITE_URL}): ${site.ok ? 'UP' : 'DOWN'} — ${site.status} (${site.latency}ms)`,
      `- API (${API_URL}): ${api.ok ? 'UP' : 'DOWN'} — ${api.status} (${api.latency}ms)`,
    ];

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },

  async shopStats() {
    try {
      const [userCount] = await db().query('SELECT COUNT(*) as count FROM users');
      const [productCount] = await db().query('SELECT COUNT(*) as count FROM products');
      const users = (userCount as any[])[0].count;
      const products = (productCount as any[])[0].count;

      return {
        content: [{
          type: 'text' as const,
          text: `**ForgeRealm Shop Stats:**\n- Users: **${users}**\n- Products: **${products}**`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Database error: ${(err as Error).message}` }] };
    }
  },

  async recentUsers({ limit }: { limit: number }) {
    try {
      const [rows] = await db().query(
        'SELECT username, email, role, created_at FROM users ORDER BY created_at DESC LIMIT ?',
        [limit],
      );

      const users = rows as any[];
      if (users.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No users found.' }] };
      }

      const lines = [
        `**${users.length} Most Recent Signups:**`,
        ...users.map((u: any) => {
          const date = new Date(u.created_at).toLocaleDateString('en-GB');
          return `- **${u.username}** (${u.email}) — ${u.role} — ${date}`;
        }),
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Database error: ${(err as Error).message}` }] };
    }
  },

  async listProducts() {
    try {
      const [rows] = await db().query(
        'SELECT name, description, price, stock FROM products ORDER BY name',
      );

      const products = rows as any[];
      if (products.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No products in the shop.' }] };
      }

      const lines = [
        `**ForgeRealm Products (${products.length}):**`,
        ...products.map((p: any) => `- **${p.name}** — £${parseFloat(p.price).toFixed(2)} (stock: ${p.stock})`),
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Database error: ${(err as Error).message}` }] };
    }
  },
};
