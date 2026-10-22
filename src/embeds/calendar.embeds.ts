import { EmbedBuilder } from 'discord.js';
import type { Reminder, CalendarExtraction } from '../types.js';

const COLORS = {
  primary: 0x84a98c,
  reminder: 0xf59e0b,
};

export function buildReminderEmbed(reminder: Reminder): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.reminder)
    .setTitle('Reminder')
    .setDescription(reminder.message)
    .addFields({ name: 'Created by', value: reminder.createdBy, inline: true })
    .setTimestamp()
    .setFooter({ text: 'Pip Reminders' });
}

export function buildCalendarConfirmEmbed(data: CalendarExtraction): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Calendar Updated')
    .setTimestamp()
    .setFooter({ text: 'Pip Calendar' });

  if (data.events.length > 0) {
    const eventLines = data.events
      .map((e) => {
        let line = `**${e.summary}** — ${formatDate(e.date)}${e.time ? ` at ${e.time}` : ''}`;
        if (e.checklist && e.checklist.length > 0) {
          line += '\n' + e.checklist.map((item) => `  ☐ ${item}`).join('\n');
        }
        return line;
      })
      .join('\n\n');
    embed.addFields({ name: 'Events', value: eventLines });
  }

  if (data.reminders.length > 0) {
    const reminderLines = data.reminders
      .map((r) => `${r.message} — ${formatDate(r.dueDate)}${r.time ? ` at ${r.time}` : ''}`)
      .join('\n');
    embed.addFields({ name: 'Reminders', value: reminderLines });
  }

  return embed;
}

export function buildUpcomingEventsEmbed(events: any[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle('Upcoming Events')
    .setTimestamp()
    .setFooter({ text: 'ForgeRealm Calendar' });

  if (events.length === 0) {
    embed.setDescription('No upcoming events');
    return embed;
  }

  const lines = events.map((e) => {
    const date = e.start?.date || e.start?.dateTime?.split('T')[0] || 'TBD';
    const time = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'All day';
    return `**${e.summary}** — ${formatDate(date)} (${time})`;
  });

  embed.setDescription(lines.join('\n'));
  return embed;
}

export function buildPendingRemindersEmbed(reminders: Reminder[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.reminder)
    .setTitle('Pending Reminders')
    .setTimestamp()
    .setFooter({ text: 'Pip Reminders' });

  if (reminders.length === 0) {
    embed.setDescription('No pending reminders');
    return embed;
  }

  // Cap the list — an unbounded join eventually exceeds the 4096-char
  // description limit and the whole /calendar command starts failing.
  const MAX_LISTED = 15;
  const lines = reminders
    .slice(0, MAX_LISTED)
    .map((r) => {
      const due = new Date(r.dueAt);
      const time = Number.isNaN(due.getTime())
        ? ''
        : ` ${due.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      return `${r.message} — ${formatDate(r.dueAt.split('T')[0])}${time} (by ${r.createdBy})`;
    });
  if (reminders.length > MAX_LISTED) {
    lines.push(`...and ${reminders.length - MAX_LISTED} more`);
  }
  embed.setDescription(lines.join('\n').slice(0, 4096));
  return embed;
}

function formatDate(dateStr: string): string {
  // new Date('garbage') doesn't throw — it yields Invalid Date, which would
  // render as the literal string "Invalid Date" in the embed.
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
