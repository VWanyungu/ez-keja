import { useEffect, useRef, useState } from 'react';
import searchUrl from '@/assets/icons/search.svg';
import { useLanguage } from '@/hooks/use-language';
import { MAX_QUERY_LENGTH } from '@/lib/search-params';
import { cn } from '@/lib/utils';
import type { SearchFilters } from '@/types/search';

const DEBOUNCE_MS = 350;

interface SearchBarProps {
  values: SearchFilters;
  onChange: (next: SearchFilters) => void;
  className?: string;
}

/** Free-text search over building and area names. Typing searches after a short pause; Enter or the button searches at once. */
export function SearchBar({ values, onChange, className }: SearchBarProps) {
  const { t } = useLanguage();
  const [text, setText] = useState(values.q ?? '');
  // What the URL last held or we last sent: the guard against echoing our own change back.
  const sent = useRef(values.q ?? '');
  const latest = useRef({ values, onChange });
  useEffect(() => {
    latest.current = { values, onChange };
  });

  // The URL is the source of truth: "Clear filters" or the back button replaces what is typed.
  useEffect(() => {
    const external = values.q ?? '';
    if (external !== sent.current) {
      sent.current = external;
      setText(external);
    }
  }, [values.q]);

  const commit = (raw: string) => {
    const next = raw.trim();
    if (next === sent.current) return;
    sent.current = next;
    latest.current.onChange({ ...latest.current.values, q: next || undefined });
  };

  useEffect(() => {
    const timer = setTimeout(() => commit(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        commit(text);
      }}
      className={cn(
        'flex items-center gap-3 rounded-full border border-line bg-muted py-2 pl-7 pr-2 transition-shadow duration-300 ease-fluid focus-within:ring-2 focus-within:ring-ring',
        className,
      )}
    >
      <input
        type="search"
        value={text}
        maxLength={MAX_QUERY_LENGTH}
        onChange={(e) => setText(e.target.value)}
        aria-label={t('search.label')}
        placeholder={t('search.placeholder')}
        className="min-w-0 flex-1 bg-transparent text-[15px] leading-6 text-foreground placeholder:text-muted-foreground focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <button
        type="submit"
        aria-label={t('search.submit')}
        className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-primary transition-colors duration-300 ease-fluid hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <img src={searchUrl} alt="" className="size-[18px]" />
      </button>
    </form>
  );
}
