import { api } from './client';
import type { Area, Currency, SpaceCategory } from '@/types/reference';

export const getAreas = () => api<Area[]>('/areas');

export const getCurrencies = () => api<Currency[]>('/currencies');

export const getCategories = () => api<SpaceCategory[]>('/space-categories');
