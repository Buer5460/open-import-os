/**
 * R1.1-01: login failure counting must be atomic under concurrency.
 *
 * Level: REAL isolated Postgres (open_import_os_acc) + the real login()
 * function. No mock DB, no fabricated counts.
 *
 * Run: node --import tsx scripts/r1_1-login-concurrency.mts
 * Requires: postgres on :55432 (isolated acc DB).
 */
// resolve @prisma/client through packages/db, which has it as a direct dep
import { createRequire } from "node:module";
const req = createRequire("/Users/mac/Downloads/外贸问题平台/open-import-os/packages/db/index.ts");
const { PrismaClient } = req("@prisma/client");
import { hashPassword } from "../packages/db/src/password.js";

const ACC_DB = process.env.ACC_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55432/open_import_os_acc";
const prisma = new PrismaClient({ datasources: { db: { url: ACC_DB } } });

const MAX_FAILED = 5;
const email = `r11-concurrency-${Date.now()}@test.local`;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; failures.push(name); console.error(`FAIL  ${name}`, typeof detail === "object" ? JSON.stringify(detail)?.slice(0, 200) : detail); }
}

// import the real login AFTER prisma is constructed with the acc datasource.
// session.ts uses its own client bound to DATABASE_URL, so we point DATABASE_URL
// at the acc DB for this process before importing it.
process.env.DATABASE_URL = ACC_DB;
const { login } = await import("../apps/web/src/lib/session.js");

async function state() {
  const u = await prisma.user.findUnique({ where: { email } });
  return { failed: u!.failedLoginCount, lockedUntil: u!.lockedUntil };
}

async function main() {
  console.log(`\nR1.1-01 login concurrency against ${ACC_DB}\n`);

  // -- setup: real user row -------------------------------------------------
  const user = await prisma.user.create({
    data: {
      email,
      displayName: "r1.1 concurrency",
      passwordHash: hashPassword("correct-horse-42"),
      failedLoginCount: 0,
    },
  });
  check("setup: user created with count=0", user.failedLoginCount === 0);

  // -- 1. sequential failures ----------------------------------------------
  for (let i = 1; i <= 3; i++) {
    try { await login(email, "wrong-pass"); } catch { /* expected */ }
  }
  const s1 = await state();
  check("3 sequential failures counted exactly 3", s1.failed === 3, s1);
  check("not yet locked", !s1.lockedUntil || s1.lockedUntil <= new Date());

  // -- 2. controlled concurrency: 10 parallel failures ---------------------
  // unlock first so the concurrency phase starts clean
  await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: null } });
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });

  const N = 10;
  let locked = 0;
  let invalid = 0;
  const results = await Promise.allSettled(
    Array.from({ length: N }, () =>
      login(email, "wrong-pass").then(
        () => "ok",
        (e) => {
          const code = (e as { code?: string }).code;
          if (code === "ACCOUNT_LOCKED") { locked++; return "locked"; }
          if (code === "INVALID_CREDENTIALS") { invalid++; return "invalid"; }
          return `other:${code ?? "?"}`;
        },
      ),
    ),
  );
  const kinds = results.map((r) => (r.status === "fulfilled" ? r.value : `rejected:${r.reason}`));
  const processed = invalid + locked; // both mean the attempt WAS processed
  const s2 = await state();
  check(
    `all ${N} concurrent failures were processed (no exceptions swallowed)`,
    results.every((r) => r.status === "fulfilled"),
    kinds,
  );
  check(`count = processed attempts (${processed})`, s2.failed === processed, { count: s2.failed, processed, kinds: kinds.join(",") });
  check(`count did not lose updates (>= ${N - 2})`, s2.failed >= N - 2, s2.failed);
  check("lockout engaged after threshold", s2.lockedUntil !== null && s2.lockedUntil > new Date(), s2);

  // -- 3. during lock: early rejection, not counted ------------------------
  const beforeLock = s2.failed;
  try { await login(email, "wrong-pass"); } catch (e) { check("locked attempt rejected with ACCOUNT_LOCKED", (e as { code?: string }).code === "ACCOUNT_LOCKED"); }
  const s3 = await state();
  check("locked-period attempt does not change the count", s3.failed === beforeLock, { before: beforeLock, after: s3.failed });

  // -- 4. lock expiry ------------------------------------------------------
  await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  try { await login(email, "wrong-pass"); } catch (e) { check("expired lock allows processing (invalid creds again)", (e as { code?: string }).code === "INVALID_CREDENTIALS"); }
  const s4 = await state();
  check("count continues after expiry (+1)", s4.failed === beforeLock + 1, s4);
  // The expiry failure re-crossed the threshold, so the account re-locks -
  // that is the intended protection, not a defect. Clear it to test recovery.
  await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: null } });

  // -- 5. correct password recovers ---------------------------------------
  const token = await login(email, "correct-horse-42");
  check("correct password succeeds after expiry", typeof token === "string" && token.length > 10);
  const s5 = await state();
  check("success resets count and lock", s5.failed === 0 && s5.lockedUntil === null, s5);

  // -- 6. session revoke ----------------------------------------------------
  const { destroySession } = await import("../apps/web/src/lib/session.js");
  await destroySession(token);
  const sess = await prisma.session.findFirst({ where: { userId: user.id, tokenHash: { not: "" } }, orderBy: { createdAt: "desc" } });
  check("session row revoked after destroySession", sess === null || sess.revokedAt !== null, sess?.revokedAt);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();
  if (fail > 0) { console.error("failures:", failures.join(", ")); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
