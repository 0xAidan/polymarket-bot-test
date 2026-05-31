import { isHostedMultiTenantMode } from './hostedMode.js';
import { DEFAULT_TENANT_ID } from './tenantContext.js';

export const resolveHostedTenantId = (tenantId: string | undefined, context: string): string => {
  if (tenantId) {
    return tenantId;
  }
  if (isHostedMultiTenantMode()) {
    throw new Error(`${context} is missing tenantId in hosted multi-tenant mode`);
  }
  return DEFAULT_TENANT_ID;
};
