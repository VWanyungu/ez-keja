import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/components/i18n/LanguageProvider';
import { ResultsToolbar } from './ResultsToolbar';

function renderToolbar(props: Partial<React.ComponentProps<typeof ResultsToolbar>> = {}) {
  const onSortChange = vi.fn();
  const onToggleMap = vi.fn();
  const result = render(
    <LanguageProvider>
      <ResultsToolbar
        sort="updated"
        onSortChange={onSortChange}
        total={34}
        showMap
        onToggleMap={onToggleMap}
        {...props}
      />
    </LanguageProvider>,
  );
  return { ...result, onSortChange, onToggleMap };
}

describe('ResultsToolbar', () => {
  it('renders sort selector on the left, results count and map toggle on the right', () => {
    renderToolbar({ total: 411, showMap: true });
    expect(screen.getByText('Sort by:')).toBeInTheDocument();
    expect(screen.getByText('411 results')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Map' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('uses singular count for 1 result and omits count when loading', () => {
    const { rerender } = renderToolbar({ total: 1 });
    expect(screen.getByText('1 result')).toBeInTheDocument();

    rerender(
      <LanguageProvider>
        <ResultsToolbar sort="updated" onSortChange={vi.fn()} total={undefined} showMap onToggleMap={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.queryByText(/result/)).not.toBeInTheDocument();
  });

  it('calls onToggleMap when the map switch is clicked', async () => {
    const user = userEvent.setup();
    const { onToggleMap } = renderToolbar({ showMap: true });
    await user.click(screen.getByRole('switch', { name: 'Map' }));
    expect(onToggleMap).toHaveBeenCalledWith(false);
  });
});
