import { AsyncLocalStorage } from 'node:async_hooks';
import { isHostedMultiTenantMode } from './hostedMode.js';

export const DEFAULT_TENANT_ID = 'default';

type TenantStore = {
  tenantId: string;
};

const tenantStorage = new AsyncLocalStorage<TenantStore>();

export const getTenantId = (): string | undefined => tenantStorage.getStore()?.tenantId;

export const getTenantIdOrDefault = (): string => getTenantId() ?? DEFAULT_TENANT_ID;

export const getTenantIdStrict = (): string => {
  const tenantId = getTenantId();
  if (tenantId) {
    return tenantId;
  }
  if (isHostedMultiTenantMode()) {
    throw new Error('Tenant context is required in hosted multi-tenant mode');
  }
  return DEFAULT_TENANT_ID;
};

export const requireTenantId = (): string => {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new Error('Tenant context is required');
  }
  return tenantId;
};

export const runWithTenant = <T>(tenantId: string, fn: () => T): T => (
  tenantStorage.run({ tenantId }, fn)
);

export const enterWithTenant = (tenantId: string): void => {
  tenantStorage.enterWith({ tenantId });
};
