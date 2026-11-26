import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/components/i18n/LanguageProvider';
import { MobileFiltersSheet } from './MobileFiltersSheet';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('MobileFiltersSheet', () => {
  it('shows active filter count, clears only panel filters, and closes on Show results', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onChange = vi.fn();

    render(
      <LanguageProvider>
        <MobileFiltersSheet
          open
          onClose={onClose}
          values={{ q: 'Ngong', sort: 'rent_asc', areaId: 'a1', verifiedOnly: true }}
          onChange={onChange}
          areas={[{ id: 'a1', name: 'Ngong Town', slug: 'ngong-town', centreLat: -1.35, centreLng: 36.66 }]}
          categories={[]}
          total={411}
        />
      </LanguageProvider>,
    );

    expect(screen.getByText('2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(onChange).toHaveBeenCalledWith({ q: 'Ngong', sort: 'rent_asc' });

    await user.click(screen.getByRole('button', { name: 'Show 411 results' }));
    expect(onClose).toHaveBeenCalled();
  });
});
