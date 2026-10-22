import { Events, Message, EmbedBuilder } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { aiService } from '../services/ai.service.js';
import { calendarService } from '../services/calendar.service.js';
import { sheetsService } from '../services/sheets.service.js';
import { db } from '../services/database.service.js';
import { addReminder, cancelReminder, getPendingReminders } from '../monitors/reminder.monitor.js';
import { posService } from '../services/pos.service.js';
import { posTools } from '../services/pos.tools.js';
import { buildCalendarConfirmEmbed, buildUpcomingEventsEmbed, buildPendingRemindersEmbed } from '../embeds/calendar.embeds.js';
import { buildSheetCreatedEmbed } from '../embeds/sheets.embeds.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export const name = Events.MessageCreate;
export const once = false;

// Dedup guard — prevent processing the same message twice
const processed = new Set<string>();

const pickLine = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];

const FORGET_PATTERN = /\b(forget|reset|wipe|clear) (the |this |our |your )?(chat|convo|conversation|history|memory)\b/i;
// Anchored to the end of the message so "pip usage" matches but a passing
// mention like "the memory usage on the server" does not.
const USAGE_PATTERN = /\b((token|ai|groq|api)\s+)?(usage|quota)(\s+(report|stats|check))?\s*\??\s*$/i;
// "pip restart", "restart yourself pip", "pip reboot please". Anchored to the end
// and no trailing "?" so "should i restart?" is a question, not an order.
const RESTART_PATTERN = /\b(restart|reboot)\b(\s+(yourself|pip|the bot))?(\s+(please|pls))?\s*[.!]*$/i;

const CANCEL_REMINDER_PATTERN = /\b(cancel|delete|remove|scrap|drop)\b.*\breminders?\b/i;

// "remind me in 20 mins to flip the print" — handled in code, not by the LLM:
// small models get relative date arithmetic wrong (verified: "in 2 hours"
// landed on tomorrow), and this path costs zero tokens.
const RELATIVE_REMINDER_PATTERN = /\bremind\s+(?:me|us)\b(.*?)\bin\s+(\d+|a|an)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b(.*)/i;

function parseRelativeReminder(content: string): { dueAt: Date; task: string } | null {
  const m = content.match(RELATIVE_REMINDER_PATTERN);
  if (!m) return null;
  const n = /^\d+$/.test(m[2]) ? parseInt(m[2]) : 1;
  const unit = m[3].toLowerCase();
  const ms = unit.startsWith('d') ? n * 86400000 : unit.startsWith('h') ? n * 3600000 : n * 60000;
  if (ms <= 0 || ms > 365 * 86400000) return null;
  const task = `${m[1]} ${m[4]}`.replace(/^\s*(to|that|about)\b/i, '').replace(/\s+/g, ' ').trim();
  return { dueAt: new Date(Date.now() + ms), task: task || 'you asked me to remind you' };
}

/** Strip command/filler words so "cancel the reminder about the float" -> "float". */
function extractCancelQuery(content: string): string {
  return content
    .replace(/\breminders?\b/gi, ' ')
    .replace(/\b(cancel|delete|remove|scrap|drop|the|that|this|my|a|an|pip|please|pls|about|for|to|one)\b/gi, ' ')
    .replace(/[^\w\s'’-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a reminder timestamp from LLM-extracted date/time. The extraction model
 * can emit unpadded times ("9:00") or malformed dates; an unchecked
 * new Date().toISOString() would throw AFTER the calendar event was created,
 * killing the reply. Returns null when the date is unusable.
 */
function reminderDueAt(date: string, time?: string | null): string | null {
  const t = time && /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : '09:00';
  const d = new Date(`${date}T${t}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function execute(message: Message) {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (processed.has(message.id)) {
    logger.warn({ msgId: message.id }, 'DEDUP: blocked duplicate message');
    return;
  }
  processed.add(message.id);
  logger.info({ msgId: message.id, content: message.content, author: message.author.tag }, 'MSG: handler entered');
  // Keep the set from growing forever
  if (processed.size > 500) {
    const first = processed.values().next().value;
    if (first) processed.delete(first);
  }

  const content = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!content) return;

  const mentioned = message.mentions.has(message.client.user!);
  const saysPip = /\bpip\b/i.test(message.content);

  // Only pay the REST fetch for the referenced message when the cheap triggers
  // missed — most guild replies have nothing to do with the bot.
  let isReply = false;
  if (!mentioned && !saysPip && message.reference?.messageId) {
    const referenced = message.channel.messages.cache.get(message.reference.messageId)
      ?? await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    isReply = referenced?.author?.id === message.client.user!.id;
  }

  const explicitTrigger = mentioned || saysPip || isReply;

  // Smart triggering: if Pip was recently active in this channel, check if it's a follow-up
  let implicitTrigger = false;
  if (!explicitTrigger && aiService.wasRecentlyActive(message.channel.id)) {
    implicitTrigger = await aiService.isRelevantFollowUp(message.channel.id, content);
  }

  if (!explicitTrigger && !implicitTrigger) return;

  const isAdmin = config.ADMIN_USER_IDS.includes(message.author.id);

  try {
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
      await message.reply(pickLine(summons));
      aiService.recordActivity(message.channel.id);
      return;
    }

    // ── Admin: reset a wedged channel's conversation history ──
    if (isAdmin && explicitTrigger && FORGET_PATTERN.test(content)) {
      aiService.clearHistory(message.channel.id);
      await message.reply("wiped. fresh start, who are you people again");
      return;
    }

    // ── Admin: Groq usage check ──────────────────
    if (isAdmin && explicitTrigger && USAGE_PATTERN.test(content)) {
      const stats = aiService.getUsageStats();
      if (stats.length === 0) {
        await message.reply("no ai calls tracked since my last restart. quiet day");
      } else {
        const lines = stats.map(s => {
          const hours = Math.max(1, Math.round((Date.now() - s.since) / 3600000));
          return `**${s.model}**: ${s.requests} requests, ~${s.tokens.toLocaleString()} tokens over the last ${hours}h`;
        });
        await message.reply(`ai usage since tracking started:\n${lines.join('\n')}`);
      }
      return;
    }

    // ── Admin: restart. The process exits cleanly and the Windows service
    // (NSSM, AppExit=Restart) relaunches it, so a new build goes live without
    // anyone needing an admin shell on the laptop. ──
    if (isAdmin && explicitTrigger && RESTART_PATTERN.test(content)) {
      logger.info({ user: message.author.tag }, 'Restart requested from Discord');
      await message.reply("brb, restarting. give me about 20 seconds");
      // Routes through the SIGTERM handler in index.ts: monitors stop, the
      // Discord client disconnects, then exit(0).
      setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), 500);
      return;
    }

    // ── Cancel a reminder (checked before calendar-create so "delete the
    // reminder about X" doesn't get re-extracted as a new reminder) ──
    if (CANCEL_REMINDER_PATTERN.test(content)) {
      const result = cancelReminder(extractCancelQuery(content), message.author.id, isAdmin);
      if (result.ok) {
        await message.reply(`done, scrapped "${result.reminder.message}". one less thing to nag you about`);
      } else if (result.reason === 'none') {
        await message.reply("couldn't find a pending reminder matching that. try 'pip list reminders' to see what's actually set");
      } else if (result.reason === 'ambiguous') {
        const opts = (result.matches ?? []).slice(0, 5).map(r => `"${r.message}"`).join(', ');
        await message.reply(`that matches more than one: ${opts}. be a bit more specific?`);
      } else {
        await message.reply("that's someone else's reminder — only they (or an admin) can cancel it");
      }
      aiService.recordActivity(message.channel.id);
      return;
    }

    if ('sendTyping' in message.channel) await message.channel.sendTyping();

    // ── Intent: Calendar Read ─────────────────────
    if (aiService.hasCalendarReadIntent(content)) {
      logger.info({ content }, 'Calendar read intent detected');
      let events;
      try {
        events = await calendarService.getUpcomingEvents(10);
      } catch (err) {
        logger.error({ err }, 'Calendar fetch failed');
        await message.reply("couldn't reach google calendar just now. try again in a minute");
        aiService.recordActivity(message.channel.id);
        return;
      }
      logger.info({ eventCount: events.length }, 'Calendar events fetched');
      const embeds = [buildUpcomingEventsEmbed(events)];

      // Show pending reminders alongside the calendar — they're half the answer
      // to "what's coming up"
      const pending = getPendingReminders();
      if (pending.length > 0) embeds.push(buildPendingRemindersEmbed(pending));

      const eventSummary = events.length > 0
        ? events.map((e: any) => {
            const date = e.start?.date || e.start?.dateTime?.split('T')[0] || 'TBD';
            return `${e.summary} on ${date}`;
          }).join(', ')
        : 'nothing';
      const reminderSummary = pending.length > 0
        ? ` Pending reminders: ${pending.slice(0, 5).map(r => r.message).join(', ')}.`
        : '';

      const reply = await aiService.chat(
        message.channel.id,
        message.author.displayName,
        content,
        { context: `User asked about the calendar. Upcoming events: ${eventSummary}.${reminderSummary} Respond naturally about what's coming up, don't list them all — the embeds show details.` },
      );

      await message.reply({ content: reply.content, embeds });
      return;
    }

    // ── Intent: Google Sheets ─────────────────────
    if (aiService.hasSheetsIntent(content)) {
      const sheetData = await aiService.extractSheetData(content);

      if (!sheetData?.sheet) {
        await message.reply("i tried to work out what you wanted in that sheet but couldn't parse it. give me the columns and rows a bit more explicitly?");
        aiService.recordActivity(message.channel.id);
        return;
      }

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

    // ── Intent: Product CRUD ──────────────────────
    if (aiService.hasProductCrudIntent(content)) {
      const productData = await aiService.extractProductAction(content);

      if (!productData?.action) {
        await message.reply("couldn't work out exactly what product change you want. tell me the product name and what to do with it");
        aiService.recordActivity(message.channel.id);
        return;
      }

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
                { name: 'Price', value: `£${Number(action.price || 0).toFixed(2)}`, inline: true },
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
              if (action.updates.price !== undefined) fields.push(`price → £${Number(action.updates.price).toFixed(2)}`);
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
          if (!isAdmin) {
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
                { name: 'Was priced at', value: `£${Number(product.price).toFixed(2)}`, inline: true },
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

    // ── Relative reminder ("remind me in 20 mins to...") — deterministic, no LLM ──
    const relative = parseRelativeReminder(content);
    if (relative) {
      addReminder({
        id: randomUUID(),
        channelId: message.channel.id,
        createdBy: message.author.displayName,
        createdById: message.author.id,
        message: relative.task,
        dueAt: relative.dueAt.toISOString(),
        notified: false,
      });
      const when = relative.dueAt.toLocaleString('en-GB', {
        timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit',
        ...(relative.dueAt.getTime() - Date.now() > 86400000 ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
      });
      await message.reply(`sorted, i'll ping you at ${when} about "${relative.task}". consider it handled`);
      aiService.recordActivity(message.channel.id);
      return;
    }

    // ── Intent: Calendar Create (with optional checklist) ──
    if (aiService.hasCalendarIntent(content)) {
      const calData = await aiService.extractCalendarData(content);

      if (calData && (calData.events.length > 0 || calData.reminders.length > 0)) {
        const failures: string[] = [];

        for (const event of calData.events) {
          const eventId = await calendarService.createEvent(event.summary, event.date, {
            allDay: event.allDay,
            time: event.time || undefined,
            checklist: event.checklist || undefined,
          });
          if (!eventId) failures.push(event.summary);

          // The local Discord reminder is kept even when Google rejected the
          // event — it's the part that still works without the calendar.
          // Reminder fires at the event time if given, otherwise 9am local
          // (parsing without a Z suffix uses this machine's Europe/London time).
          const dueAt = reminderDueAt(event.date, event.time);
          if (dueAt) {
            addReminder({
              id: randomUUID(),
              channelId: message.channel.id,
              createdBy: message.author.displayName,
              createdById: message.author.id,
              message: `Event today: ${event.summary}`,
              dueAt,
              calendarEventId: eventId || undefined,
              notified: false,
            });
          }
        }

        for (const rem of calData.reminders) {
          const dueAt = reminderDueAt(rem.dueDate, rem.time);
          if (!dueAt) {
            failures.push(rem.message);
            continue;
          }

          addReminder({
            id: randomUUID(),
            channelId: message.channel.id,
            createdBy: message.author.displayName,
            createdById: message.author.id,
            message: rem.message,
            dueAt,
            notified: false,
          });

          const created = await calendarService.createEvent(rem.message, rem.dueDate, {
            allDay: true,
            description: `Reminder set by ${message.author.displayName}`,
          });
          if (!created) failures.push(rem.message);
        }

        if (failures.length > 0 && failures.length === calData.events.length + calData.reminders.length) {
          await message.reply("tried to add that to the calendar but google rejected it. worth checking the calendar setup, i'll keep the reminder side running here");
        } else if (failures.length > 0) {
          await message.reply({
            content: `${calData.reply}\n(heads up: couldn't add ${failures.map(f => `"${f}"`).join(', ')} to google calendar — check the logs)`,
            embeds: [buildCalendarConfirmEmbed(calData)],
          });
        } else {
          await message.reply({
            content: calData.reply,
            embeds: [buildCalendarConfirmEmbed(calData)],
          });
        }
        aiService.recordActivity(message.channel.id);
        return;
      }
    }

    // ── Default: Chat (with POS lookups on tap) ───
    // Any question that needs stall, product or stock figures lands here and
    // the model fetches what it needs, so phrasing doesn't have to match a
    // keyword list and every number it quotes comes from a real lookup.
    const reply = await aiService.chat(
      message.channel.id,
      message.author.displayName,
      content,
      { tools: posService.isConfigured() ? posTools : undefined },
    );

    await message.reply({ content: reply.content, embeds: reply.embeds });
  } catch (err) {
    logger.error({ err }, 'Failed to process message');
  }
}
