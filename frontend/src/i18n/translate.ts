import { en, messages, type Language, type MessageKey } from './messages';

export type MessageParams = Record<string, string | number>;

/** Looks a message up in `language`, falls back to English (never a raw key), and fills `{name}` slots. */
export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const template = messages[language][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (slot, name: string) => (name in params ? String(params[name]) : slot));
}
