import express from 'express';
import adminRoutes from './modules/admin/routes.js';
import authRoutes from './modules/auth/routes.js';
import healthRoutes from './modules/health/routes.js';
import meRoutes from './modules/me/routes.js';

const router = express.Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/me', meRoutes);
router.use('/admin', adminRoutes);

export default router;
