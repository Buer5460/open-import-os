/**
 * Session and actor resolution (plain-Node; this app has no framework).
 *
 * A request becomes an AuthzContext here and nowhere else. The permissions
 * package then decides what that actor may do; handlers never re-derive
 * tenancy or scopes from raw request fields.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@open-import-os/db/client";
import { AppError } from "@open-import-os/contracts/errors";
import { verifyPassword } from "@open-import-os/db/password";
import { effectiveScopes, type Actor, type AuthzContext, type Role } from "@open-import-os/permissions";

const SESSION_TTL_HOURS = 12;

/**
 * Create a session. The raw token goes back to the browser; the database
 * stores only its SHA-256, so a database leak does not leak sessions.
 */
export async function createSession(userId: string, ip?: string | null, userAgent?: string | null): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const ipHash = ip ? createHash("sha256").update(ip).digest("hex") : null;
  const uaHash = userAgent ? createHash("sha256").update(userAgent).digest("hex") : null;
  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3600_000),
      ipHash,
      userAgentHash: uaHash,
    },
  });
  return raw;
}

export async function destroySession(rawToken: string) {
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await prisma.session.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Lockout policy: 5 failures locks the account for 15 minutes. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

/** Authenticate a login and return a session token. */
export async function login(
  email: string,
  password: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  // Lockout check happens before password verification: a locked account is
  // not even worth the scrypt work, and the check must not depend on the
  // password being right.
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError("ACCOUNT_LOCKED", "too many failed attempts; try again later");
  }
  // Equal work for both branches so a missing account is not distinguishable
  // by timing from a wrong password.
  const storedHash = user?.passwordHash ?? "scrypt$16384$8$1$00$00";
  const valid = verifyPassword(password, storedHash);
  if (!user || !valid) {
    if (user) {
      // Database-side ATOMIC increment (R1.1-01): the read-modify-write in R1
      // lost updates under concurrency (10 parallel failures recorded 1).
      // `increment` compiles to SET c = c + 1 in SQL, so every processed
      // failure is counted exactly once regardless of interleaving.
      const { failedLoginCount } = await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      // The threshold is judged from the database-returned post-increment
      // value; when it is reached, lock. A concurrent attempt that increments
      // past the threshold is still counted - it was processed - and any one
      // of the racing attempts may set the lock; the resulting lockout window
      // is the same up to a few milliseconds of skew, and it is temporary.
      if (failedLoginCount >= MAX_FAILED_LOGINS) {
        // Only ONE of the racing requests wins the conditional lock update
        // (WHERE lockedUntil IS NULL OR expired); the loser matches no row,
        // which is the intended race outcome - the lock exists either way.
        const locked = await prisma.user.updateMany({
          where: { id: user.id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
          data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) },
        });
        if (locked.count === 1) {
          // this request set the lock; the count that triggered it includes
          // every processed failure (no lost updates, no permanent lock)
        }
      }
    }
    // Identical message for unknown account and wrong password: no account
    // enumeration.
    throw new AppError("INVALID_CREDENTIALS", "email or password is incorrect");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  return createSession(user.id, meta.ip, meta.userAgent);
}

function contextForUser(
  user: {
    id: string;
    email: string;
    memberships: Array<{ organizationId: string; role: string; organization?: { dataMode: string } }>;
  },
): AuthzContext {
  const primary = user.memberships[0];
  const actor: Actor = {
    kind: "USER",
    userId: user.id,
    // The Actor contract requires an organization; an org-less user gets a
    // sentinel that can never match a real tenant id.
    organizationId: primary?.organizationId ?? "__no_organization__",
    roles: (primary ? [primary.role as Role] : ["VIEWER"]) as Role[],
    dataMode: primary?.organization?.dataMode === "DEMO" ? "DEMO" : "REAL",
    requestId: randomBytes(8).toString("hex"),
    scopes: [],
  };
  return { actor, scopes: effectiveScopes({ actor, scopes: [] }) };
}

/** Resolve a raw session token into an AuthzContext, or null. */
export async function getAuthzContextForToken(rawToken: string | undefined): Promise<AuthzContext | null> {
  if (!rawToken) return null;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          memberships: { include: { organization: { select: { dataMode: true } } } },
        },
      },
    },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  // Sliding window: refresh when less than an hour remains.
  if (session.expiresAt.getTime() - Date.now() < 3600_000) {
    await prisma.session
      .update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() + SESSION_TTL_HOURS * 3600_000) } })
      .catch(() => undefined);
  }

  return contextForUser(session.user);
}

/**
 * An anonymous context for the free, no-signup calculator. It has no
 * organisation, so it cannot read or write any tenant data.
 */
export function anonymousContext(): AuthzContext {
  const actor: Actor = {
    kind: "USER",
    userId: "anonymous",
    organizationId: "__no_organization__",
    roles: ["VIEWER"],
    dataMode: "REAL",
    requestId: randomBytes(8).toString("hex"),
    scopes: [],
  };
  return { actor, scopes: effectiveScopes({ actor, scopes: [] }) };
}

export { SESSION_TTL_HOURS };
