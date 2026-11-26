import { useQuery } from '@tanstack/react-query';
import { getAreas, getCategories, getCurrencies } from '@/api/reference';
import { queryKeys } from '@/api/query-keys';

// Reference data changes when an Admin edits it, so a few minutes of caching is plenty.
const STALE_TIME = 10 * 60_000;

export const useAreas = () =>
  useQuery({ queryKey: queryKeys.reference.areas, queryFn: getAreas, staleTime: STALE_TIME });

export const useCurrencies = () =>
  useQuery({ queryKey: queryKeys.reference.currencies, queryFn: getCurrencies, staleTime: STALE_TIME });

export const useCategories = () =>
  useQuery({ queryKey: queryKeys.reference.categories, queryFn: getCategories, staleTime: STALE_TIME });
