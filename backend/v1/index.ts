import express from 'express';
import adminRoutes from './modules/admin/routes.js';
import authRoutes from './modules/auth/routes.js';
import availabilityRoutes from './modules/availability/routes.js';
import buildingsRoutes from './modules/buildings/routes.js';
import commuteRoutes from './modules/commute/routes.js';
import filesRoutes from './modules/files/routes.js';
import followUpsRoutes from './modules/follow-ups/routes.js';
import healthRoutes from './modules/health/routes.js';
import listersRoutes from './modules/listers/routes.js';
import meRoutes from './modules/me/routes.js';
import publicPagesRoutes from './modules/public-pages/routes.js';
import {
  areasPublicRoutes,
  categoriesPublicRoutes,
  currenciesPublicRoutes,
  serviceCategoriesPublicRoutes,
} from './modules/reference/routes.js';
import searchRoutes from './modules/search/routes.js';
import spaceTypesRoutes from './modules/space-types/routes.js';

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/me', meRoutes);
router.use('/admin', adminRoutes);
// Photos and files use absolute paths (/buildings/:id/photos, /photos/:id, /files/...).
router.use(filesRoutes);
// Catalogue (Phase 5): absolute paths too (/buildings..., /space-types/...).
router.use(buildingsRoutes);
router.use(spaceTypesRoutes);
// Availability (Phase 6): counts, bulk confirm, history, and the Admin follow-up queue.
router.use(availabilityRoutes);
router.use(followUpsRoutes);
// Public side (Phase 7): Guest-friendly via optionalSession. Search, building and space-type pages,
// tap-to-call events, lister profiles and the commute proxy.
router.use(searchRoutes);
router.use(publicPagesRoutes);
router.use(listersRoutes);
router.use(commuteRoutes);
router.use('/areas', areasPublicRoutes);
router.use('/currencies', currenciesPublicRoutes);
router.use('/categories', categoriesPublicRoutes);
router.use('/space-categories', categoriesPublicRoutes);
router.use('/service-categories', serviceCategoriesPublicRoutes);

export default router;
