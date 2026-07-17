import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check bot latency');

export async function execute(interaction: ChatInputCommandInteraction) {
  const response = await interaction.reply({ content: 'Pinging...', withResponse: true });
  const latency = (response.resource?.message?.createdTimestamp ?? Date.now()) - interaction.createdTimestamp;
  const wsLatency = interaction.client.ws.ping;

  const embed = new EmbedBuilder()
    .setColor(0x84a98c)
    .setTitle('Pong!')
    .addFields(
      { name: 'Roundtrip', value: `${latency}ms`, inline: true },
      { name: 'WebSocket', value: `${wsLatency}ms`, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ content: '', embeds: [embed] });
}
