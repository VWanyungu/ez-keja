import { api } from './client';
import type { SearchPage } from '@/types/search';

/** `query` is already serialised by `toApiQuery`. */
export const searchBuildings = (query: string) => api<SearchPage>(`/search/buildings?${query}`);
