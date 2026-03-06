import { config } from '../config.js';
import { createDiscoveryServiceServer } from './serviceServer.js';
import { DiscoveryManager } from './discoveryManager.js';

const discoveryPort = parseInt(process.env.DISCOVERY_PORT || '3002', 10);

async function main(): Promise<void> {
  const manager = new DiscoveryManager();

  try {
    await manager.start();
  } catch (error: any) {
    console.error('[DiscoveryWorker] Failed to start discovery manager:', error.message);
  }

  const app = await createDiscoveryServiceServer(manager);
  const host = process.env.DISCOVERY_HOST || process.env.HOST || '0.0.0.0';

  const server = app.listen(discoveryPort, host, () => {
    console.log(`\n🔎 Discovery service running on http://${host}:${discoveryPort}`);
    console.log(`   Main app remains on http://${host}:${config.port}\n`);
  });

  const handleShutdown = async (): Promise<void> => {
    console.log('\n🛑 Shutting down discovery worker...');
    server.close();
    try {
      await manager.stop();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void handleShutdown());
  process.on('SIGTERM', () => void handleShutdown());
}

main().catch((error) => {
  console.error('[DiscoveryWorker] Fatal error:', error);
  process.exit(1);
});
