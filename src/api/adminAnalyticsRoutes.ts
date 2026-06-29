import { Router, Request, Response } from 'express';
import type { RequestHandler } from 'express';
import { requirePlatformAdmin } from '../middleware/requirePlatformAdmin.js';
import { writeAuthAuditLog } from '../authStore.js';
import { adminAnalyticsService } from '../adminAnalytics/adminAnalyticsService.js';
import { sanitizeAdminAnalyticsPayload } from '../adminAnalytics/sanitizeAdminAnalyticsPayload.js';
import { formatCsvContent } from '../adminAnalytics/csvExport.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('AdminAnalyticsRoutes');

const resolveAdminEmail = (req: Request): string | null => {
  const claims = (req.oidc?.user ?? {}) as Record<string, unknown>;
  return typeof claims.email === 'string' ? claims.email : null;
};

const logAdminEvent = (req: Request, eventType: string, metadata: Record<string, unknown>): void => {
  try {
    writeAuthAuditLog(null, eventType, {
      adminEmail: resolveAdminEmail(req),
      ...metadata,
    });
  } catch (error) {
    log.warn({ err: error }, 'Failed to write admin analytics audit log');
  }
};

const sendSanitizedJson = (res: Response, payload: unknown): void => {
  res.json(sanitizeAdminAnalyticsPayload(payload));
};

export const createAdminAnalyticsRouter = (): Router => {
  const router = Router();

  router.use(requirePlatformAdmin as RequestHandler);

  router.get('/admin/analytics/overview', async (req: Request, res: Response) => {
    try {
      const data = await adminAnalyticsService.getOverview(req.query);
      logAdminEvent(req, 'platform_admin.analytics.overview', {
        range: data.range.preset,
      });
      sendSanitizedJson(res, { success: true, ...data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/tenants', async (req: Request, res: Response) => {
    try {
      const data = await adminAnalyticsService.listTenants(req.query);
      sendSanitizedJson(res, { success: true, ...data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/tenants/:tenantId', async (req: Request, res: Response) => {
    try {
      const data = await adminAnalyticsService.getTenantDetail(req.params.tenantId, req.query);
      if (!data) {
        res.status(404).json({ success: false, error: 'Tenant not found' });
        return;
      }
      logAdminEvent(req, 'platform_admin.analytics.tenant_view', {
        tenantId: req.params.tenantId,
      });
      sendSanitizedJson(res, { success: true, tenant: data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/tenants/:tenantId/tracked-wallets', async (req: Request, res: Response) => {
    try {
      const wallets = await adminAnalyticsService.getTrackedWallets(req.params.tenantId, req.query);
      sendSanitizedJson(res, { success: true, wallets });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/tenants/:tenantId/trading-wallets', async (req: Request, res: Response) => {
    try {
      const wallets = adminAnalyticsService.getTradingWallets(req.params.tenantId);
      sendSanitizedJson(res, { success: true, wallets });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/tenants/:tenantId/trades', async (req: Request, res: Response) => {
    try {
      const data = await adminAnalyticsService.getTrades(req.params.tenantId, req.query);
      sendSanitizedJson(res, { success: true, ...data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/trades/:tenantId/:tradeId', async (req: Request, res: Response) => {
    try {
      const data = await adminAnalyticsService.getTradeDetail(req.params.tenantId, req.params.tradeId);
      if (!data) {
        res.status(404).json({ success: false, error: 'Trade not found' });
        return;
      }
      logAdminEvent(req, 'platform_admin.analytics.trade_view', {
        tenantId: req.params.tenantId,
        tradeId: req.params.tradeId,
      });
      sendSanitizedJson(res, { success: true, ...data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.get('/admin/analytics/tenants/:tenantId/balances', async (req: Request, res: Response) => {
    try {
      const data = await adminAnalyticsService.getBalances(req.params.tenantId, {
        ...req.query,
        walletId: typeof req.query.walletId === 'string' ? req.query.walletId : undefined,
      });
      sendSanitizedJson(res, { success: true, ...data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  const handleCsvExport = async (req: Request, res: Response, tenantId?: string): Promise<void> => {
    try {
      const result = await adminAnalyticsService.collectTradesForExport({
        tenantId,
        range: req.query.range,
        from: req.query.from,
        to: req.query.to,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
      });

      if (result.truncated) {
        res.status(413).json({
          success: false,
          error: 'Export exceeds maximum row limit. Narrow your filters.',
        });
        return;
      }

      logAdminEvent(req, 'platform_admin.analytics.export_csv', {
        tenantId: tenantId ?? 'all',
        rowCount: result.rows.length,
        range: result.range.preset,
      });

      const csv = formatCsvContent(result.rows);
      const filename = tenantId
        ? `ditto-trades-${tenantId}.csv`
        : 'ditto-trades-platform.csv';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  };

  router.get('/admin/analytics/tenants/:tenantId/trades/export.csv', async (req: Request, res: Response) => {
    await handleCsvExport(req, res, req.params.tenantId);
  });

  router.get('/admin/analytics/trades/export.csv', async (req: Request, res: Response) => {
    const tenantId = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
    await handleCsvExport(req, res, tenantId);
  });

  return router;
};
