import { Events, Message } from 'discord.js';
import { aiService } from '../services/ai.service.js';
import { logger } from '../utils/logger.js';

export const name = Events.MessageCreate;
export const once = false;

export async function execute(message: Message) {
  // Ignore bots and DMs
  if (message.author.bot) return;
  if (!message.guild) return;

  // Respond when: @mentioned, replied to, or message contains "pip"
  const mentioned = message.mentions.has(message.client.user!);
  const saysPip = /\bpip\b/i.test(message.content);
  const isReply = message.reference?.messageId
    ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === message.client.user!.id
    : false;

  if (!mentioned && !saysPip && !isReply) return;

  // Strip the bot mention from the message
  const content = message.content
    .replace(/<@!?\d+>/g, '')
    .trim();

  if (!content) return;

  try {
    if ('sendTyping' in message.channel) await message.channel.sendTyping();

    const reply = await aiService.chat(
      message.channel.id,
      message.author.displayName,
      content,
    );

    await message.reply(reply);
  } catch (err) {
    logger.error({ err }, 'Failed to send AI reply');
  }
}
