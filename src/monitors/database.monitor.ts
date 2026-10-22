import { Client, TextChannel } from 'discord.js';
import { config } from '../config.js';
import { db } from '../services/database.service.js';
import { buildNewUserEmbed, buildUserVerifiedEmbed, buildNewProductEmbed, buildStockChangeEmbed } from '../embeds/shop.embeds.js';
import { loadState, updateState } from '../utils/state.js';
import { logger } from '../utils/logger.js';

let dbUnavailableLogged = false;
let pollInFlight = false;

// Cap per-category announcements per poll. After a long outage the backlog can be
// months deep; blasting one embed per row would hammer Discord's channel rate
// limit for ages. The rest is summarized and the timestamp still advances.
const MAX_EMBEDS_PER_CATEGORY = 5;

export function startDatabaseMonitor(client: Client): NodeJS.Timeout {
  logger.info(`Database monitor started (every ${config.POLL_DATABASE_MS / 1000}s)`);

  // Run immediately, then on interval
  poll(client);
  return setInterval(() => poll(client), config.POLL_DATABASE_MS);
}

function maxDate(dates: Array<string | Date | undefined>, fallback: string): string {
  let max = new Date(fallback).getTime();
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return new Date(max).toISOString();
}

async function poll(client: Client) {
  // A hung query must not stack overlapping polls (each would re-announce the
  // same rows from a stale baseline).
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    const conn = await db.checkConnection();
    if (!conn.ok) {
      if (!dbUnavailableLogged) {
        if (conn.code === 'ER_ACCESS_DENIED_ERROR') {
          logger.error({ code: conn.code }, 'Database credentials REJECTED — check DB_USER/DB_PASS in .env (the server is reachable, the login is wrong)');
        } else {
          logger.warn({ code: conn.code, message: conn.message }, 'Database unreachable — monitor paused until connection is restored');
        }
        dbUnavailableLogged = true;
      }
      return;
    }
    if (dbUnavailableLogged) {
      logger.info('Database connection restored — monitor resumed');
      dbUnavailableLogged = false;
    }

    const channel = client.channels.cache.get(config.CHANNEL_SHOP) as TextChannel;
    if (!channel) return;

    // Check new users
    {
      const state = loadState();
      const newUsers = await db.getNewUsers(new Date(state.lastUserCheck));
      if (newUsers.length > 0) {
        const totalUsers = await db.getUserCount();
        for (const user of newUsers.slice(0, MAX_EMBEDS_PER_CATEGORY)) {
          await channel.send({ embeds: [buildNewUserEmbed(user, totalUsers)] });
        }
        if (newUsers.length > MAX_EMBEDS_PER_CATEGORY) {
          await channel.send(`...and ${newUsers.length - MAX_EMBEDS_PER_CATEGORY} more new users since the last check.`);
        }
        // Advance to the newest row we actually processed, not "now" — rows that
        // arrive mid-poll must be picked up next time, not skipped.
        updateState({ lastUserCheck: maxDate(newUsers.map(u => u.created_at), state.lastUserCheck) });
      }
    }

    // Check verified users
    {
      const state = loadState();
      const verified = await db.getVerifiedUsers(new Date(state.lastVerifiedCheck));
      if (verified.length > 0) {
        for (const user of verified.slice(0, MAX_EMBEDS_PER_CATEGORY)) {
          await channel.send({ embeds: [buildUserVerifiedEmbed(user)] });
        }
        if (verified.length > MAX_EMBEDS_PER_CATEGORY) {
          await channel.send(`...and ${verified.length - MAX_EMBEDS_PER_CATEGORY} more newly verified users.`);
        }
        updateState({ lastVerifiedCheck: maxDate(verified.map(u => (u as any).email_verified_at), state.lastVerifiedCheck) });
      }
    }

    // Check new products
    {
      const state = loadState();
      const newProducts = await db.getNewProducts(new Date(state.lastProductCheck));
      if (newProducts.length > 0) {
        for (const product of newProducts.slice(0, MAX_EMBEDS_PER_CATEGORY)) {
          await channel.send({ embeds: [buildNewProductEmbed(product)] });
        }
        if (newProducts.length > MAX_EMBEDS_PER_CATEGORY) {
          await channel.send(`...and ${newProducts.length - MAX_EMBEDS_PER_CATEGORY} more new products.`);
        }
        updateState({ lastProductCheck: maxDate(newProducts.map(p => (p as any).created_at), state.lastProductCheck) });
      }
    }

    // Check stock changes
    {
      const state = loadState();
      const currentStock = await db.getAllProductStock();
      const snapshot = { ...state.stockSnapshot };
      const changes: Array<{ name: string; oldStock: number; newStock: number }> = [];
      for (const product of currentStock) {
        const oldStock = snapshot[product.id];
        if (oldStock !== undefined && oldStock !== product.stock) {
          changes.push({ name: product.name, oldStock, newStock: product.stock });
        }
        snapshot[product.id] = product.stock;
      }
      for (const change of changes.slice(0, MAX_EMBEDS_PER_CATEGORY)) {
        await channel.send({
          embeds: [buildStockChangeEmbed(change.name, change.oldStock, change.newStock)],
        });
      }
      if (changes.length > MAX_EMBEDS_PER_CATEGORY) {
        const rest = changes.slice(MAX_EMBEDS_PER_CATEGORY).map(c => c.name).join(', ');
        await channel.send(`...and ${changes.length - MAX_EMBEDS_PER_CATEGORY} more stock changes: ${rest}`.slice(0, 2000));
      }
      updateState({ stockSnapshot: snapshot });
    }
  } catch (err) {
    logger.error({ err }, 'Database monitor error');
  } finally {
    pollInFlight = false;
  }
}
