import type { Request } from 'express';
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

/** Reset cached allowlist (tests). */
export const resetPlatformAdminEmailCache = (): void => {
  cachedEmailSet = null;
};

export const isPlatformAdminEmail = (email: string | undefined | null): boolean => {
  if (!email) return false;
  return getPlatformAdminEmailSet().has(email.trim().toLowerCase());
};

const normalizePossibleEmail = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  if (!candidate.includes('@')) return null;
  if (candidate.includes(' ')) return null;
  return candidate;
};

const resolveOidcEmailCandidates = (claims: Record<string, unknown>): string[] => {
  const candidates = new Set<string>();

  const directKeys = ['email', 'preferred_username', 'upn', 'nickname', 'name'] as const;
  for (const key of directKeys) {
    const normalized = normalizePossibleEmail(claims[key]);
    if (normalized) candidates.add(normalized);
  }

  const emailsValue = claims.emails;
  if (Array.isArray(emailsValue)) {
    for (const email of emailsValue) {
      const normalized = normalizePossibleEmail(email);
      if (normalized) candidates.add(normalized);
    }
  }

  return Array.from(candidates);
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
    const claims = (req.oidc.user || {}) as Record<string, unknown>;
    const candidates = resolveOidcEmailCandidates(claims);
    return candidates.some((email) => isPlatformAdminEmail(email));
  }
  return isLegacyPlatformAdminBearer(req);
};
