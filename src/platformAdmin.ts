import { Request } from 'express';
import { config } from './config.js';

let cachedEmailSet: Set<string> | null = null;

const getPlatformAdminEmailSet = (): Set<string> => {
  if (!cachedEmailSet) {
    cachedEmailSet = new Set(
      config.platformAdminEmails
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    );
  }
  return cachedEmailSet;
};

export const resetPlatformAdminEmailCache = (): void => {
  cachedEmailSet = null;
};

export const isPlatformAdminEmail = (email: string | undefined): boolean => {
  if (!email) return false;
  return getPlatformAdminEmailSet().has(email.trim().toLowerCase());
};

export const isLegacyPlatformAdminBearer = (req: Request): boolean => {
  if (!config.apiSecret) return false;
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  return token === config.apiSecret;
};

/**
 * Platform admin: PLATFORM_ADMIN_EMAILS (OIDC) or valid API_SECRET bearer (legacy).
 * Separate from tenant membership roles.
 */
export const resolveIsPlatformAdmin = (req: Request): boolean => {
  if (config.authMode === 'oidc') {
    if (!req.oidc?.isAuthenticated()) return false;
    const claims = req.oidc.user || {};
    return isPlatformAdminEmail(typeof claims.email === 'string' ? claims.email : undefined);
  }
  return isLegacyPlatformAdminBearer(req);
};
