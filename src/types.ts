import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export interface MonitorState {
  lastUserCheck: string;
  lastVerifiedCheck: string;
  lastProductCheck: string;
  stockSnapshot: Record<number, number>;
  pageHashes: Record<string, string>;
  apiUp: boolean;
  apiDownSince: string | null;
  lastNudgeAt: string | null;
}

export interface DBUser {
  id: number;
  username: string;
  email: string;
  role: string;
  email_verified: boolean;
  created_at: string;
  email_verified_at?: string;
}

export interface Reminder {
  id: string;
  channelId: string;
  createdBy: string;
  // Discord user ID so the reminder can @mention its creator when it fires
  // (optional: reminders saved before this field existed don't have it)
  createdById?: string;
  message: string;
  dueAt: string;
  calendarEventId?: string;
  notified: boolean;
}

export interface CalendarEventData {
  summary: string;
  date: string;
  allDay: boolean;
  time?: string;
  checklist?: string[];
}

export interface CalendarExtraction {
  events: CalendarEventData[];
  reminders: { message: string; dueDate: string; time?: string | null }[];
  reply: string;
}

export interface SheetData {
  title: string;
  headers: string[];
  rows: (string | number)[][];
  currencyColumns: number[];
  includeTotal: boolean;
}

export interface SheetExtraction {
  sheet: SheetData;
  reply: string;
}

export interface ProductAction {
  type: 'create' | 'update' | 'delete';
  name: string;
  price?: number;
  stock?: number;
  description?: string;
  updates?: Partial<{ name: string; price: number; stock: number; description: string }>;
}

export interface ProductExtraction {
  action: ProductAction;
  reply: string;
}

export interface DBProduct {
  id: number;
  name: string;
  description: string;
  price: number;
  stock: number;
  created_at: string;
  primary_image?: string;
}
