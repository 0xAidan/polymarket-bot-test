import crypto from 'node:crypto';
import { getDatabase } from './database.js';

export type AuthenticatedUser = {
  id: string;
  oidcSubject: string;
  email: string | null;
  displayName: string | null;
  lastActiveTenantId: string | null;
};

export type TenantMembership = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: 'owner' | 'admin' | 'user';
};

type UserRow = {
  id: string;
  oidc_subject: string;
  email: string | null;
  display_name: string | null;
  last_active_tenant_id: string | null;
};

type MembershipRow = {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  role: 'owner' | 'admin' | 'user';
};

type OidcClaims = {
  sub?: string;
  email?: string;
  name?: string;
  nickname?: string;
};

const slugify = (value: string): string => (
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tenant'
);

const tenantForSubject = (subject: string): string => (
  `tenant_${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 16)}`
);

const mapUserRow = (row: UserRow): AuthenticatedUser => ({
  id: row.id,
  oidcSubject: row.oidc_subject,
  email: row.email,
  displayName: row.display_name,
  lastActiveTenantId: row.last_active_tenant_id
});

const mapMembershipRow = (row: MembershipRow): TenantMembership => ({
  tenantId: row.tenant_id,
  tenantSlug: row.tenant_slug,
  tenantName: row.tenant_name,
  role: row.role
});

export function syncUserFromOidc(claims: OidcClaims): AuthenticatedUser {
  const subject = claims.sub?.trim();
  if (!subject) {
    throw new Error('OIDC subject is missing from authenticated claims');
  }

  const email = claims.email?.trim() || null;
  const displayName = claims.name?.trim() || claims.nickname?.trim() || null;
  const database = getDatabase();
  const now = Date.now();

  const tx = database.transaction(() => {
    const existing = database
      .prepare('SELECT * FROM app_users WHERE oidc_subject = ? LIMIT 1')
      .get(subject) as UserRow | undefined;

    if (!existing) {
      const userId = crypto.randomUUID();
      const tenantId = tenantForSubject(subject);
      const tenantSlugBase = slugify(email || displayName || tenantId);
      const tenantSlug = `${tenantSlugBase}-${tenantId.slice(-6)}`;
      const tenantName = displayName ? `${displayName}'s Workspace` : 'My Workspace';

      database
        .prepare(`
          INSERT INTO app_tenants (id, slug, name, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(tenantId, tenantSlug, tenantName, now, now);

      database
        .prepare(`
          INSERT INTO app_users (id, oidc_subject, email, display_name, last_active_tenant_id, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(userId, subject, email, displayName, tenantId, now, now);

      database
        .prepare(`
          INSERT INTO app_tenant_memberships (user_id, tenant_id, role, created_at_ms)
          VALUES (?, ?, 'owner', ?)
        `)
        .run(userId, tenantId, now);
    } else {
      database
        .prepare(`
          UPDATE app_users
          SET email = COALESCE(?, email),
              display_name = COALESCE(?, display_name),
              updated_at_ms = ?
          WHERE id = ?
        `)
        .run(email, displayName, now, existing.id);
    }
  });

  tx();

  const row = database
    .prepare('SELECT * FROM app_users WHERE oidc_subject = ? LIMIT 1')
    .get(subject) as UserRow | undefined;

  if (!row) {
    throw new Error('Failed to load user after OIDC sync');
  }

  return mapUserRow(row);
}

export function getUserMemberships(userId: string): TenantMembership[] {
  const database = getDatabase();
  const rows = database
    .prepare(`
      SELECT m.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name, m.role
      FROM app_tenant_memberships m
      INNER JOIN app_tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ?
      ORDER BY t.created_at_ms ASC
    `)
    .all(userId) as MembershipRow[];

  return rows.map(mapMembershipRow);
}

export function resolveUserActiveTenant(user: AuthenticatedUser, memberships: TenantMembership[]): TenantMembership {
  if (memberships.length === 0) {
    throw new Error('Authenticated user has no tenant memberships');
  }

  if (user.lastActiveTenantId) {
    const matched = memberships.find((membership) => membership.tenantId === user.lastActiveTenantId);
    if (matched) {
      return matched;
    }
  }

  return memberships[0];
}

export function setUserLastActiveTenant(userId: string, tenantId: string): void {
  const database = getDatabase();
  database
    .prepare('UPDATE app_users SET last_active_tenant_id = ?, updated_at_ms = ? WHERE id = ?')
    .run(tenantId, Date.now(), userId);
}

export function canUserAccessTenant(userId: string, tenantId: string): boolean {
  const database = getDatabase();
  const row = database
    .prepare('SELECT 1 FROM app_tenant_memberships WHERE user_id = ? AND tenant_id = ? LIMIT 1')
    .get(userId, tenantId) as { 1: number } | undefined;
  return Boolean(row);
}

export function writeAuthAuditLog(
  userId: string | null,
  eventType: string,
  metadata: Record<string, unknown>
): void {
  const database = getDatabase();
  database
    .prepare(`
      INSERT INTO app_auth_audit_log (id, user_id, event_type, metadata_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(crypto.randomUUID(), userId, eventType, JSON.stringify(metadata), Date.now());
}
