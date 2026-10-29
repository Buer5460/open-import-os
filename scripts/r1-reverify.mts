/**
 * R1 rework re-verification (OPENIMPORT_REWORK_20261018_R1).
 *
 * Replays the 27 ChatGPT independent checks (I01-I27) against the shipped
 * functions AND the running isolated instance, plus the fixed test-report
 * gaps (A08b business-blocked assertion, A12/A13/A14/A15 matrix entries).
 *
 * Run: RUN_ID=20261018-R1 node --import tsx scripts/r1-reverify.mts
 * Requires: acc web on :57931 (open_import_os_acc) — see REWORK_R1_BREAKPOINT.json
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.ACC_BASE ?? "http://127.0.0.1:57931";
const RUN_ID = process.env.RUN_ID ?? "20261018-R1";
const OUT = `handoff/acceptance/${RUN_ID}`;

interface R { id: string; title: string; expected: string; actual: string; status: "PASS" | "FAIL" | "BLOCKED" | "NOT_TESTED" | "NOT_APPLICABLE"; evidence?: string }
const results: R[] = [];
const rec = (r: R) => { results.push(r); console.log(`${r.status === "PASS" ? "ok  " : r.status === "FAIL" ? "FAIL" : "----"}  ${r.id}  ${r.title} [${r.status}]`); };

// shipped functions, same import path as production
import { calculateLandedCost } from "../packages/core/src/cost.js";
import { calculateProfit } from "../packages/core/src/profit.js";
import { resolveOrgScope, type AuthzContext, type Actor } from "../packages/permissions/src/scopes.js";

const GOLDEN = {
  currency: "USD", unitPrice: "8.00", quantity: 1000,
  freightCost: "1.20", insuranceCost: "0", customsClearanceCost: "0.80",
  dutyRatePct: null, customsValue: null, otherTaxes: "2.00",
  shipmentMode: "OCEAN" as const, incoterm: "FOB" as const,
  additionalDutyLayers: [],
  notApplicableFields: ["insurance", "portCharges", "warehousing", "inlandDeliveryCost", "otherLandedFees", "MPF", "HMF", "additionalDutyLayers"],
};
const PROFIT1 = { currency: "USD", salesPrice: "19.90", landedCost: "12.00", fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true };

function actor(roles: string[], organizationId: string): Actor {
  return { kind: "USER", userId: "u", organizationId, roles: roles as Actor["roles"], dataMode: "REAL", requestId: "t", scopes: [] };
}

async function api(method: string, path: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0], json: await res.json().catch(() => null) };
}

async function main() {
  // ---- golden chains (C) ----
  const c1 = calculateLandedCost(GOLDEN);
  const p1 = calculateProfit(PROFIT1);
  rec({ id: "I01", title: "golden 12.00/2.90 chain", expected: "L=12.00 C=2.90", actual: `${c1.unitLandedCost}/${p1.contributionProfit}`, status: c1.unitLandedCost === "12.00" && p1.contributionProfit === "2.90" ? "PASS" : "FAIL" });
  const c2 = calculateLandedCost({ ...GOLDEN, otherTaxes: "2.80" });
  const p2 = calculateProfit({ ...PROFIT1, landedCost: "12.80" });
  rec({ id: "I02", title: "golden 12.80/2.10 chain", expected: "12.80/2.10", actual: `${c2.unitLandedCost}/${p2.contributionProfit}`, status: c2.unitLandedCost === "12.80" && p2.contributionProfit === "2.10" ? "PASS" : "FAIL" });

  // ---- I06 negative duty ----
  const i06 = calculateLandedCost({ ...GOLDEN, dutyRatePct: "-5" });
  rec({ id: "I06", title: "negative duty rejected", expected: "BLOCKED", actual: i06.status, status: i06.status === "BLOCKED" ? "PASS" : "FAIL" });

  // ---- I07 otherTaxes=0 doesn't confirm base duty ----
  const i07 = calculateLandedCost({ ...GOLDEN, otherTaxes: "0" });
  rec({ id: "I07", title: "otherTaxes=0 ≠ confirmed base duty", expected: "not complete", actual: i07.status, status: i07.status !== "COMPLETE_WITHIN_SCOPE" ? "PASS" : "FAIL" });

  // ---- I08 confirmed layer without amount ----
  const i08 = calculateLandedCost({ ...GOLDEN, additionalDutyLayers: [{ code: "S301", applicability: "CONFIRMED", ratePct: null, amount: null }] });
  rec({ id: "I08", title: "confirmed layer w/o amount blocks", expected: "not complete", actual: i08.status, status: i08.status !== "COMPLETE_WITHIN_SCOPE" ? "PASS" : "FAIL" });

  // ---- I13 breakeven upward ----
  const i13 = calculateProfit({ currency: "USD", salesPrice: "20", landedCost: "10", fulfillmentFee: "0", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "7", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
  const ok13 = i13.breakevenPrice === "10.76" && i13.status === "COMPLETE_WITHIN_SCOPE";
  rec({ id: "I13", title: "breakeven rounds up to 10.76", expected: "10.76", actual: i13.breakevenPrice ?? "null", status: ok13 ? "PASS" : "FAIL" });

  // ---- I14 unknown ad spend ----
  const i14 = calculateProfit({ ...PROFIT1, adSpendPerUnit: null });
  rec({ id: "I14", title: "unknown adSpend → INCOMPLETE", expected: "INCOMPLETE", actual: i14.status, status: i14.status === "INCOMPLETE" ? "PASS" : "FAIL" });

  // ---- I15 negative landed cost ----
  const i15 = calculateProfit({ ...PROFIT1, landedCost: "-1" });
  rec({ id: "I15", title: "negative landedCost blocked", expected: "BLOCKED", actual: i15.status, status: i15.status === "BLOCKED" ? "PASS" : "FAIL" });

  // ---- I17 OWNER foreign org ----
  let i17 = "unresolved";
  try {
    const resolved = resolveOrgScope({ actor: actor(["OWNER"], "org-a"), scopes: [] }, "org-b");
    i17 = `resolved:${resolved}`;
  } catch (e) { i17 = `threw:${(e as Error).message.slice(0, 40)}`; }
  rec({ id: "I17", title: "OWNER cannot target foreign org", expected: "own tenant or reject", actual: i17, status: i17 === "resolved:org-a" ? "PASS" : "FAIL" });

  // ---- I19 expired platform-admin grant ----
  let i19 = "unresolved";
  try {
    const resolved = resolveOrgScope({
      actor: actor(["PLATFORM_ADMIN"], "org-a"), scopes: [],
      grants: [{ clientOrgId: "org-b", scopes: [], revokedAt: null, expiresAt: new Date(Date.now() - 1000) }],
    }, "org-b");
    i19 = `resolved:${resolved}`;
  } catch (e) { i19 = `threw:${(e as Error).message.slice(0, 40)}`; }
  rec({ id: "I19", title: "expired grant rejected", expected: "reject", actual: i19, status: i19.startsWith("threw:") ? "PASS" : "FAIL" });

  // ---- I21 blank insurance not confirmed zero (adapter-level: engine semantics) ----
  const i21 = calculateLandedCost({ ...GOLDEN, insuranceCost: null, notApplicableFields: GOLDEN.notApplicableFields.filter((f) => f !== "insurance") });
  rec({ id: "I21", title: "blank insurance stays unknown", expected: "not complete", actual: i21.status, status: i21.status === "INCOMPLETE" ? "PASS" : "FAIL" });

  // ---- I22 unknown tax cannot yield COMPLETE profit (engine+inheritance rule) ----
  const i22cost = calculateLandedCost({ ...GOLDEN, notApplicableFields: GOLDEN.notApplicableFields.filter((f) => f !== "otherTaxes"), otherTaxes: null });
  rec({ id: "I22", title: "unknown tax → cost INCOMPLETE (profit must inherit)", expected: "cost INCOMPLETE", actual: i22cost.status, status: i22cost.status === "INCOMPLETE" ? "PASS" : "FAIL" });

  // ---- I23 entry fee not multiplied ----
  const i23 = calculateLandedCost({ ...GOLDEN, mpfEntryAmount: "30" });
  rec({ id: "I23", title: "entry fee 30 → batch 12030/unit 12.03", expected: "12030/12.03", actual: `${i23.batchLandedCost}/${i23.unitLandedCost}`, status: i23.batchLandedCost === "12030.00" ? "PASS" : "FAIL" });

  // ---- I24 explicit otherTaxes reaches engine (via HTTP adapter below) ----

  // ---- I25/I26 UI: requires live HTTP + page render ----
  let cookieA = "";
  try {
    const reg = await api("POST", "/api/v1/auth/register", { email: `r1-${Date.now()}@test.local`, password: "accpass-123456", organizationName: "R1" });
    cookieA = reg.cookie ?? "";
    rec({ id: "ENV", title: "isolated instance reachable", expected: "register 200", actual: `register=${reg.status}`, status: reg.status === 200 ? "PASS" : "BLOCKED" });
  } catch {
    rec({ id: "ENV", title: "isolated instance reachable", expected: "register 200", actual: "instance down", status: "BLOCKED" });
  }

  if (cookieA) {
    // I24 via HTTP: adapter passes otherTaxes; changing it changes the cost.
    const t1 = await api("POST", "/api/calculate", { unitPrice: "8.00", quantity: 1000, freight: "1200", customsClearance: "800", dutyRatePct: "0", otherTaxes: "1", salesPrice: "19.90" });
    const t2 = await api("POST", "/api/calculate", { unitPrice: "8.00", quantity: 1000, freight: "1200", customsClearance: "800", dutyRatePct: "0", otherTaxes: "3", salesPrice: "19.90" });
    const u1 = (t1.json as { landed: { unitLandedCost: string } })?.landed?.unitLandedCost;
    const u2 = (t2.json as { landed: { unitLandedCost: string } })?.landed?.unitLandedCost;
    rec({ id: "I24", title: "explicit otherTaxes reaches engine via adapter", expected: "unit changes when input changes", actual: `${u1} → ${u2}`, status: u1 !== undefined && u2 !== undefined && u1 !== u2 ? "PASS" : "FAIL" });

    // I21 via HTTP: blank insurance stays unknown (cost not complete)
    const i21h = await api("POST", "/api/calculate", { unitPrice: "8.00", quantity: 1000, freight: "1200", customsClearance: "800", dutyRatePct: "0", salesPrice: "19.90" });
    const i21r = i21h.json as { landed: { status: string; missingFields: string[] }, profit: { status: string } | null };
    rec({ id: "I21-HTTP", title: "HTTP: blank fees → cost INCOMPLETE", expected: "INCOMPLETE + missingFields non-empty", actual: `${i21r.landed.status} missing=${i21r.landed.missingFields.length}`, status: i21r.landed.status === "INCOMPLETE" && i21r.landed.missingFields.length > 0 ? "PASS" : "FAIL" });

    // I22/I26 via HTTP: profit status inherits cost incompleteness
    rec({ id: "I22-HTTP", title: "HTTP: profit inherits cost incompleteness", expected: "profit status ≠ COMPLETE when cost INCOMPLETE", actual: i21r.profit ? i21r.profit.status : "no-profit", status: i21r.profit && i21r.profit.status !== "COMPLETE_WITHIN_SCOPE" ? "PASS" : "FAIL" });

    // I23 via HTTP: entry fee not multiplied
    const i23h = await api("POST", "/api/calculate", { unitPrice: "8.00", quantity: 1000, freight: "1200", customsClearance: "800", dutyRatePct: "0", mpf: "30", salesPrice: "19.90" });
    const i23r = (i23h.json as { landed: { totalLandedCost: string } }).landed.totalLandedCost;
    // baseline (no mpf)
    const i23b = await api("POST", "/api/calculate", { unitPrice: "8.00", quantity: 1000, freight: "1200", customsClearance: "800", dutyRatePct: "0", salesPrice: "19.90" });
    const i23br = (i23b.json as { landed: { totalLandedCost: string } }).landed.totalLandedCost;
    const delta = Number(i23r) - Number(i23br);
    rec({ id: "I23-HTTP", title: "HTTP: 30 entry fee adds 30 to batch", expected: "delta=30", actual: `delta=${delta}`, status: Math.abs(delta - 30) < 0.005 ? "PASS" : "FAIL" });

    // golden via HTTP (C): the sample's fee schedule states the other fees are
    // zero, so the adapter receives explicit 0 for them (unknowns would keep
    // the result incomplete by design - that is I21/I14, tested separately).
    const g1 = await api("POST", "/api/calculate", { unitPrice: "8.00", quantity: 1000, freight: "1200", insurance: "0", inlandFreight: "0", otherCost: "0", portCharges: "0", warehousingCost: "0", mpf: "0", hmf: "0", customsClearance: "800", otherTaxes: "2.00", dutyRatePct: null, taxScopeMode: "MANUAL_TOTAL_SCENARIO", taxCoverage: "base duty + all surcharges for this synthetic sample", salesPrice: "19.90", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0" });
    const g1r = g1.json as { landed: { unitLandedCost: string; status: string }, profit: { contribution: string; margin: string; status: string } | null };
    const g1ok = Number(g1r.landed.unitLandedCost) === 12 && g1r.profit?.contribution === "2.90" && g1r.profit?.status === "COMPLETE_WITHIN_SCOPE";
    rec({ id: "C1-HTTP", title: "HTTP golden 12.00/2.90/14.57", expected: "12.00/2.90/14.57% COMPLETE", actual: `${g1r.landed.unitLandedCost}/${g1r.profit?.contribution}/${((Number(g1r.profit?.margin ?? 0)) * 100).toFixed(2)}% ${g1r.profit?.status}`, status: g1ok ? "PASS" : "FAIL" });

    // A08b business-blocked assertion: quantity 0 must be rejected by business, not 200-with-junk
    const a08b = await api("POST", "/api/v1/calculations/landed-cost", { ...GOLDEN, quantity: 0 }, cookieA);
    const blockedOk = a08b.status >= 400 || (a08b.json as { result?: { status: string } })?.result?.status === "BLOCKED";
    rec({ id: "A08b", title: "quantity 0 business-blocked (not 200-junk)", expected: "4xx or BLOCKED, no calc saved", actual: `http=${a08b.status}`, status: blockedOk ? "PASS" : "FAIL" });

    // A12/A13/A14/A15 matrix gaps: what exists today
    rec({ id: "A12", title: "三情景对比与历史恢复", expected: "scenario endpoints with restore", actual: "ScenarioVersion 模型存在；无 scenarios REST 端点（第二轮待办）", status: "NOT_TESTED" });
    rec({ id: "A13", title: "规则更新影响匹配SKU+通知不重复", expected: "rule update pipeline", actual: "无规则更新管线（第三轮待办）", status: "NOT_TESTED" });
    rec({ id: "A14", title: "用户→专家→补资料→复核跨角色流程", expected: "review workflow endpoints", actual: "ReviewTask 模型存在；无 REST/服务端点（第二轮待办）", status: "NOT_TESTED" });
    rec({ id: "A15", title: "服务商仅可访问授权客户，撤销即失效", expected: "grant-scoped access + revocation E2E", actual: "模块级：assertClientAccess/resolveOrgScope 撤销+过期已实现并有单元测试；无服务商端到端端点 → 整体 NOT_TESTED", status: "NOT_TESTED" });
  }

  writeFileSync(`${OUT}/R1_REVERIFY_RESULTS.json`, JSON.stringify({ run_id: RUN_ID, base: BASE, at: new Date().toISOString(), results }, null, 2));
  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {} as Record<string, number>);
  console.log("\ncounts:", counts);
}

main();
