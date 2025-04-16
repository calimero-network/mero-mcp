import express from 'express';
import toolsRouter from './tools';

const router = express.Router();

// Mount routes
router.use('/api/tools', toolsRouter);

export default router; 