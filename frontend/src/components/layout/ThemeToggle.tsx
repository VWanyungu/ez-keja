import { useLanguage } from '@/hooks/use-language';
import { useTheme } from '@/hooks/use-theme';

// Hairline strokes, matching the light icon weight of the rest of the design.
const ICON = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Shows the theme you would switch to: a sun while dark, a moon while light. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useLanguage();
  const toDark = resolvedTheme === 'light';

  return (
    <button
      type="button"
      onClick={() => setTheme(toDark ? 'dark' : 'light')}
      aria-label={t(toDark ? 'theme.toDark' : 'theme.toLight')}
      className="flex size-7 items-center justify-center rounded-full transition-[transform,background-color] duration-500 ease-fluid hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-90"
    >
      {toDark ? (
        <svg {...ICON}>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ) : (
        <svg {...ICON}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      )}
    </button>
  );
}
