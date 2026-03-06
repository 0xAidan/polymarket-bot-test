import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { createRoutes } from './api/routes.js';
import { CopyTrader } from './copyTrader.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('Server');

/**
 * Create and configure the Express server
 */
export async function createServer(copyTrader: CopyTrader): Promise<express.Application> {
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));  // Increased from default 100kb for large trade lists

  // Serve static files from public directory
  // Note: Using process.cwd() since the app runs from project root
  const publicPath = path.join(process.cwd(), 'public');
  app.use(express.static(publicPath));

  // API routes
  app.use('/api', createRoutes(copyTrader));
  
  // API 404 handler - catch any unmatched /api routes and return JSON
  app.use('/api/*', (req, res) => {
    log.error(`[API] 404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
      success: false, 
      error: `Route not found: ${req.method} ${req.path}` 
    });
  });
  
  // API error handler - ensure API errors return JSON, not HTML
  app.use('/api', (err: any, req: any, res: any, next: any) => {
    log.error({ err: err }, `[API] Error`)
    res.status(err.status || 500).json({ 
      success: false, 
      error: err.message || 'Internal server error' 
    });
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve dashboard UI (fallback for SPA-style routing)
  app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
  });

  return app;
}

/**
 * Start the server
 */
export async function startServer(app: express.Application): Promise<void> {
  return new Promise((resolve, reject) => {
    const host = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for cloud/docker
    const server = app.listen(config.port, host, () => {
      log.info(`\n🚀 Server running on http://${host}:${config.port}`);
      log.info(`📊 Open your browser to manage wallets and control the bot\n`);
      resolve();
    });

    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        log.error(`\n❌ Port ${config.port} is already in use!\n`);
        log.error('To fix this, you can:');
        log.error(`  1. Kill the process using port ${config.port}:`);
        log.error(`     lsof -ti:${config.port} | xargs kill -9`);
        log.error(`  2. Or use a different port by setting PORT in your .env file`);
        log.error(`     Example: PORT=3001 npm run dev\n`);
        reject(error);
      } else {
        reject(error);
      }
    });
  });
}
