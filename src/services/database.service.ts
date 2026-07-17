import mysql from 'mysql2/promise';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { DBUser, DBProduct } from '../types.js';

const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASS,
  database: config.DB_NAME,
  waitForConnections: true,
  connectionLimit: 3,
  queueLimit: 10,
  connectTimeout: 10000,
  // DECIMAL columns come back as strings otherwise, which crashes .toFixed()
  decimalNumbers: true,
});

export const db = {
  // ── Read ──────────────────────────────────────────
  async getNewUsers(since: Date): Promise<DBUser[]> {
    const [rows] = await pool.query(
      'SELECT id, username, email, role, email_verified, created_at FROM users WHERE created_at > ? ORDER BY created_at ASC',
      [since],
    );
    return rows as DBUser[];
  },

  async getVerifiedUsers(since: Date): Promise<DBUser[]> {
    const [rows] = await pool.query(
      'SELECT id, username, email, email_verified_at FROM users WHERE email_verified = 1 AND email_verified_at > ? ORDER BY email_verified_at ASC',
      [since],
    );
    return rows as DBUser[];
  },

  async getNewProducts(since: Date): Promise<DBProduct[]> {
    const [rows] = await pool.query(
      `SELECT p.*,
        (SELECT path FROM product_images WHERE product_id = p.id AND is_primary = 1 LIMIT 1) AS primary_image
       FROM products p WHERE p.created_at > ? ORDER BY p.created_at ASC`,
      [since],
    );
    return rows as DBProduct[];
  },

  async getAllProducts(): Promise<DBProduct[]> {
    const [rows] = await pool.query(
      `SELECT p.*,
        (SELECT path FROM product_images WHERE product_id = p.id AND is_primary = 1 LIMIT 1) AS primary_image
       FROM products p ORDER BY p.created_at DESC`,
    );
    return rows as DBProduct[];
  },

  async getAllProductStock(): Promise<{ id: number; name: string; stock: number; price: number }[]> {
    const [rows] = await pool.query('SELECT id, name, stock, price FROM products');
    return rows as any[];
  },

  async getUserCount(): Promise<number> {
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM users');
    return (rows as any[])[0].count;
  },

  async getRecentUsers(limit = 5): Promise<DBUser[]> {
    const [rows] = await pool.query(
      'SELECT id, username, role, email_verified, created_at FROM users ORDER BY created_at DESC LIMIT ?',
      [limit],
    );
    return rows as DBUser[];
  },

  async getProductCount(): Promise<number> {
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM products');
    return (rows as any[])[0].count;
  },

  async isConnected(): Promise<boolean> {
    const result = await this.checkConnection();
    return result.ok;
  },

  /**
   * Like isConnected but surfaces WHY the connection failed. A rejected password
   * (ER_ACCESS_DENIED_ERROR) must be distinguishable from a network outage —
   * the former sat masked as "unreachable" for four months.
   */
  async checkConnection(): Promise<{ ok: boolean; code?: string; message?: string }> {
    try {
      await pool.query('SELECT 1');
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
      const [result] = await pool.query(
        'INSERT INTO products (name, description, price, stock, created_at) VALUES (?, ?, ?, ?, NOW())',
        [name, description || '', price, stock],
      );
      const id = (result as any).insertId;
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
      const values: any[] = [];

      if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
      if (updates.price !== undefined) { fields.push('price = ?'); values.push(updates.price); }
      if (updates.stock !== undefined) { fields.push('stock = ?'); values.push(updates.stock); }
      if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }

      if (fields.length === 0) return false;

      values.push(id);
      await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);
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
      // Remove associated images first
      await pool.query('DELETE FROM product_images WHERE product_id = ?', [id]);
      const [result] = await pool.query('DELETE FROM products WHERE id = ?', [id]);
      const deleted = (result as any).affectedRows > 0;
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
      const [rows] = await pool.query(
        `SELECT p.*,
          (SELECT path FROM product_images WHERE product_id = p.id AND is_primary = 1 LIMIT 1) AS primary_image
         FROM products p WHERE LOWER(p.name) LIKE ? LIMIT 1`,
        [`%${name.toLowerCase()}%`],
      );
      const results = rows as DBProduct[];
      return results.length > 0 ? results[0] : null;
    } catch (err) {
      logger.error({ err }, 'Failed to lookup product');
      return null;
    }
  },

  async getProductById(id: number): Promise<DBProduct | null> {
    try {
      const [rows] = await pool.query(
        `SELECT p.*,
          (SELECT path FROM product_images WHERE product_id = p.id AND is_primary = 1 LIMIT 1) AS primary_image
         FROM products p WHERE p.id = ?`,
        [id],
      );
      const results = rows as DBProduct[];
      return results.length > 0 ? results[0] : null;
    } catch (err) {
      logger.error({ err }, 'Failed to get product');
      return null;
    }
  },
};
