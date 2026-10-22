import { posService } from './pos.service.js';
import { buildSessionStatsEmbed, buildSessionsOverviewEmbed } from '../embeds/pos.embeds.js';
import { logger } from '../utils/logger.js';
import type { ToolOutcome, ToolSet } from './ai.service.js';

// POS lookups the chat model can call for itself. The model decides when a
// message needs data, so phrasing no longer has to match a keyword list, and
// every figure it quotes traces back to one of these results.

const STALL_PARAM = {
  type: 'string',
  description: 'A stall number such as "23", or part of the stall name or location such as "kirkgate". Omit for the most recent stall.',
};

// Wraps fetch failures so the model gets one unambiguous signal instead of a
// stack trace it might try to interpret.
async function guarded(name: string, fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, tool: name }, 'POS tool failed');
    return { result: 'ERROR: could not reach the POS right now. Tell the user plainly that the lookup failed and to try again shortly. Do not guess any figures.' };
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export const posTools: ToolSet = {
  definitions: [
    {
      type: 'function',
      function: {
        name: 'get_stall_stats',
        description: 'Stats for one stall (market session): revenue, units, transactions, best seller, per-product breakdown and cash/card split. Omit "stall" for the most recent stall.',
        parameters: { type: 'object', properties: { stall: STALL_PARAM } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_stalls',
        description: 'Every stall in the POS, newest first, with date, location, revenue and units. Use for "all stalls", "how many stalls have we done", comparing recent stalls, or finding a stall by date or location.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_product_sales',
        description: 'Units sold and revenue for ONE named product, totalled across every stall ever (default) or at one stall. Use when the user names the product: "how much has X made us", "X till date", "X at stall 21". If they only give a number, use get_stall_stats instead.',
        parameters: {
          type: 'object',
          properties: {
            product: { type: 'string', description: 'Product name as the user said it, e.g. "hexagon fidgets"' },
            stall: { ...STALL_PARAM, description: 'Limit to one stall: a stall number or part of its name/location. Omit for all stalls combined.' },
          },
          required: ['product'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_stock',
        description: 'Current stock levels. Stock is one shared pool across all stalls. Omit "product" for the full picture including out-of-stock and low-stock lists.',
        parameters: {
          type: 'object',
          properties: { product: { type: 'string', description: 'Narrow to products matching this name' } },
        },
      },
    },
  ],

  async execute(name, args) {
    switch (name) {
      case 'get_stall_stats':
        return guarded(name, async () => {
          const sessions = await posService.getSessions();
          if (sessions.length === 0) return { result: 'No stalls in the POS yet.' };
          const ref = str(args.stall);
          const target = ref ? posService.findSession(sessions, ref) : sessions[0];
          if (!target) {
            return { result: `No stall matching "${ref}". Known stalls (newest first): ${sessions.slice(0, 10).map(s => s.name).join(', ')}.` };
          }
          const [summary, detail] = await Promise.all([
            posService.buildSessionSummary(target.id),
            posService.getSession(target.id),
          ]);
          return { result: summary, embed: buildSessionStatsEmbed(detail), embedKey: `stall:${target.id}` };
        });

      case 'list_stalls':
        return guarded(name, async () => {
          const sessions = await posService.getSessions();
          const summary = await posService.buildAllSessionsSummary();
          return { result: summary, embed: buildSessionsOverviewEmbed(sessions), embedKey: 'stalls' };
        });

      case 'get_product_sales':
        return guarded(name, async () => {
          const product = str(args.product);
          if (!product) return { result: 'ERROR: "product" is required. Ask the user which product they mean.' };
          return { result: await posService.buildProductSalesSummary(product, str(args.stall)) };
        });

      case 'get_stock':
        return guarded(name, async () => ({ result: await posService.buildStockSummary(str(args.product)) }));

      default:
        return { result: `ERROR: unknown tool "${name}".` };
    }
  },
};
