import { Events, Message } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { aiService } from '../services/ai.service.js';
import { calendarService } from '../services/calendar.service.js';
import { addReminder } from '../monitors/reminder.monitor.js';
import { buildCalendarConfirmEmbed } from '../embeds/calendar.embeds.js';
import { logger } from '../utils/logger.js';

export const name = Events.MessageCreate;
export const once = false;

export async function execute(message: Message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const mentioned = message.mentions.has(message.client.user!);
  const saysPip = /\bpip\b/i.test(message.content);
  const isReply = message.reference?.messageId
    ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === message.client.user!.id
    : false;

  if (!mentioned && !saysPip && !isReply) return;

  const content = message.content
    .replace(/<@!?\d+>/g, '')
    .trim();

  if (!content) return;

  try {
    if ('sendTyping' in message.channel) await message.channel.sendTyping();

    // Check for calendar/reminder intent
    if (aiService.hasCalendarIntent(content)) {
      const calData = await aiService.extractCalendarData(content);

      if (calData && (calData.events.length > 0 || calData.reminders.length > 0)) {
        // Create Google Calendar events
        for (const event of calData.events) {
          const eventId = await calendarService.createEvent(event.summary, event.date, {
            allDay: event.allDay,
            time: event.time || undefined,
          });

          // Also create a Discord reminder for the event day
          addReminder({
            id: randomUUID(),
            channelId: message.channel.id,
            createdBy: message.author.displayName,
            message: `Event today: ${event.summary}`,
            dueAt: `${event.date}T09:00:00.000Z`,
            calendarEventId: eventId || undefined,
            notified: false,
          });
        }

        // Save Discord reminders
        for (const rem of calData.reminders) {
          addReminder({
            id: randomUUID(),
            channelId: message.channel.id,
            createdBy: message.author.displayName,
            message: rem.message,
            dueAt: `${rem.dueDate}T09:00:00.000Z`,
            notified: false,
          });

          // Also add to Google Calendar
          await calendarService.createEvent(rem.message, rem.dueDate, {
            allDay: true,
            description: `Reminder set by ${message.author.displayName}`,
          });
        }

        // Send confirmation with embed
        await message.reply({
          content: calData.reply,
          embeds: [buildCalendarConfirmEmbed(calData)],
        });
        return;
      }
    }

    // Regular chat if no calendar intent
    const reply = await aiService.chat(
      message.channel.id,
      message.author.displayName,
      content,
    );

    await message.reply(reply);
  } catch (err) {
    logger.error({ err }, 'Failed to send reply');
  }
}
