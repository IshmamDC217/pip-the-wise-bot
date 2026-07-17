import { EmbedBuilder } from 'discord.js';
import type { DBUser, DBProduct } from '../types.js';

const SAGE = 0x84a98c;
const OLIVE = 0xa3b18a;

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user[0]}***@${domain}`;
}

export function buildNewUserEmbed(user: DBUser, totalUsers: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(SAGE)
    .setTitle('New User Registered')
    .setDescription(`A new user has joined ForgeRealm!`)
    .addFields(
      { name: 'Username', value: user.username, inline: true },
      { name: 'Email', value: maskEmail(user.email), inline: true },
      { name: 'Status', value: user.email_verified ? 'Verified' : 'Awaiting verification', inline: true },
      { name: 'Total Users', value: `${totalUsers}`, inline: true },
    )
    .setFooter({ text: 'ForgeRealm Shop' })
    .setTimestamp();
}

export function buildUserVerifiedEmbed(user: DBUser): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(OLIVE)
    .setTitle('User Verified')
    .setDescription(`**${user.username}** has verified their email and activated their account.`)
    .setFooter({ text: 'ForgeRealm Shop' })
    .setTimestamp();
}

export function buildNewProductEmbed(product: DBProduct): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(SAGE)
    .setTitle('New Product Added')
    .setDescription(`**${product.name}**`)
    .addFields(
      { name: 'Price', value: `£${Number(product.price).toFixed(2)}`, inline: true },
      { name: 'Stock', value: `${product.stock} units`, inline: true },
    )
    .setFooter({ text: 'ForgeRealm Shop' })
    .setTimestamp();

  if (product.description) {
    embed.addFields({ name: 'Description', value: product.description.slice(0, 200) });
  }

  return embed;
}

export function buildStockChangeEmbed(
  name: string,
  oldStock: number,
  newStock: number,
): EmbedBuilder {
  const diff = newStock - oldStock;
  const arrow = diff > 0 ? '+' : '';
  const color = diff < 0 ? 0xf59e0b : OLIVE; // amber for decrease, olive for increase

  return new EmbedBuilder()
    .setColor(color)
    .setTitle('Stock Update')
    .setDescription(`**${name}**`)
    .addFields(
      { name: 'Previous', value: `${oldStock} units`, inline: true },
      { name: 'Now', value: `${newStock} units`, inline: true },
      { name: 'Change', value: `${arrow}${diff}`, inline: true },
    )
    .setFooter({ text: 'ForgeRealm Shop' })
    .setTimestamp();
}
