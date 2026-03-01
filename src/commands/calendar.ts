import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { calendarService } from '../services/calendar.service.js';
import { getPendingReminders } from '../monitors/reminder.monitor.js';
import { buildUpcomingEventsEmbed, buildPendingRemindersEmbed } from '../embeds/calendar.embeds.js';

export const data = new SlashCommandBuilder()
  .setName('calendar')
  .setDescription('View upcoming events and pending reminders');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const events = await calendarService.getUpcomingEvents(10);
  const reminders = getPendingReminders();

  const embeds = [
    buildUpcomingEventsEmbed(events),
    buildPendingRemindersEmbed(reminders),
  ];

  await interaction.editReply({ embeds });
}
