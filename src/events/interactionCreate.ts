import { Events, MessageFlags, type Interaction, Collection } from 'discord.js';
import { logger } from '../utils/logger.js';
import type { Command } from '../types.js';

export const name = Events.InteractionCreate;
export const once = false;

export async function execute(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return;

  const commands = (interaction.client as any).commands as Collection<string, Command>;
  const command = commands.get(interaction.commandName);

  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error({ error }, `Command failed: ${interaction.commandName}`);
    // The error reply itself can fail (expired interaction token, 10062 Unknown
    // interaction); that must never escape as an unhandled rejection.
    try {
      const reply = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral } as const;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (replyError) {
      logger.warn({ replyError }, 'Could not deliver command error reply');
    }
  }
}
