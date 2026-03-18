import { EmbedBuilder } from 'discord.js';
import type { StallOverview, StallComparison, ProductBreakdown } from '../services/pos.service.js';

const NAVY = 0x0a1628;
const GOLD = 0xd4a843;
const SAGE = 0x84a98c;

function formatGBP(amount: number): string {
  return `£${amount.toFixed(2)}`;
}

function changeStr(current: number, previous: number): string {
  const diff = current - previous;
  const pct = previous > 0 ? ((diff / previous) * 100).toFixed(1) : '—';
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '—';
  const sign = diff > 0 ? '+' : '';
  return `${arrow} ${sign}${typeof current === 'number' && current % 1 !== 0 ? formatGBP(diff) : diff} (${pct}%)`;
}

function productTable(products: ProductBreakdown[], maxRows = 10): string {
  if (products.length === 0) return '*No sales recorded*';

  const lines: string[] = [];
  const top = products.slice(0, maxRows);

  // Find max widths for alignment
  const nameWidth = Math.min(Math.max(...top.map((p) => p.name.length), 7), 20);
  const qtyWidth = 4;
  const revWidth = 8;

  lines.push(
    `${'Product'.padEnd(nameWidth)} | ${'Qty'.padStart(qtyWidth)} | ${'Revenue'.padStart(revWidth)}`,
  );
  lines.push('─'.repeat(nameWidth) + '─┼─' + '─'.repeat(qtyWidth) + '─┼─' + '─'.repeat(revWidth));

  for (const p of top) {
    const name = p.name.length > nameWidth ? p.name.slice(0, nameWidth - 1) + '…' : p.name.padEnd(nameWidth);
    lines.push(
      `${name} | ${String(p.units).padStart(qtyWidth)} | ${formatGBP(p.revenue).padStart(revWidth)}`,
    );
  }

  if (products.length > maxRows) {
    lines.push(`... and ${products.length - maxRows} more`);
  }

  return '```\n' + lines.join('\n') + '\n```';
}

export function buildStallOverviewEmbed(overview: StallOverview): EmbedBuilder {
  const { session, productBreakdown, cashTotal, cardTotal } = overview;
  const total = session.stats.total_revenue;
  const date = new Date(session.date).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`Stall Report: ${session.name}`)
    .setDescription(
      `**${session.location || 'Unknown location'}** — ${date}\n` +
      `Status: ${session.status === 'active' ? 'Active' : 'Closed'}`,
    )
    .addFields(
      { name: 'Total Revenue', value: formatGBP(total), inline: true },
      { name: 'Units Sold', value: `${session.stats.total_units}`, inline: true },
      { name: 'Transactions', value: `${session.stats.total_sales}`, inline: true },
      { name: 'Cash', value: formatGBP(cashTotal), inline: true },
      { name: 'Card', value: formatGBP(cardTotal), inline: true },
      { name: 'Best Seller', value: session.stats.best_seller || 'N/A', inline: true },
      { name: 'Product Breakdown', value: productTable(productBreakdown) },
    )
    .setFooter({ text: 'ForgeRealm POS' })
    .setTimestamp();

  return embed;
}

export function buildStallComparisonEmbed(comparison: StallComparison): EmbedBuilder {
  const { current, previous } = comparison;
  const curStats = current.session.stats;
  const prevStats = previous.session.stats;

  const curDate = new Date(current.session.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const prevDate = new Date(previous.session.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  // Build comparison table
  const lines: string[] = [];
  const w1 = 16, w2 = 12, w3 = 12, w4 = 16;
  lines.push(`${'Metric'.padEnd(w1)} | ${prevDate.padStart(w2)} | ${curDate.padStart(w3)} | ${'Change'.padStart(w4)}`);
  lines.push('─'.repeat(w1) + '─┼─' + '─'.repeat(w2) + '─┼─' + '─'.repeat(w3) + '─┼─' + '─'.repeat(w4));

  lines.push(
    `${'Revenue'.padEnd(w1)} | ${formatGBP(prevStats.total_revenue).padStart(w2)} | ${formatGBP(curStats.total_revenue).padStart(w3)} | ${changeStr(curStats.total_revenue, prevStats.total_revenue).padStart(w4)}`,
  );
  lines.push(
    `${'Units Sold'.padEnd(w1)} | ${String(prevStats.total_units).padStart(w2)} | ${String(curStats.total_units).padStart(w3)} | ${changeStr(curStats.total_units, prevStats.total_units).padStart(w4)}`,
  );
  lines.push(
    `${'Transactions'.padEnd(w1)} | ${String(prevStats.total_sales).padStart(w2)} | ${String(curStats.total_sales).padStart(w3)} | ${changeStr(curStats.total_sales, prevStats.total_sales).padStart(w4)}`,
  );
  lines.push(
    `${'Cash'.padEnd(w1)} | ${formatGBP(previous.cashTotal).padStart(w2)} | ${formatGBP(current.cashTotal).padStart(w3)} | ${changeStr(current.cashTotal, previous.cashTotal).padStart(w4)}`,
  );
  lines.push(
    `${'Card'.padEnd(w1)} | ${formatGBP(previous.cardTotal).padStart(w2)} | ${formatGBP(current.cardTotal).padStart(w3)} | ${changeStr(current.cardTotal, previous.cardTotal).padStart(w4)}`,
  );

  const compTable = '```\n' + lines.join('\n') + '\n```';

  // Top movers: products that changed most
  const curMap = new Map(current.productBreakdown.map((p) => [p.name, p]));
  const prevMap = new Map(previous.productBreakdown.map((p) => [p.name, p]));
  const allProducts = new Set([...curMap.keys(), ...prevMap.keys()]);

  const movers: { name: string; diff: number }[] = [];
  for (const name of allProducts) {
    const curUnits = curMap.get(name)?.units || 0;
    const prevUnits = prevMap.get(name)?.units || 0;
    movers.push({ name, diff: curUnits - prevUnits });
  }
  movers.sort((a, b) => b.diff - a.diff);

  let moverStr = '';
  if (movers.length > 0) {
    const top3 = movers.slice(0, 3).filter((m) => m.diff > 0);
    const bot3 = movers.slice(-3).filter((m) => m.diff < 0);
    if (top3.length) moverStr += '**Rising:** ' + top3.map((m) => `${m.name} (+${m.diff})`).join(', ') + '\n';
    if (bot3.length) moverStr += '**Falling:** ' + bot3.map((m) => `${m.name} (${m.diff})`).join(', ');
  }

  const embed = new EmbedBuilder()
    .setColor(NAVY)
    .setTitle(`Stall Comparison`)
    .setDescription(
      `**${previous.session.name}** (${prevDate}) vs **${current.session.name}** (${curDate})`,
    )
    .addFields(
      { name: 'Stats', value: compTable },
      { name: 'Best Seller (Current)', value: curStats.best_seller || 'N/A', inline: true },
      { name: 'Best Seller (Previous)', value: prevStats.best_seller || 'N/A', inline: true },
    )
    .setFooter({ text: 'ForgeRealm POS' })
    .setTimestamp();

  if (moverStr) {
    embed.addFields({ name: 'Product Movers', value: moverStr });
  }

  return embed;
}

export function buildProductQueryEmbed(
  productName: string,
  matches: ProductBreakdown[],
  sessionName: string,
): EmbedBuilder {
  if (matches.length === 0) {
    return new EmbedBuilder()
      .setColor(SAGE)
      .setTitle(`Product Search: ${productName}`)
      .setDescription(`No sales of "${productName}" found in **${sessionName}**.`)
      .setFooter({ text: 'ForgeRealm POS' })
      .setTimestamp();
  }

  const totalUnits = matches.reduce((sum, m) => sum + m.units, 0);
  const totalRevenue = matches.reduce((sum, m) => sum + m.revenue, 0);

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`Product Search: ${productName}`)
    .setDescription(`Results from **${sessionName}**`)
    .setFooter({ text: 'ForgeRealm POS' })
    .setTimestamp();

  for (const match of matches) {
    embed.addFields({
      name: match.name,
      value: `**${match.units}** sold — ${formatGBP(match.revenue)}`,
      inline: true,
    });
  }

  if (matches.length > 1) {
    embed.addFields({
      name: 'Total',
      value: `**${totalUnits}** units — ${formatGBP(totalRevenue)}`,
      inline: false,
    });
  }

  return embed;
}
