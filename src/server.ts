import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config.js';
import { createRoutes } from './api/routes.js';
import { createDiscoveryRoutes } from './api/discoveryRoutes.js';
import { CopyTrader } from './copyTrader.js';
import { DiscoveryManager } from './discovery/discoveryManager.js';
import { initDatabase } from './database.js';

type ServerOptions = {
  discoveryManager?: DiscoveryManager | null;
};

const getDiscoveryProxyBaseUrl = (): string => {
  const host = process.env.DISCOVERY_HOST || process.env.HOST || '127.0.0.1';
  const port = process.env.DISCOVERY_PORT || '3002';
  return `http://${host}:${port}`;
};

const forwardDiscoveryRequest = async (req: express.Request, res: express.Response): Promise<void> => {
  const targetUrl = `${getDiscoveryProxyBaseUrl()}${req.originalUrl}`;
  const method = req.method.toUpperCase();
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const response = await fetch(targetUrl, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
  });

  res.status(response.status);
  const contentType = response.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.send(await response.text());
};

/**
 * Create and configure the Express server
 */
export async function createServer(copyTrader: CopyTrader, options: ServerOptions = {}): Promise<express.Application> {
  const app = express();
  const { discoveryManager = null } = options;

  await initDatabase();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));  // Increased from default 100kb for large trade lists

  // Serve static files from public directory
  // Note: Using process.cwd() since the app runs from project root
  const publicPath = path.join(process.cwd(), 'public');
  app.use(express.static(publicPath));

  // API routes
  app.use('/api', createRoutes(copyTrader));
  if (discoveryManager) {
    app.use('/api/discovery', createDiscoveryRoutes(discoveryManager));
  } else {
    app.use('/api/discovery', (req, res, next) => {
      void forwardDiscoveryRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.status(503).json({
            success: false,
            error: 'Discovery service is unavailable. Start the discovery worker or inject a discovery manager.',
            details: error instanceof Error ? error.message : String(error),
          });
        } else {
          next(error);
        }
      });
    });
  }
  
  // API 404 handler - catch any unmatched /api routes and return JSON
  app.use('/api/*', (req, res) => {
    console.error(`[API] 404 - Route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ 
      success: false, 
      error: `Route not found: ${req.method} ${req.path}` 
    });
  });
  
  // API error handler - ensure API errors return JSON, not HTML
  app.use('/api', (err: any, req: any, res: any, next: any) => {
    console.error(`[API] Error:`, err);
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
      console.log(`\n🚀 Server running on http://${host}:${config.port}`);
      console.log(`📊 Open your browser to manage wallets and control the bot\n`);
      resolve();
    });

    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${config.port} is already in use!\n`);
        console.error('To fix this, you can:');
        console.error(`  1. Kill the process using port ${config.port}:`);
        console.error(`     lsof -ti:${config.port} | xargs kill -9`);
        console.error(`  2. Or use a different port by setting PORT in your .env file`);
        console.error(`     Example: PORT=3001 npm run dev\n`);
        reject(error);
      } else {
        reject(error);
      }
    });
  });
}
