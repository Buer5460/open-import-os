/**
 * R1.2-03 / criterion G: replay integrity on REAL persisted runs (isolated
 * acc DB). Four upstream states + tenant/currency guards.
 *
 * Run: node --import tsx scripts/r1_2-replay-persistence.mts
 */
import { createRequire } from "node:module";
const req = createRequire("/Users/mac/Downloads/外贸问题平台/open-import-os/packages/db/index.ts");
const { PrismaClient } = req("@prisma/client");
const ACC = "postgresql://postgres:postgres@127.0.0.1:55432/open_import_os_acc";
const prisma = new PrismaClient({ datasources: { db: { url: ACC } } });
process.env.DATABASE_URL = ACC;

const { runProfitCalculation, runLandedCostCalculation, replayCalculation } = await import("../packages/core/src/calculations.js");

let ok = 0, fail = 0; const F: string[] = [];
const ck = (n: string, c: boolean, d?: unknown) => { if (c) { ok++; console.log("  ok ", n); } else { fail++; F.push(n); console.log("FAIL ", n, JSON.stringify(d)?.slice(0, 180)); } };

const GOLDEN = {
  currency: "USD", unitPrice: "8.00", quantity: 1000,
  freightCost: "1.20", customsClearanceCost: "0.80",
  insuranceCost: "0", portCharges: "0", warehousingCost: "0", inlandDeliveryCost: "0", otherLandedFees: "0",
  mpfAmount: "0", hmfAmount: "0",
  dutyRatePct: null, customsValue: null,
  otherTaxes: "2.00", taxScopeMode: "MANUAL_TOTAL_SCENARIO",
  manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT", confirmedBy: "golden-sample-spec" },
  shipmentMode: "OCEAN", incoterm: "FOB", additionalDutyLayers: [],
};
const PROFIT_FEES = { salesPrice: "19.90", fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true };

function actor(orgId: string) {
  return { kind: "USER" as const, userId: "r12", organizationId: orgId, roles: ["OWNER" as const], dataMode: "REAL" as const, requestId: "r12", scopes: [] };
}

async function main() {
  console.log(`\nR1.2-03 replay integrity on ${ACC}\n`);
  const email = `r12-${Date.now()}@test.local`;
  const org = await prisma.organization.create({ data: { name: "R1.2 org", slug: `r12-${Date.now()}`, ownerId: null as never } }).catch(() => null);
  // simpler: create user+org via the API session path is heavy; create rows directly
  const user = await prisma.user.create({ data: { email, displayName: "r12", passwordHash: "scrypt$16384$8$1$00$00" } });
  const org2 = await prisma.organization.create({ data: { name: "R1.2 org", slug: `r12-${Date.now()}`, ownerId: user.id } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: org2.id, role: "OWNER" } });
  const ctx = { actor: actor(org2.id) };

  // --- G1: COMPLETE cost -> profit -> replay identical ----------------------
  const cost1 = await runLandedCostCalculation(ctx as never, GOLDEN as never);
  ck("G1 cost saved COMPLETE", (cost1.result as { status: string }).status === "COMPLETE_WITHIN_SCOPE");
  const prof1 = await runProfitCalculation(ctx as never, { ...PROFIT_FEES, currency: "USD", landedCostRunId: cost1.run.id } as never);
  ck("G1 profit COMPLETE", (prof1.result as { status: string }).status === "COMPLETE_WITHIN_SCOPE");
  ck("G1 profit contribution 2.90", (prof1.result as { contributionProfit: string }).contributionProfit === "2.90");
  const rep1 = await replayCalculation(ctx as never, prof1.run.id);
  if (!rep1.identical) {
    const stored = prof1.run.resultJson as Record<string, unknown>;
    const snap = prof1.run.inputSnapshot as Record<string, unknown>;
    const re2 = await runProfitCalculation(ctx as never, snap as never);
    for (const k of Object.keys(stored)) {
      const a = JSON.stringify(stored[k]), b = JSON.stringify((re2.result as Record<string, unknown>)[k]);
      if (a !== b) console.log("  G1 DIFF", k, ":", String(a).slice(0, 90), "<>", String(b).slice(0, 90));
    }
    console.log("  G1 stored status:", rep1.run.status, "| replayVersionMismatch:", (rep1.run as { replayVersionMismatch?: boolean }).replayVersionMismatch);
  }
  ck("G1 profit replay identical", rep1.identical === true);
  const rep1c = await replayCalculation(ctx as never, cost1.run.id);
  ck("G1 cost replay identical", rep1c.identical === true);

  // --- G2: INCOMPLETE cost -> profit inherits -> replay stays INCOMPLETE ----
  const cost2 = await runLandedCostCalculation(ctx as never, { ...GOLDEN, taxScopeMode: "ITEMIZED", manualTotalConfirmation: null } as never);
  ck("G2 cost INCOMPLETE", (cost2.result as { status: string }).status === "INCOMPLETE");
  const prof2 = await runProfitCalculation(ctx as never, { ...PROFIT_FEES, currency: "USD", landedCostRunId: cost2.run.id } as never);
  ck("G2 profit inherits INCOMPLETE", (prof2.result as { status: string }).status === "INCOMPLETE");
  ck("G2 profit missing includes dutyRatePct", ((prof2.result as { missingFields: string[] }).missingFields).includes("dutyRatePct"));
  const rep2 = await replayCalculation(ctx as never, prof2.run.id);
  ck("G2 replay identical (still INCOMPLETE)", rep2.identical === true);
  ck("G2 replayed result NOT COMPLETE", (rep2.run.resultJson as { status: string }).status !== "COMPLETE_WITHIN_SCOPE");

  // --- G3: REVIEW_REQUIRED cost -> replay does not become COMPLETE ----------
  const cost3 = await runLandedCostCalculation(ctx as never, {
    ...GOLDEN,
    additionalDutyLayers: [{ code: "OLD-RULE", applicability: "UNCOVERED", ratePct: "25", amount: null }],
  } as never);
  ck("G3 cost REVIEW_REQUIRED", (cost3.result as { status: string }).status === "REVIEW_REQUIRED");
  const prof3 = await runProfitCalculation(ctx as never, { ...PROFIT_FEES, currency: "USD", landedCostRunId: cost3.run.id } as never);
  ck("G3 profit inherits REVIEW_REQUIRED", (prof3.result as { status: string }).status === "REVIEW_REQUIRED");
  const rep3 = await replayCalculation(ctx as never, prof3.run.id);
  ck("G3 replay identical", rep3.identical === true);
  ck("G3 replay NOT COMPLETE", (rep3.run.resultJson as { status: string }).status !== "COMPLETE_WITHIN_SCOPE");

  // --- G4: BLOCKED cost -> profit BLOCKED, replay never restores numbers ----
  const cost4 = await runLandedCostCalculation(ctx as never, { ...GOLDEN, quantity: 0 } as never);
  ck("G4 cost BLOCKED", (cost4.result as { status: string }).status === "BLOCKED");
  const prof4 = await runProfitCalculation(ctx as never, { ...PROFIT_FEES, currency: "USD", landedCostRunId: cost4.run.id } as never);
  ck("G4 profit BLOCKED", (prof4.result as { status: string }).status === "BLOCKED");
  ck("G4 profit has no contribution number", (prof4.result as { contributionProfit: string | null }).contributionProfit === null);
  const rep4 = await replayCalculation(ctx as never, prof4.run.id);
  ck("G4 replay identical", rep4.identical === true);
  ck("G4 replay still BLOCKED, no number", (rep4.run.resultJson as { status: string }).status === "BLOCKED" && (rep4.run.resultJson as { contributionProfit: string | null }).contributionProfit === null);

  // --- G5: tenant / currency guards on replay -------------------------------
  const otherOrg = await prisma.organization.create({ data: { name: "R1.2 other", slug: `r12b-${Date.now()}`, ownerId: user.id } });
  await prisma.membership.create({ data: { userId: user.id, organizationId: otherOrg.id, role: "OWNER" } });
  let tenantRejected = false;
  try {
    await replayCalculation({ actor: actor(otherOrg.id) } as never, prof1.run.id);
  } catch { tenantRejected = true; }
  ck("G5 foreign-org replay rejected", tenantRejected);
  let currencyRejected = false;
  try {
    await runProfitCalculation(ctx as never, { ...PROFIT_FEES, currency: "CNY", landedCostRunId: cost1.run.id } as never);
  } catch { currencyRejected = true; }
  ck("G5 currency mismatch rejected", currencyRejected);

  console.log(`\n${ok} passed, ${fail} failed`);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  await prisma.$disconnect();
  if (fail > 0) { console.log("failures:", F.join(", ")); process.exit(1); }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
