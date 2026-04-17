import { config } from './config.js';

/**
 * Hosted multi-tenant production: OIDC auth + SQLite storage.
 * In this mode the deployer .env must not be used for trading identity;
 * each tenant uses encrypted keystores and per-wallet Builder credentials.
 */
export const isHostedMultiTenantMode = (): boolean =>
  config.authMode === 'oidc' && config.storageBackend === 'sqlite';
