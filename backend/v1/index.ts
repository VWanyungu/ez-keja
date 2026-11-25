import express from 'express';
import adminRoutes from './modules/admin/routes.js';
import authRoutes from './modules/auth/routes.js';
import filesRoutes from './modules/files/routes.js';
import healthRoutes from './modules/health/routes.js';
import meRoutes from './modules/me/routes.js';
import {
  areasPublicRoutes,
  categoriesPublicRoutes,
  currenciesPublicRoutes,
  serviceCategoriesPublicRoutes,
} from './modules/reference/routes.js';

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/me', meRoutes);
router.use('/admin', adminRoutes);
// Photos and files use absolute paths (/buildings/:id/photos, /photos/:id, /files/...).
router.use(filesRoutes);
router.use('/areas', areasPublicRoutes);
router.use('/currencies', currenciesPublicRoutes);
router.use('/categories', categoriesPublicRoutes);
router.use('/space-categories', categoriesPublicRoutes);
router.use('/service-categories', serviceCategoriesPublicRoutes);

export default router;
