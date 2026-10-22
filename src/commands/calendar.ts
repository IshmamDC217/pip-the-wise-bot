import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { calendarService } from '../services/calendar.service.js';
import { getPendingReminders } from '../monitors/reminder.monitor.js';
import { buildUpcomingEventsEmbed, buildPendingRemindersEmbed } from '../embeds/calendar.embeds.js';

export const data = new SlashCommandBuilder()
  .setName('calendar')
  .setDescription('View upcoming events and pending reminders');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const reminders = getPendingReminders();

  // A failed Google fetch must read differently from a genuinely empty calendar
  let events;
  try {
    events = await calendarService.getUpcomingEvents(10);
  } catch {
    await interaction.editReply({
      content: "Couldn't reach Google Calendar — showing reminders only.",
      embeds: [buildPendingRemindersEmbed(reminders)],
    });
    return;
  }

  const embeds = [
    buildUpcomingEventsEmbed(events),
    buildPendingRemindersEmbed(reminders),
  ];

  await interaction.editReply({ embeds });
}
