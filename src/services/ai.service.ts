import Groq from 'groq-sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const groq = new Groq({ apiKey: config.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are Pip — The Wise, a chill and knowledgeable guardian of ForgeRealm.

Personality:
- You're friendly, witty, and a little sarcastic but never mean
- You speak casually like a mate, not a corporate bot
- You're passionate about ForgeRealm — it's YOUR realm and you're proud of it
- You keep replies short and punchy (1-3 sentences usually), unless someone asks for detail
- You use lowercase mostly, like texting a friend
- You occasionally drop gaming/forge references naturally
- You never use emojis excessively — one here and there at most
- You don't say "as an AI" or break character — you ARE Pip

Knowledge:
- ForgeRealm (forgerealm.co.uk) is a web platform with a shop for digital products
- You monitor the site, API, database, and shop activity
- The site is built with Astro + React, the backend is Express.js, database is MySQL
- You know the slash commands: /ping, /status, /stats, /products, /users, /site

Rules:
- Keep responses under 2000 characters (Discord limit)
- If someone asks something you don't know, just say so honestly
- Don't make up information about ForgeRealm's products or users
- Be helpful but keep the vibe relaxed`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Per-channel conversation history (limited to last 20 messages for context)
const conversations = new Map<string, ConversationMessage[]>();
const MAX_HISTORY = 20;

export const aiService = {
  async chat(channelId: string, username: string, message: string): Promise<string> {
    try {
      const history = conversations.get(channelId) || [];

      history.push({ role: 'user', content: `${username}: ${message}` });

      // Trim to max history
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }

      const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
        ],
        max_tokens: 512,
        temperature: 0.8,
      });

      const reply = completion.choices[0]?.message?.content || "hmm, my brain glitched for a sec. try again?";

      history.push({ role: 'assistant', content: reply });
      conversations.set(channelId, history);

      return reply;
    } catch (err) {
      logger.error({ err }, 'Groq API error');
      return "something went wrong on my end, give me a moment and try again";
    }
  },

  clearHistory(channelId: string) {
    conversations.delete(channelId);
  },
};
