export const queryKeys = {
  reference: {
    areas: ['reference', 'areas'] as const,
    currencies: ['reference', 'currencies'] as const,
    categories: ['reference', 'categories'] as const,
  },
  search: {
    all: ['search'] as const,
    /** `query` is the serialised search string, so equal searches share a cache entry. */
    buildings: (query: string) => ['search', 'buildings', query] as const,
  },
} as const;
