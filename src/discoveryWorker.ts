import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDatabase } from './database.js';
import { DiscoveryWorkerRuntime } from './discovery/discoveryWorker.js';
import { createDiscoveryRoutes } from './api/discoveryRoutes.js';
import { DiscoveryControlPlane } from './discovery/discoveryControlPlane.js';

async function main(): Promise<void> {
  await initDatabase();

  const runner = new DiscoveryWorkerRuntime();
  const controlPlane = new DiscoveryControlPlane();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/discovery', createDiscoveryRoutes(controlPlane));
  app.get('/health', (_req, res) => {
    res.json({ success: true, service: 'discovery-worker', timestamp: new Date().toISOString() });
  });

  const server = app.listen(config.discoveryWorkerPort, '0.0.0.0', () => {
    console.log(`🔎 Discovery worker running on http://0.0.0.0:${config.discoveryWorkerPort}`);
    void runner.start().catch((error) => {
      console.error('Discovery manager startup failed:', error);
    });
  });

  const shutdown = async (): Promise<void> => {
    console.log('\n🛑 Stopping discovery worker...');
    await runner.stop();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch((error) => {
  console.error('Discovery worker failed to start:', error);
  process.exit(1);
});
