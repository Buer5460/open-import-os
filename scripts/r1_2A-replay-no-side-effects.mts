/**
 * R2A-02: replay must be side-effect free. Real isolated acc DB; counts rows
 * before/after 3 consecutive replays; asserts run row unchanged.
 */
import { createRequire } from "node:module";
const req = createRequire("/Users/mac/Downloads/外贸问题平台/open-import-os/packages/db/index.ts");
const { PrismaClient } = req("@prisma/client");
const ACC = "postgresql://postgres:postgres@127.0.0.1:55432/open_import_os_acc";
// Safety gate: refuse to run against anything but the acc DB.
if (!ACC.endsWith("open_import_os_acc")) { console.error("FATAL: not the acc database"); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: ACC } } });
process.env.DATABASE_URL = ACC;
const { runLandedCostCalculation, runProfitCalculation, replayCalculation } = await import("../packages/core/src/calculations.js");

let ok = 0, fail = 0; const F: string[] = [];
const ck = (n: string, c: boolean, d?: unknown) => { if (c) { ok++; console.log("  ok ", n); } else { fail++; F.push(n); console.log("FAIL ", n, JSON.stringify(d)?.slice(0, 180)); } };

async function countRuns(orgId: string) { return prisma.calculationRun.count({ where: { organizationId: orgId } }); }

async function main() {
  console.log(`\nR2A-02 replay side-effect check on open_import_os_acc\n`);
  const email = `r12a-${Date.now()}@test.local`;
  const user = await prisma.user.create({ data: { email, displayName: "r12a", passwordHash: "scrypt$16384$8$1$00$00" } });
  const org = await prisma.organization.create({ data: { name: "R1.2A", slug: `r12a-${Date.now()}`, ownerId: user.id } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "OWNER" } });
  const ctx = { actor: { kind: "USER" as const, userId: user.id, organizationId: org.id, roles: ["OWNER" as const], dataMode: "REAL" as const, requestId: "r12a" } };

  const GOLDEN = {
    currency: "USD", unitPrice: "8.00", quantity: 1000,
    freightCost: "1.20", customsClearanceCost: "0.80",
    insuranceCost: "0", portCharges: "0", warehousingCost: "0", inlandDeliveryCost: "0", otherLandedFees: "0",
    mpfAmount: "0", hmfAmount: "0",
    dutyRatePct: null, customsValue: null, otherTaxes: "2.00", taxScopeMode: "MANUAL_TOTAL_SCENARIO",
    manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT", confirmedBy: "golden-sample-spec", coversBaseDuty: "INCLUDED" },
    shipmentMode: "OCEAN", incoterm: "FOB", additionalDutyLayers: [],
  };
  const FEES = { salesPrice: "19.90", fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true };

  const cost = await runLandedCostCalculation(ctx as never, GOLDEN as never);
  const prof = await runProfitCalculation(ctx as never, { ...FEES, currency: "USD", landedCostRunId: cost.run.id } as never);
  const before = await countRuns(org.id);
  const orig = await prisma.calculationRun.findUnique({ where: { id: prof.run.id } });

  // 3 consecutive replays
  const results: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await replayCalculation(ctx as never, prof.run.id);
    results.push(r.run.resultJson);
    const after = await countRuns(org.id);
    ck(`replay #${i + 1}: run count unchanged (${after})`, after === before, { before, after });
  }
  ck("3 replays produce semantically identical output", new Set(results.map((r) => JSON.stringify(r, Object.keys(r as object).sort()))).size === 1);
  const after3 = await prisma.calculationRun.findUnique({ where: { id: prof.run.id } });
  ck("original run row untouched (id/snapshot/result/createdAt)", after3!.id === orig!.id && JSON.stringify(after3!.inputSnapshot) === JSON.stringify(orig!.inputSnapshot) && JSON.stringify(after3!.resultJson) === JSON.stringify(orig!.resultJson) && after3!.createdAt.getTime() === orig!.createdAt.getTime());
  const finalCount = await countRuns(org.id);
  ck("final count == before (no side effects)", finalCount === before, { before, final: finalCount });

  // R1.1 layers preserved: 4 upstream states + guards
  const inc = await runLandedCostCalculation(ctx as never, { ...GOLDEN, taxScopeMode: "ITEMIZED", manualTotalConfirmation: null } as never);
  const pInc = await runProfitCalculation(ctx as never, { ...FEES, currency: "USD", landedCostRunId: inc.run.id } as never);
  ck("INCOMPLETE inherits", (pInc.result as { status: string }).status === "INCOMPLETE");
  const rInc = await replayCalculation(ctx as never, pInc.run.id);
  ck("INCOMPLETE replay identical, no new rows", rInc.identical && (await countRuns(org.id)) === before + 2);

  let tenantRejected = false;
  const org2 = await prisma.organization.create({ data: { name: "R1.2A-B", slug: `r12ab-${Date.now()}`, ownerId: user.id } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org2.id, role: "OWNER" } });
  try { await replayCalculation({ actor: { ...ctx.actor, organizationId: org2.id } } as never, prof.run.id); } catch { tenantRejected = true; }
  ck("cross-tenant replay rejected", tenantRejected);
  let currencyRejected = false;
  try { await runProfitCalculation(ctx as never, { ...FEES, currency: "CNY", landedCostRunId: cost.run.id } as never); } catch { currencyRejected = true; }
  ck("currency mismatch rejected", currencyRejected);

  console.log(`\n${ok} passed, ${fail} failed`);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();
  if (fail > 0) { console.log("failures:", F.join(", ")); process.exit(1); }
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
