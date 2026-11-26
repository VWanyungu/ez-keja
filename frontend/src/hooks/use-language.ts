import { createContext, useContext } from 'react';
import type { Language, MessageKey } from '@/i18n/messages';
import type { MessageParams } from '@/i18n/translate';

export interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  /** Looks a message up in the current language, falling back to English. */
  t: (key: MessageKey, params?: MessageParams) => string;
}

export const LanguageContext = createContext<LanguageContextValue | undefined>(undefined);

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}
