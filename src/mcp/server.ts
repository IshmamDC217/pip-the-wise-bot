#!/usr/bin/env node
/**
 * Pip the Wise — MCP Server
 *
 * Exposes ForgeRealm tools to OpenClaw:
 *   - POS: stall overviews, product queries, comparisons, exports
 *   - Monitors: website health, API health, database queries
 *   - Gmail: check important emails
 *   - Google: Calendar events, Sheets creation
 */
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { posTools } from './tools/pos.js';
import { monitorTools } from './tools/monitors.js';
import { gmailTools } from './tools/gmail.js';
import { googleTools } from './tools/google.js';

const server = new McpServer({
  name: 'pip-forgerealm',
  version: '1.0.0',
});

// ── POS Tools ──────────────────────────────────────

server.tool(
  'pos_stall_overview',
  'Get a full overview of a stall session — revenue, units, product breakdown, cash/card split. Defaults to the most recent stall.',
  { session_name: z.string().optional().describe('Stall name or location to search for. Omit for latest.') },
  posTools.stallOverview,
);

server.tool(
  'pos_stall_comparison',
  'Compare the two most recent stall sessions — revenue, units, top products, what went up/down.',
  {},
  posTools.stallComparison,
);

server.tool(
  'pos_product_query',
  'Look up sales of a specific product from the latest stall. E.g. "how many dragons did we sell"',
  { product: z.string().describe('Product name or keyword to search for') },
  posTools.productQuery,
);

server.tool(
  'pos_list_sessions',
  'List all stall sessions from the POS with basic stats (name, date, location, revenue, units).',
  {},
  posTools.listSessions,
);

server.tool(
  'pos_export',
  'Download a stall session export as CSV or XLSX. Returns the file content as base64.',
  {
    format: z.enum(['csv', 'xlsx']).default('csv').describe('Export format'),
    session_name: z.string().optional().describe('Stall name to export. Omit for latest.'),
  },
  posTools.exportSession,
);

// ── Monitor Tools ──────────────────────────────────

server.tool(
  'check_website_health',
  'Check if forgerealm.co.uk and api.forgerealm.co.uk are up and responding.',
  {},
  monitorTools.checkHealth,
);

server.tool(
  'get_shop_stats',
  'Get current ForgeRealm shop statistics — user count, product count, recent signups.',
  {},
  monitorTools.shopStats,
);

server.tool(
  'get_recent_users',
  'Get the most recent user signups from the ForgeRealm database.',
  { limit: z.number().default(5).describe('Number of recent users to return') },
  monitorTools.recentUsers,
);

server.tool(
  'get_products',
  'List all products in the ForgeRealm online shop with prices and stock levels.',
  {},
  monitorTools.listProducts,
);

// ── Gmail Tools ────────────────────────────────────

server.tool(
  'check_important_emails',
  'Check Gmail for recent important emails from Artsmix (events), NatWest (banking), or IONOS (billing only).',
  { hours_back: z.number().default(24).describe('How many hours back to check') },
  gmailTools.checkImportantEmails,
);

// ── Google Tools ───────────────────────────────────

server.tool(
  'get_calendar_events',
  'Get upcoming events from the ForgeRealm Google Calendar.',
  { max_results: z.number().default(10).describe('Max number of events to return') },
  googleTools.getCalendarEvents,
);

server.tool(
  'create_calendar_event',
  'Create a new event on the ForgeRealm Google Calendar.',
  {
    summary: z.string().describe('Event title'),
    date: z.string().describe('Date in YYYY-MM-DD format'),
    time: z.string().optional().describe('Time in HH:MM format (24h). Omit for all-day event.'),
    description: z.string().optional().describe('Event description'),
  },
  googleTools.createCalendarEvent,
);

server.tool(
  'create_google_sheet',
  'Create a formatted Google Sheet with headers, rows, and optional totals. Returns the sheet URL.',
  {
    title: z.string().describe('Spreadsheet title'),
    headers: z.array(z.string()).describe('Column headers'),
    rows: z.array(z.array(z.union([z.string(), z.number()]))).describe('Row data'),
    currency_columns: z.array(z.number()).default([]).describe('0-indexed columns that contain currency values'),
    include_total: z.boolean().default(false).describe('Whether to add a totals row'),
  },
  googleTools.createSheet,
);

// ── Start ──────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
