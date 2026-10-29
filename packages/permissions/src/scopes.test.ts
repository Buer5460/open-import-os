import { describe, expect, it } from "vitest";
import {
  assertClientAccess,
  assertExpertAccess,
  effectiveScopes,
  isDelivered,
  outboundBlockReason,
  requireScope,
  resolveOrgScope,
  type Actor,
  type AuthzContext,
} from "./scopes.js";

const actor = (over: Partial<Actor> = {}): Actor => ({
  kind: "USER",
  userId: "u1",
  organizationId: "org-A",
  roles: ["MEMBER"],
  scopes: ["products:read", "products:write"],
  dataMode: "REAL",
  requestId: "r1",
  ...over,
});

const ctx = (over: Partial<AuthzContext> = {}): AuthzContext => ({ actor: actor(), ...over });

describe("A02 / A15 - tenant isolation", () => {
  it("ignores an organization_id in the body for a normal member", () => {
    const c = ctx();
    expect(resolveOrgScope(c, "org-B")).toBe("org-A");
  });

  it("cannot be pushed into another tenant by a body-supplied organization_id", () => {
    // A member with no grant asking for org-B must stay in their own org.
    // The id in the body has no authority at all.
    const c = ctx({ actingOnOrgId: "org-B", grants: [] });
    expect(resolveOrgScope(c, "org-B")).toBe("org-A");
    expect(resolveOrgScope(c, "org-C")).toBe("org-A");
  });

  it("a body-supplied organization_id does not widen scopes across tenants", () => {
    const c = ctx({ actingOnOrgId: "org-B", grants: [] });
    // Even though the caller asked for org-B, no cross-tenant scope survives.
    expect(effectiveScopes(c)).toEqual([]);
    expect(() => requireScope(c, "products:read")).toThrow();
  });

  it("allows service-provider access only through a live grant", () => {
    const provider = actor({ organizationId: "org-PROVIDER", roles: ["SERVICE_PROVIDER"], scopes: ["clients:read", "clients:write"] });
    const withGrant = ctx({
      actor: provider,
      actingOnOrgId: "org-CLIENT",
      grants: [{ clientOrgId: "org-CLIENT", scopes: ["products:read"], revokedAt: null, expiresAt: null }],
    });
    expect(() => assertClientAccess(withGrant, "org-CLIENT")).not.toThrow();

    const revoked = ctx({
      actor: provider,
      actingOnOrgId: "org-CLIENT",
      grants: [{ clientOrgId: "org-CLIENT", scopes: ["products:read"], revokedAt: new Date(), expiresAt: null }],
    });
    expect(() => assertClientAccess(revoked, "org-CLIENT")).toThrow();

    const expired = ctx({
      actor: provider,
      actingOnOrgId: "org-CLIENT",
      grants: [{ clientOrgId: "org-CLIENT", scopes: ["products:read"], revokedAt: null, expiresAt: new Date(Date.now() - 1000) }],
    });
    expect(() => assertClientAccess(expired, "org-CLIENT")).toThrow();
  });

  it("a revoked grant also strips the effective scopes", () => {
    const provider = actor({ organizationId: "org-PROVIDER", roles: ["SERVICE_PROVIDER"], scopes: ["products:read"] });
    const c = ctx({
      actor: provider,
      actingOnOrgId: "org-CLIENT",
      grants: [{ clientOrgId: "org-CLIENT", scopes: ["products:read"], revokedAt: new Date(), expiresAt: null }],
    });
    expect(effectiveScopes(c)).toEqual([]);
  });

  it("a grant narrows rather than widens the provider's scopes", () => {
    const provider = actor({ organizationId: "org-PROVIDER", roles: ["SERVICE_PROVIDER"], scopes: ["products:read", "products:write", "calculations:read"] });
    const c = ctx({
      actor: provider,
      actingOnOrgId: "org-CLIENT",
      grants: [{ clientOrgId: "org-CLIENT", scopes: ["products:read"], revokedAt: null, expiresAt: null }],
    });
    expect(effectiveScopes(c)).toEqual(["products:read"]);
  });

  it("platform admin needs an audited grant to read customer data", () => {
    const admin = actor({ organizationId: "org-PLATFORM", roles: ["PLATFORM_ADMIN"], scopes: ["admin:read"] });
    expect(() => resolveOrgScope(ctx({ actor: admin, grants: [] }), "org-CLIENT")).toThrow();
    expect(
      resolveOrgScope(
        ctx({
          actor: admin,
          actingOnOrgId: "org-CLIENT",
          grants: [{ clientOrgId: "org-CLIENT", scopes: ["admin:read"], revokedAt: null, expiresAt: null }],
        }),
        "org-CLIENT",
      ),
    ).toBe("org-CLIENT");
  });
});

describe("scope enforcement", () => {
  it("requireScope throws for a missing scope", () => {
    expect(() => requireScope(ctx(), "admin:write")).toThrow();
  });
  it("requireScope passes for a held scope", () => {
    expect(() => requireScope(ctx(), "products:write")).not.toThrow();
  });
  it("a viewer cannot write", () => {
    const viewer = ctx({ actor: actor({ roles: ["VIEWER"], scopes: [] }) });
    expect(() => requireScope(viewer, "products:write")).toThrow();
  });
});

describe("expert isolation", () => {
  it("an expert can only open their own assigned task", () => {
    const expert = actor({ userId: "expert-1", roles: ["ASSIGNED_EXPERT"], scopes: [] });
    expect(() => assertExpertAccess(ctx({ actor: expert }), "expert-1")).not.toThrow();
    expect(() => assertExpertAccess(ctx({ actor: expert }), "expert-2")).toThrow();
    expect(() => assertExpertAccess(ctx({ actor: expert }), null)).toThrow();
  });
});

describe("A21 - outbound gate", () => {
  it("blocks when sending is disabled (the default)", () => {
    expect(
      outboundBlockReason({
        outboundSendEnabled: false,
        channelConnection: "CONNECTED_TESTED",
        hasContactBasis: true,
        isSuppressed: false,
        approvalValid: true,
        withinDailyCap: true,
      }),
    ).toBe("OUTBOUND_DISABLED");
  });

  it("blocks an untested channel, a suppressed recipient and a missing approval", () => {
    const base = {
      outboundSendEnabled: true,
      channelConnection: "CONNECTED_TESTED" as const,
      hasContactBasis: true,
      isSuppressed: false,
      approvalValid: true,
      withinDailyCap: true,
    };
    expect(outboundBlockReason({ ...base, channelConnection: "CONFIGURED_UNTESTED" })).toBe("CHANNEL_NOT_CONFIGURED");
    expect(outboundBlockReason({ ...base, isSuppressed: true })).toBe("SUPPRESSED_RECIPIENT");
    expect(outboundBlockReason({ ...base, approvalValid: false })).toBe("APPROVAL_REQUIRED");
    expect(outboundBlockReason({ ...base, hasContactBasis: false })).toBe("NO_AUTHORIZED_CONTACT_BASIS");
    expect(outboundBlockReason({ ...base, withinDailyCap: false })).toBe("QUOTA_EXCEEDED");
    expect(outboundBlockReason(base)).toBeNull();
  });
});

describe("A22 - receipt states", () => {
  it("accepted is not delivered", () => {
    expect(isDelivered("ACCEPTED")).toBe(false);
    expect(isDelivered("DELIVERED")).toBe(true);
    expect(isDelivered("MANUAL_RECORDED")).toBe(false);
  });
});
