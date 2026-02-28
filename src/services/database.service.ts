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
  queueLimit: 0,
});

export const db = {
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
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },
};
