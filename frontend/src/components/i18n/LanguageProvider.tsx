import { useCallback, useEffect, useMemo, useState } from 'react';
import { LanguageContext } from '@/hooks/use-language';
import { LANGUAGES, type Language, type MessageKey } from '@/i18n/messages';
import { translate, type MessageParams } from '@/i18n/translate';

// A per-device preference (FR-LOC-001: remember the choice), so localStorage is fine here.
const STORAGE_KEY = 'khunt-language';
const DEFAULT_LANGUAGE: Language = 'en';

function readStored(): Language {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (LANGUAGES.includes(value as Language)) return value as Language;
  } catch {
    // Storage can be blocked (private mode); the default applies.
  }
  return DEFAULT_LANGUAGE;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readStored);

  // Keeps screen readers, hyphenation and browser translation prompts in step with the UI.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved, but the choice still applies for this visit.
    }
  }, []);

  const t = useCallback((key: MessageKey, params?: MessageParams) => translate(language, key, params), [language]);

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
