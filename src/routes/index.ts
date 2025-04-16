import express from 'express';
import toolsRouter from './tools';
import jsonrpcRouter from './jsonrpc';

const router = express.Router();

// Mount routes
router.use('/api/tools', toolsRouter);
router.use('/jsonrpc', jsonrpcRouter);

export default router; 