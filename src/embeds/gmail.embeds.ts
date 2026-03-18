import { EmbedBuilder } from 'discord.js';
import type { ParsedEmail } from '../services/gmail.service.js';

const COLORS: Record<ParsedEmail['sender'], number> = {
  artsmix: 0xe07c24,     // warm orange — events/stalls
  natwest: 0x6b1fa1,     // natwest purple
  'ionos-billing': 0x003d8f, // ionos blue
  unknown: 0x84a98c,     // sage fallback
};

const LABELS: Record<ParsedEmail['sender'], string> = {
  artsmix: 'Artsmix',
  natwest: 'NatWest',
  'ionos-billing': 'IONOS Billing',
  unknown: 'Email',
};

const ICONS: Record<ParsedEmail['sender'], string> = {
  artsmix: 'Stall / Event',
  natwest: 'Banking',
  'ionos-billing': 'Hosting Invoice',
  unknown: 'General',
};

export function buildEmailAlertEmbed(email: ParsedEmail): EmbedBuilder {
  const label = LABELS[email.sender];
  const color = COLORS[email.sender];
  const category = ICONS[email.sender];

  // Truncate snippet if too long
  const snippet = email.snippet.length > 300
    ? email.snippet.slice(0, 297) + '...'
    : email.snippet;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`New ${label} Email`)
    .setDescription(`**${email.subject}**\n\n${snippet}`)
    .addFields(
      { name: 'From', value: email.from, inline: true },
      { name: 'Category', value: category, inline: true },
      { name: 'Received', value: email.date || 'Unknown', inline: true },
    )
    .setFooter({ text: 'Pip Mail Monitor' })
    .setTimestamp();
}
