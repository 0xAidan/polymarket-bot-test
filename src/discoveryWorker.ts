import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDatabase } from './database.js';
import { DiscoveryManager } from './discovery/discoveryManager.js';
import { createDiscoveryRoutes } from './api/discoveryRoutes.js';

async function main(): Promise<void> {
  await initDatabase();

  const manager = new DiscoveryManager();
  await manager.start();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/discovery', createDiscoveryRoutes(manager));
  app.get('/health', (_req, res) => {
    res.json({ success: true, service: 'discovery-worker', timestamp: new Date().toISOString() });
  });

  const server = app.listen(config.discoveryWorkerPort, '0.0.0.0', () => {
    console.log(`🔎 Discovery worker running on http://0.0.0.0:${config.discoveryWorkerPort}`);
  });

  const shutdown = async (): Promise<void> => {
    console.log('\n🛑 Stopping discovery worker...');
    await manager.stop();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error) => {
  console.error('Discovery worker failed to start:', error);
  process.exit(1);
});
