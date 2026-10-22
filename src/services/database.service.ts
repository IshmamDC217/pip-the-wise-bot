import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { DBUser, DBProduct } from '../types.js';

// The website database lives on Neon (Postgres) since the RDS MySQL instance
// was retired. Same tables as before (users, products, product_images); the
// schema is in the site repo under backend/migrations/001_init.sql.

const { Pool, types } = pg;

// pg hands back int8 (COUNT(*)) and numeric (price) as strings so nothing is
// silently rounded. We only ever display them, so numbers are what we want.
types.setTypeParser(20, (v: string) => parseInt(v, 10));
types.setTypeParser(1700, (v: string) => parseFloat(v));

// Managed Postgres refuses plain TCP; a local instance usually has no cert.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(config.DATABASE_URL) || /[?&]sslmode=disable\b/.test(config.DATABASE_URL);

// TLS is decided by the `ssl` option below, so drop `sslmode` from the URL:
// pg 8.x prints a deprecation warning at boot when it sees one.
function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

const connectionString = config.DATABASE_URL ? stripSslMode(config.DATABASE_URL) : '';

const pool = connectionString
  ? new Pool({
      connectionString,
      ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    })
  : null;

// Pool errors on idle clients (Neon drops idle connections) would otherwise be
// unhandled 'error' events and crash the process.
pool?.on('error', err => logger.warn({ err }, 'Postgres pool: idle client error'));

async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) throw Object.assign(new Error('DATABASE_URL is not set'), { code: 'NOT_CONFIGURED' });
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

const PRODUCT_SELECT = `SELECT p.*,
    (SELECT path FROM product_images WHERE product_id = p.id AND is_primary = TRUE LIMIT 1) AS primary_image
  FROM products p`;

// Postgres keeps microseconds; the monitor's checkpoint is a JS Date, which
// only keeps milliseconds. Comparing raw timestamps against that checkpoint
// re-matches the newest row forever (12:00:00.123456 > 12:00:00.123), so
// truncate the column to the same precision before comparing.
const ms = (column: string) => `date_trunc('milliseconds', ${column})`;

export const db = {
  isConfigured(): boolean {
    return pool !== null;
  },

  // ── Read ──────────────────────────────────────────
  async getNewUsers(since: Date): Promise<DBUser[]> {
    return query<DBUser>(
      `SELECT id, username, email, role, email_verified, created_at FROM users WHERE ${ms('created_at')} > $1 ORDER BY created_at ASC`,
      [since],
    );
  },

  async getVerifiedUsers(since: Date): Promise<DBUser[]> {
    return query<DBUser>(
      `SELECT id, username, email, email_verified_at FROM users WHERE email_verified = TRUE AND ${ms('email_verified_at')} > $1 ORDER BY email_verified_at ASC`,
      [since],
    );
  },

  async getNewProducts(since: Date): Promise<DBProduct[]> {
    return query<DBProduct>(`${PRODUCT_SELECT} WHERE ${ms('p.created_at')} > $1 ORDER BY p.created_at ASC`, [since]);
  },

  async getAllProducts(): Promise<DBProduct[]> {
    return query<DBProduct>(`${PRODUCT_SELECT} ORDER BY p.created_at DESC`);
  },

  async getAllProductStock(): Promise<{ id: number; name: string; stock: number; price: number }[]> {
    return query('SELECT id, name, stock, price FROM products');
  },

  async getUserCount(): Promise<number> {
    const rows = await query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    return rows[0].count;
  },

  async getRecentUsers(limit = 5): Promise<DBUser[]> {
    return query<DBUser>(
      'SELECT id, username, email, role, email_verified, created_at FROM users ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
  },

  async getProductCount(): Promise<number> {
    const rows = await query<{ count: number }>('SELECT COUNT(*) AS count FROM products');
    return rows[0].count;
  },

  async isConnected(): Promise<boolean> {
    const result = await this.checkConnection();
    return result.ok;
  },

  /**
   * Like isConnected but surfaces WHY the connection failed. A rejected password
   * (28P01) must be distinguishable from a network outage — the former sat
   * masked as "unreachable" for four months on the old MySQL host.
   */
  async checkConnection(): Promise<{ ok: boolean; code?: string; message?: string }> {
    try {
      await query('SELECT 1');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, code: err?.code ?? 'UNKNOWN', message: err?.message };
    }
  },

  // ── Create ────────────────────────────────────────
  async createProduct(
    name: string,
    price: number,
    stock: number,
    description?: string,
  ): Promise<number | null> {
    try {
      const rows = await query<{ id: number }>(
        'INSERT INTO products (name, description, price, stock, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
        [name, description || '', price, stock],
      );
      const id = rows[0].id;
      logger.info({ id, name, price, stock }, 'Product created');
      return id;
    } catch (err) {
      logger.error({ err }, 'Failed to create product');
      return null;
    }
  },

  // ── Update ────────────────────────────────────────
  async updateProduct(
    id: number,
    updates: Partial<{ name: string; price: number; stock: number; description: string }>,
  ): Promise<boolean> {
    try {
      const fields: string[] = [];
      const values: unknown[] = [];

      const set = (column: string, value: unknown) => {
        values.push(value);
        fields.push(`${column} = $${values.length}`);
      };
      if (updates.name !== undefined) set('name', updates.name);
      if (updates.price !== undefined) set('price', updates.price);
      if (updates.stock !== undefined) set('stock', updates.stock);
      if (updates.description !== undefined) set('description', updates.description);

      if (fields.length === 0) return false;

      values.push(id);
      await query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
      logger.info({ id, updates }, 'Product updated');
      return true;
    } catch (err) {
      logger.error({ err }, 'Failed to update product');
      return false;
    }
  },

  // ── Delete ────────────────────────────────────────
  async deleteProduct(id: number): Promise<boolean> {
    try {
      // product_images cascades on delete, but be explicit so the intent is clear
      await query('DELETE FROM product_images WHERE product_id = $1', [id]);
      const rows = await query<{ id: number }>('DELETE FROM products WHERE id = $1 RETURNING id', [id]);
      const deleted = rows.length > 0;
      if (deleted) logger.info({ id }, 'Product deleted');
      return deleted;
    } catch (err) {
      logger.error({ err }, 'Failed to delete product');
      return false;
    }
  },

  // ── Lookup ────────────────────────────────────────
  async getProductByName(name: string): Promise<DBProduct | null> {
    try {
      const rows = await query<DBProduct>(`${PRODUCT_SELECT} WHERE p.name ILIKE $1 LIMIT 1`, [`%${name}%`]);
      return rows[0] ?? null;
    } catch (err) {
      logger.error({ err }, 'Failed to lookup product');
      return null;
    }
  },

  async getProductById(id: number): Promise<DBProduct | null> {
    try {
      const rows = await query<DBProduct>(`${PRODUCT_SELECT} WHERE p.id = $1`, [id]);
      return rows[0] ?? null;
    } catch (err) {
      logger.error({ err }, 'Failed to get product');
      return null;
    }
  },
};
