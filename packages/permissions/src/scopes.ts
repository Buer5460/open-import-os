/**
 * Roles, scopes and the authorization decision layer.
 *
 * The rule the specification is emphatic about: a request body's
 * organization_id NEVER decides permissions. The effective organization comes
 * from the authenticated session / API key, and every query is filtered by it
 * in the service layer (with DB-level scoping as a second line of defence).
 */
import { AppError } from "@open-import-os/contracts/errors";

export const SCOPES = [
  "products:read",
  "products:write",
  "calculations:read",
  "calculations:write",
  "scenarios:read",
  "scenarios:write",
  "alerts:read",
  "alerts:write",
  "reviews:read",
  "reviews:write",
  "reviews:expert",
  "clients:read",
  "clients:write",
  "growth:read",
  "growth:write",
  "growth:outreach:send",
  "developer:read",
  "developer:write",
  "admin:read",
  "admin:write",
] as const;

export type Scope = (typeof SCOPES)[number];

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

export type Role =
  | "OWNER"
  | "ADMIN"
  | "MEMBER"
  | "VIEWER"
  | "SERVICE_PROVIDER"
  | "ASSIGNED_EXPERT"
  | "PLATFORM_ADMIN";

/** Default scope sets per role. Owner/Admin get everything writable. */
export const ROLE_SCOPES: Record<Role, Scope[]> = {
  OWNER: [...SCOPES],
  ADMIN: [...SCOPES],
  MEMBER: [
    "products:read",
    "products:write",
    "calculations:read",
    "calculations:write",
    "scenarios:read",
    "scenarios:write",
    "alerts:read",
    "alerts:write",
    "reviews:read",
    "reviews:write",
  ],
  VIEWER: [
    "products:read",
    "calculations:read",
    "scenarios:read",
    "alerts:read",
    "reviews:read",
  ],
  // A service provider sees ONLY the clients explicitly granted to it.
  SERVICE_PROVIDER: ["clients:read", "clients:write"],
  // An expert sees only the review tasks assigned to them.
  ASSIGNED_EXPERT: ["reviews:expert"],
  // Platform admin defaults to operations metadata only; customer business
  // data requires an explicit, audited grant.
  PLATFORM_ADMIN: ["admin:read", "admin:write", "growth:read"],
};

export interface Actor {
  kind: "USER" | "API_KEY" | "SYSTEM" | "WORKER" | "MCP";
  userId?: string;
  apiKeyId?: string;
  /** The organization the credential belongs to. NEVER taken from the body. */
  organizationId: string;
  roles: Role[];
  scopes: Scope[];
  /** Data namespace: DEMO or REAL. */
  dataMode: "DEMO" | "REAL";
  requestId: string;
}

export interface AuthzContext {
  actor: Actor;
  /** When set, the actor is operating on behalf of this client organization. */
  actingOnOrgId?: string;
  /** Explicit client-access grants, keyed by clientOrgId. */
  grants?: Array<{ clientOrgId: string; scopes: Scope[]; revokedAt: Date | null; expiresAt: Date | null }>;
}

export function effectiveScopes(ctx: AuthzContext): Scope[] {
  const granted = new Set<Scope>(ctx.actor.scopes);
  for (const role of ctx.actor.roles) {
    for (const s of ROLE_SCOPES[role] ?? []) granted.add(s);
  }
  // Cross-organization work is limited to what the grant explicitly allows.
  if (ctx.actingOnOrgId && ctx.actingOnOrgId !== ctx.actor.organizationId) {
    const grant = ctx.grants?.find(
      (g) =>
        g.clientOrgId === ctx.actingOnOrgId &&
        g.revokedAt === null &&
        (g.expiresAt === null || g.expiresAt.getTime() > Date.now()),
    );
    if (!grant) return [];
    return [...granted].filter((s) => grant.scopes.includes(s));
  }
  return [...granted];
}

export function requireScope(ctx: AuthzContext, scope: Scope): void {
  if (!effectiveScopes(ctx).includes(scope)) {
    throw new AppError("FORBIDDEN_SCOPE", `missing scope: ${scope}`);
  }
}

/**
 * The organization the caller may actually touch.
 *
 * A body-supplied organization_id is IGNORED for everyone: it can never
 * escalate to another tenant. Cross-organization access is decided solely by
 * server-side authorization - a live, unexpired, non-revoked grant - and the
 * role that grants it. An org OWNER is a tenant owner, not a platform
 * admin: owning one organization confers no right to target another.
 */
export function resolveOrgScope(ctx: AuthzContext, requestedOrgId?: string | null): string {
  const own = ctx.actor.organizationId;
  if (!requestedOrgId || requestedOrgId === own) {
    return ctx.actingOnOrgId ?? own;
  }
  // Only a platform admin may reach a foreign organization, and only through
  // an explicit, live, unexpired, unrevoked grant. OWNER/ADMIN/MEMBER/VIEWER
  // are silently scoped back to their own tenant (never honoured, never a
  // 403 that leaks the other org's existence).
  const isPlatformAdmin = ctx.actor.roles.includes("PLATFORM_ADMIN");
  if (!isPlatformAdmin) {
    return own;
  }
  const grant = ctx.grants?.find((g) => g.clientOrgId === requestedOrgId);
  if (!grant) {
    throw new AppError("FORBIDDEN_TENANT", "platform admin access requires an explicit audited grant");
  }
  // Revocation and expiry both take effect immediately; a grant that is
  // either is dead for every read, write and object association.
  if (grant.revokedAt !== null) {
    throw new AppError("FORBIDDEN_TENANT", "this grant has been revoked");
  }
  if (grant.expiresAt !== null && grant.expiresAt.getTime() <= Date.now()) {
    throw new AppError("FORBIDDEN_TENANT", "this grant has expired");
  }
  return requestedOrgId;
}

/** Service-provider access to a specific client must exist and be live. */
export function assertClientAccess(ctx: AuthzContext, clientOrgId: string): void {
  if (clientOrgId === ctx.actor.organizationId) return;
  const grant = ctx.grants?.find(
    (g) =>
      g.clientOrgId === clientOrgId &&
      g.revokedAt === null &&
      (g.expiresAt === null || g.expiresAt.getTime() > Date.now()),
  );
  if (!grant) {
    throw new AppError("FORBIDDEN_TENANT", "no active client access grant");
  }
}

/** Expert access: only tasks explicitly assigned to this actor. */
export function assertExpertAccess(ctx: AuthzContext, assignedExpertId?: string | null): void {
  if (ctx.actor.roles.includes("ADMIN") || ctx.actor.roles.includes("OWNER")) return;
  if (ctx.actor.roles.includes("ASSIGNED_EXPERT")) {
    if (!assignedExpertId || assignedExpertId !== ctx.actor.userId) {
      throw new AppError("FORBIDDEN_TENANT", "expert may only access assigned review tasks");
    }
    return;
  }
  throw new AppError("FORBIDDEN_SCOPE", "expert role required");
}

/** True when the outbound gate may be opened at all. */
export interface OutboundGateInput {
  outboundSendEnabled: boolean;
  channelConnection: "CONNECTED_TESTED" | "CONFIGURED_UNTESTED" | "NOT_CONFIGURED" | "FAILED";
  hasContactBasis: boolean;
  isSuppressed: boolean;
  approvalValid: boolean;
  withinDailyCap: boolean;
}

export function outboundBlockReason(g: OutboundGateInput): string | null {
  if (!g.outboundSendEnabled) return "OUTBOUND_DISABLED";
  if (g.channelConnection !== "CONNECTED_TESTED") return "CHANNEL_NOT_CONFIGURED";
  if (!g.hasContactBasis) return "NO_AUTHORIZED_CONTACT_BASIS";
  if (g.isSuppressed) return "SUPPRESSED_RECIPIENT";
  if (!g.approvalValid) return "APPROVAL_REQUIRED";
  if (!g.withinDailyCap) return "QUOTA_EXCEEDED";
  return null;
}

/** Channel receipt states. ACCEPTED must never be rendered as DELIVERED. */
export const RECEIPT_STATES = ["QUEUED", "SUBMITTED", "ACCEPTED", "DELIVERED", "FAILED", "BOUNCED", "REPLIED", "MANUAL_RECORDED"] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];

export function isDelivered(state: string): boolean {
  return state === "DELIVERED";
}
