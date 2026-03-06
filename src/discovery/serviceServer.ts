import express from 'express';
import cors from 'cors';
import { createDiscoveryRoutes } from '../api/discoveryRoutes.js';
import { DiscoveryManager } from './discoveryManager.js';

export const createDiscoveryServiceServer = async (
  manager: DiscoveryManager = new DiscoveryManager(),
): Promise<express.Application> => {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/discovery', createDiscoveryRoutes(manager));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'discovery', timestamp: new Date().toISOString() });
  });

  return app;
};
