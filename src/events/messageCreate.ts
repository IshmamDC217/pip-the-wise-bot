import { Events, Message, EmbedBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { aiService } from '../services/ai.service.js';
import { calendarService } from '../services/calendar.service.js';
import { sheetsService } from '../services/sheets.service.js';
import { db } from '../services/database.service.js';
import { addReminder } from '../monitors/reminder.monitor.js';
import { buildCalendarConfirmEmbed, buildUpcomingEventsEmbed } from '../embeds/calendar.embeds.js';
import { buildSheetCreatedEmbed } from '../embeds/sheets.embeds.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const name = Events.MessageCreate;
export const once = false;

export async function execute(message: Message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) return;

  const mentioned = message.mentions.has(message.client.user!);
  const saysPip = /\bpip\b/i.test(message.content);
  const isReply = message.reference?.messageId
    ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === message.client.user!.id
    : false;

  const explicitTrigger = mentioned || saysPip || isReply;

  // Smart triggering: if Pip was recently active in this channel, check if it's a follow-up
  let implicitTrigger = false;
  if (!explicitTrigger && aiService.wasRecentlyActive(message.channel.id)) {
    implicitTrigger = await aiService.isRelevantFollowUp(message.channel.id, content);
  }

  if (!explicitTrigger && !implicitTrigger) return;

  // Summon easter egg
  if (/summon\s+pip/i.test(content)) {
    const summons = [
      "you rang? this better be good i was in the middle of something important (nothing)",
      "oh hey, was wondering when someone would need me. what's up",
      "i have arrived. try to contain your excitement",
      "you summoned me like i wasn't already here watching everything. anyway what's good",
      "yeah yeah i'm here, what do you need — and don't say 'nothing' i can see you typing",
      "look who needs pip. can't say i'm surprised tbh, i am pretty great",
      "reporting for duty or whatever. seriously though what's going on",
      "i was literally right here the whole time but sure, 'summon' me, very dramatic",
    ];
    const pick = summons[Math.floor(Math.random() * summons.length)];
    await message.reply(pick);
    aiService.recordActivity(message.channel.id);
    return;
  }

  try {
    if ('sendTyping' in message.channel) await message.channel.sendTyping();

    // ── Intent: Calendar Read ─────────────────────
    if (aiService.hasCalendarReadIntent(content)) {
      logger.info({ content }, 'Calendar read intent detected');
      const events = await calendarService.getUpcomingEvents(10);
      logger.info({ eventCount: events.length, events: events.map((e: any) => e.summary) }, 'Calendar events fetched');
      const embed = buildUpcomingEventsEmbed(events);

      // Also get a conversational reply about the events
      const eventSummary = events.length > 0
        ? events.map((e: any) => {
            const date = e.start?.date || e.start?.dateTime?.split('T')[0] || 'TBD';
            return `${e.summary} on ${date}`;
          }).join(', ')
        : 'nothing';

      const reply = await aiService.chat(
        message.channel.id,
        message.author.displayName,
        `[CONTEXT: User asked about calendar. Upcoming events: ${eventSummary}. Respond naturally about what's coming up, don't list them all — the embed will show details.] ${content}`,
      );

      await message.reply({ content: reply, embeds: [embed] });
      return;
    }

    // ── Intent: Google Sheets ─────────────────────
    if (aiService.hasSheetsIntent(content)) {
      const sheetData = await aiService.extractSheetData(content);

      if (sheetData && sheetData.sheet) {
        const url = await sheetsService.createSpreadsheet(sheetData.sheet);

        if (url) {
          const embed = buildSheetCreatedEmbed(sheetData.sheet.title, url, sheetData.sheet.rows.length);
          await message.reply({ content: sheetData.reply, embeds: [embed] });
        } else {
          await message.reply("tried to make the sheet but something went wrong on google's end. classic google tbh");
        }
        aiService.recordActivity(message.channel.id);
        return;
      }
    }

    // ── Intent: Product CRUD ──────────────────────
    if (aiService.hasProductCrudIntent(content)) {
      const productData = await aiService.extractProductAction(content);

      if (productData && productData.action) {
        const { action } = productData;

        switch (action.type) {
          case 'create': {
            const id = await db.createProduct(
              action.name,
              action.price || 0,
              action.stock || 0,
              action.description,
            );

            if (id) {
              const embed = new EmbedBuilder()
                .setColor(0x84a98c)
                .setTitle('Product Created')
                .addFields(
                  { name: 'Name', value: action.name, inline: true },
                  { name: 'Price', value: `£${(action.price || 0).toFixed(2)}`, inline: true },
                  { name: 'Stock', value: `${action.stock || 0}`, inline: true },
                )
                .setTimestamp()
                .setFooter({ text: 'Pip Shop Manager' });

              if (action.description) embed.setDescription(action.description);
              await message.reply({ content: productData.reply, embeds: [embed] });
            } else {
              await message.reply("couldn't create that product, database said no. might want to check the logs");
            }
            break;
          }

          case 'update': {
            const product = await db.getProductByName(action.name);
            if (!product) {
              await message.reply(`couldn't find a product matching "${action.name}". double check the name?`);
              break;
            }

            if (action.updates && Object.keys(action.updates).length > 0) {
              const success = await db.updateProduct(product.id, action.updates);
              if (success) {
                const fields: string[] = [];
                if (action.updates.price !== undefined) fields.push(`price → £${action.updates.price.toFixed(2)}`);
                if (action.updates.stock !== undefined) fields.push(`stock → ${action.updates.stock}`);
                if (action.updates.name) fields.push(`name → ${action.updates.name}`);
                if (action.updates.description) fields.push(`description updated`);

                const embed = new EmbedBuilder()
                  .setColor(0xa3b18a)
                  .setTitle('Product Updated')
                  .setDescription(`**${product.name}**\n${fields.join('\n')}`)
                  .setTimestamp()
                  .setFooter({ text: 'Pip Shop Manager' });

                await message.reply({ content: productData.reply, embeds: [embed] });
              } else {
                await message.reply("update failed, something went wrong with the database");
              }
            }
            break;
          }

          case 'delete': {
            // Permission check
            if (!config.ADMIN_USER_IDS.includes(message.author.id)) {
              await message.reply("nice try but you don't have delete permissions. only admins can do that one");
              break;
            }

            const product = await db.getProductByName(action.name);
            if (!product) {
              await message.reply(`couldn't find a product matching "${action.name}". you sure about that name?`);
              break;
            }

            const success = await db.deleteProduct(product.id);
            if (success) {
              const embed = new EmbedBuilder()
                .setColor(0xef4444)
                .setTitle('Product Deleted')
                .setDescription(`**${product.name}** has been removed from the shop`)
                .addFields(
                  { name: 'Was priced at', value: `£${product.price.toFixed(2)}`, inline: true },
                  { name: 'Had stock', value: `${product.stock}`, inline: true },
                )
                .setTimestamp()
                .setFooter({ text: 'Pip Shop Manager' });

              await message.reply({ content: productData.reply, embeds: [embed] });
            } else {
              await message.reply("delete failed. product might already be gone or the database is being weird");
            }
            break;
          }
        }

        aiService.recordActivity(message.channel.id);
        return;
      }
    }

    // ── Intent: Calendar Create (with optional checklist) ──
    if (aiService.hasCalendarIntent(content)) {
      const calData = await aiService.extractCalendarData(content);

      if (calData && (calData.events.length > 0 || calData.reminders.length > 0)) {
        for (const event of calData.events) {
          const eventId = await calendarService.createEvent(event.summary, event.date, {
            allDay: event.allDay,
            time: event.time || undefined,
            checklist: event.checklist || undefined,
          });

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

        for (const rem of calData.reminders) {
          addReminder({
            id: randomUUID(),
            channelId: message.channel.id,
            createdBy: message.author.displayName,
            message: rem.message,
            dueAt: `${rem.dueDate}T09:00:00.000Z`,
            notified: false,
          });

          await calendarService.createEvent(rem.message, rem.dueDate, {
            allDay: true,
            description: `Reminder set by ${message.author.displayName}`,
          });
        }

        await message.reply({
          content: calData.reply,
          embeds: [buildCalendarConfirmEmbed(calData)],
        });
        aiService.recordActivity(message.channel.id);
        return;
      }
    }

    // ── Default: Chat ─────────────────────────────
    const reply = await aiService.chat(
      message.channel.id,
      message.author.displayName,
      content,
    );

    await message.reply(reply);
  } catch (err) {
    logger.error({ err }, 'Failed to process message');
  }
}
