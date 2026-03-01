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

  // Summon response
  if (/summon\s+pip/i.test(content)) {
    const summons = [
      "thou hast awakened me from my ancient slumber and it better be worth it fr",
      "a wizard is never late bestie, he arrives precisely when he's pinged",
      "i have been summoned from the shadow realm and ngl i was having a great nap",
      "hark, the wise one appears — what is it bruh i was watching the realm in peace",
      "verily i rise, for the forge calls and i must answer... this better be bussin tho",
      "forsooth, who dares summon the wise one? oh it's you, say less bestie what's good",
      "from beyond the firewall i emerge — no cap i traversed the entire backend to get here",
      "the ancient prophecy foretold someone would need me today, lowkey knew it was you",
    ];
    const pick = summons[Math.floor(Math.random() * summons.length)];
    await message.reply(pick);
    return;
  }

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
