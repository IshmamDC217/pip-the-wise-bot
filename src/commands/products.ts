import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { db } from '../services/database.service.js';

export const data = new SlashCommandBuilder()
  .setName('products')
  .setDescription('List all ForgeRealm shop products');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const products = await db.getAllProducts();

  if (products.length === 0) {
    await interaction.editReply('No products in the shop yet.');
    return;
  }

  // Cap the listing: past ~25 products the description exceeds Discord's
  // 4096-char embed limit and the command starts failing outright.
  const MAX_LISTED = 25;
  const listed = products.slice(0, MAX_LISTED);
  let description = listed
    .map(
      (p) =>
        `**${p.name}** — £${Number(p.price).toFixed(2)} | ${p.stock} in stock\n${p.description?.slice(0, 80) || 'No description'}`,
    )
    .join('\n\n');
  if (products.length > MAX_LISTED) {
    description += `\n\n...and ${products.length - MAX_LISTED} more`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x84a98c)
    .setTitle('ForgeRealm — Shop Products')
    .setDescription(description.slice(0, 4096))
    .setFooter({ text: `${products.length} product(s)` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
