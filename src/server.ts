import express from 'express';
import cors from 'cors';
import path from 'path';
import rateLimit from 'express-rate-limit';
import { auth, type ConfigParams } from 'express-openid-connect';
import { config } from './config.js';
import { createRoutes } from './api/routes.js';
import { CopyTrader } from './copyTrader.js';
import { initDatabase } from './database.js';
import { createDiscoveryRoutes } from './api/discoveryRoutes.js';
import { DiscoveryManager } from './discovery/discoveryManager.js';
import { DiscoveryControlPlane } from './discovery/discoveryControlPlane.js';
import { createComponentLogger } from './logger.js';
import { DEFAULT_TENANT_ID, enterWithTenant } from './tenantContext.js';
import { isHostedMultiTenantMode } from './hostedMode.js';
import {
  canUserAccessTenant,
  getUserMemberships,
  resolveUserActiveTenant,
  setUserLastActiveTenant,
  syncUserFromOidc,
  writeAuthAuditLog
} from './authStore.js';

const log = createComponentLogger('Server');

let discoveryManagerInstance: DiscoveryManager | null = null;

export const getDiscoveryManager = (): DiscoveryManager | null => discoveryManagerInstance;

/**
 * Create and configure the Express server
 */
export async function createServer(copyTrader: CopyTrader): Promise<express.Application> {
  await initDatabase();
  const app = express();
  app.set('trust proxy', 1);

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));  // Increased from default 100kb for large trade lists

  // Serve static files from public directory
  // Note: Using process.cwd() since the app runs from project root
  const publicPath = path.join(process.cwd(), 'public');
  app.use(express.static(publicPath));

  discoveryManagerInstance = new DiscoveryManager('passive');
  const discoveryControlPlane = new DiscoveryControlPlane();

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1200,
    standardHeaders: true,
    legacyHeaders: false
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 80,
    standardHeaders: true,
    legacyHeaders: false
  });

  const requireOidcAuth: express.RequestHandler = (req, res, next) => {
    if (req.oidc?.isAuthenticated()) {
      next();
      return;
    }
    res.status(401).json({
      success: false,
      error: 'Authentication required'
    });
  };

  const resolveOidcUserContext = (req: express.Request) => {
    const claims = req.oidc.user || {};
    const user = syncUserFromOidc({
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      nickname: claims.nickname
    });
    const memberships = getUserMemberships(user.id);
    return { user, memberships };
  };

  // ─── Auth status endpoint (always open, tells frontend auth mode/requirements) ───
  app.get('/api/auth/required', (_req, res) => {
    const hostedMultiTenant = isHostedMultiTenantMode();
    if (config.authMode === 'oidc') {
      res.json({ required: true, mode: 'oidc', hostedMultiTenant });
      return;
    }
    res.json({ required: !!config.apiSecret, mode: 'legacy', hostedMultiTenant });
  });

  if (config.authMode === 'oidc') {
    if (!config.authSessionSecret || !config.auth0IssuerBaseUrl || !config.auth0BaseUrl || !config.auth0ClientId || !config.auth0ClientSecret) {
      throw new Error('OIDC mode is enabled but Auth0 configuration is incomplete. Check AUTH_* and AUTH0_* variables.');
    }

    const oidcConfig: ConfigParams = {
      authRequired: false,
      auth0Logout: true,
      secret: config.authSessionSecret,
      baseURL: config.auth0BaseUrl,
      clientID: config.auth0ClientId,
      issuerBaseURL: config.auth0IssuerBaseUrl,
      clientSecret: config.auth0ClientSecret,
      idpLogout: true,
      session: {
        rolling: true,
        rollingDuration: config.authSessionRollingDurationHours * 60 * 60,
        absoluteDuration: config.authSessionAbsoluteDurationHours * 60 * 60,
        cookie: {
          httpOnly: true,
          secure: config.auth0BaseUrl.startsWith('https://'),
          sameSite: 'Lax'
        }
      },
      routes: {
        login: '/auth/login',
        logout: '/auth/logout',
        callback: '/auth/callback'
      }
    };

    app.use('/auth', authLimiter);
    app.use(auth(oidcConfig));

    app.get('/api/auth/check', (_req, res) => {
      res.status(410).json({
        success: false,
        error: 'Legacy API token auth check is disabled. Use OIDC session auth.'
      });
    });

    app.get('/api/auth/me', requireOidcAuth, (req, res) => {
      try {
        const { user, memberships } = resolveOidcUserContext(req);
        const activeMembership = resolveUserActiveTenant(user, memberships);
        setUserLastActiveTenant(user.id, activeMembership.tenantId);
        writeAuthAuditLog(user.id, 'session_check', {
          ip: req.ip,
          userAgent: req.headers['user-agent'] || null,
          tenantId: activeMembership.tenantId
        });

        res.json({
          success: true,
          hostedMultiTenant: isHostedMultiTenantMode(),
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            role: activeMembership.role
          },
          activeTenant: activeMembership,
          tenants: memberships
        });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || 'Failed to load session' });
      }
    });

    app.get('/api/auth/tenants', requireOidcAuth, (req, res) => {
      try {
        const { user, memberships } = resolveOidcUserContext(req);
        const activeMembership = resolveUserActiveTenant(user, memberships);
        res.json({
          success: true,
          activeTenantId: activeMembership.tenantId,
          tenants: memberships
        });
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || 'Failed to load tenants' });
      }
    });

    app.post('/api/auth/switch-tenant', requireOidcAuth, (req, res) => {
      try {
        const tenantId = String(req.body?.tenantId || '').trim();
        if (!tenantId) {
          return res.status(400).json({ success: false, error: 'tenantId is required' });
        }

        const { user } = resolveOidcUserContext(req);
        if (!canUserAccessTenant(user.id, tenantId)) {
          writeAuthAuditLog(user.id, 'tenant_switch_denied', { tenantId, ip: req.ip });
          return res.status(403).json({ success: false, error: 'Access denied for tenant' });
        }

        setUserLastActiveTenant(user.id, tenantId);
        writeAuthAuditLog(user.id, 'tenant_switched', { tenantId, ip: req.ip });
        return res.json({ success: true, tenantId });
      } catch (error: any) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to switch tenant' });
      }
    });

    app.use('/api', apiLimiter, requireOidcAuth, (req, _res, next) => {
      try {
        const { user, memberships } = resolveOidcUserContext(req);
        if (memberships.length === 0) {
          return next(new Error('Authenticated user has no tenant memberships'));
        }

        const requestedTenantId = String(req.header('x-tenant-id') || '').trim();
        const defaultMembership = resolveUserActiveTenant(user, memberships);
        const activeTenant = requestedTenantId
          ? memberships.find((membership) => membership.tenantId === requestedTenantId)
          : defaultMembership;

        if (!activeTenant) {
          writeAuthAuditLog(user.id, 'tenant_request_denied', { requestedTenantId, ip: req.ip });
          return next(new Error('Requested tenant is not accessible for this account'));
        }

        setUserLastActiveTenant(user.id, activeTenant.tenantId);
        enterWithTenant(activeTenant.tenantId);
        next();
      } catch (error) {
        next(error);
      }
    });
    log.info('🔐 OIDC authentication enabled (Auth0 session mode)');
  } else if (config.apiSecret) {
    app.post('/api/auth/check', (req, res) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token === config.apiSecret) {
        res.json({ success: true });
      } else {
        res.status(401).json({ success: false, error: 'Invalid token' });
      }
    });

    app.use('/api', apiLimiter, (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token !== config.apiSecret) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized — invalid or missing API token'
        });
      }
      enterWithTenant(DEFAULT_TENANT_ID);
      return next();
    });
    log.info('🔒 Legacy API authentication enabled (API_SECRET mode)');
  } else {
    if (config.requireApiSecret) {
      const message = 'AUTH_MODE=legacy requires API_SECRET when REQUIRE_API_SECRET=true';
      log.error(message);
      throw new Error(message);
    }
    log.warn('⚠️  WARNING: API authentication is open in legacy mode.');
    app.use('/api', apiLimiter, (_req, _res, next) => {
      enterWithTenant(DEFAULT_TENANT_ID);
      next();
    });
  }

  // API routes
  app.use('/api', createRoutes(copyTrader));
  app.use('/api/discovery', createDiscoveryRoutes(discoveryControlPlane as any));

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
    log.error({ err }, '[API] Error');
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
