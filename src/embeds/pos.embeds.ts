import { EmbedBuilder } from 'discord.js';

const FORGE_ORANGE = 0xe07a2f;
const FORGE_GREEN = 0x84a98c;

// The POS API returns full ISO timestamps; show a plain en-GB date instead.
function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB');
}

interface SessionStats {
  name: string;
  date: string;
  location?: string | null;
  status: string;
  stats: {
    total_revenue: number | string;
    total_units: number | string;
    total_sales: number | string;
    best_seller: string | null;
  };
}

export function buildSessionStatsEmbed(session: SessionStats): EmbedBuilder {
  const revenue = Number(session.stats.total_revenue).toFixed(2);
  const color = session.status === 'active' ? FORGE_ORANGE : FORGE_GREEN;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Stall: ${session.name}`)
    .addFields(
      { name: 'Date', value: formatDate(session.date), inline: true },
      { name: 'Status', value: session.status === 'active' ? 'Live' : 'Closed', inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Revenue', value: `£${revenue}`, inline: true },
      { name: 'Units Sold', value: `${session.stats.total_units}`, inline: true },
      { name: 'Transactions', value: `${session.stats.total_sales}`, inline: true },
    )
    .setFooter({ text: 'ForgeRealm POS' })
    .setTimestamp();

  if (session.location) {
    embed.spliceFields(1, 0, { name: 'Location', value: session.location, inline: true });
  }

  if (session.stats.best_seller) {
    embed.addFields({ name: 'Best Seller', value: session.stats.best_seller });
  }

  return embed;
}

interface SessionOverview {
  name: string;
  date: string;
  location: string | null;
  status: string;
  total_revenue?: number | string;
  total_units?: number | string;
}

export function buildSessionsOverviewEmbed(sessions: SessionOverview[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(FORGE_ORANGE)
    .setTitle('ForgeRealm POS — Sessions')
    .setFooter({ text: 'ForgeRealm POS' })
    .setTimestamp();

  const shown = sessions.slice(0, 8);
  for (const s of shown) {
    const rev = s.total_revenue != null ? `£${Number(s.total_revenue).toFixed(2)}` : '£0.00';
    const units = s.total_units != null ? `${s.total_units}` : '0';
    const loc = s.location ? ` — ${s.location}` : '';
    const status = s.status === 'active' ? ' (Live)' : '';
    embed.addFields({
      name: `${s.name}${status}`,
      value: `${formatDate(s.date)}${loc}\n${rev} revenue · ${units} units`,
    });
  }

  if (sessions.length > 8) {
    embed.setDescription(`Showing 8 of ${sessions.length} sessions`);
  }

  return embed;
}
