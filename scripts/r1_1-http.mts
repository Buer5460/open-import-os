const BASE = "http://127.0.0.1:57931";
async function api(m: string, p: string, b?: unknown, c?: string) {
  const r = await fetch(BASE + p, { method: m, headers: { ...(b ? { "content-type": "application/json" } : {}), ...(c ? { cookie: c } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, cookie: r.headers.get("set-cookie")?.split(";")[0], json: await r.json().catch(() => null) };
}
const GOLDEN = {
  currency: "USD", unitPrice: "8.00", quantity: 1000,
  freightCost: "1.20", insuranceCost: "0", customsClearanceCost: "0.80",
  dutyRatePct: null, customsValue: null, otherTaxes: "2.00",
  shipmentMode: "OCEAN", incoterm: "FOB", additionalDutyLayers: [],
  notApplicableFields: ["insurance","portCharges","warehousing","inlandDeliveryCost","otherLandedFees","MPF","HMF","additionalDutyLayers"],
  taxScopeMode: "MANUAL_TOTAL_SCENARIO",
  manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT", confirmedBy: "golden-sample-spec" },
};
let ok = 0, fail = 0; const F: string[] = [];
const ck = (n: string, c: boolean, d?: unknown) => { if (c) { ok++; console.log("  ok ", n); } else { fail++; F.push(n); console.log("FAIL ", n, JSON.stringify(d)?.slice(0,150)); } };

// register isolated org
const reg = await api("POST", "/api/v1/auth/register", { email: `r11-http-${Date.now()}@test.local`, password: "accpass-123456", organizationName: "R1.1" });
ck("register", reg.status === 200, reg.status);
const c = reg.cookie!;

// 1. save a COMPLETE landed-cost run
const r1 = await api("POST", "/api/v1/calculations/landed-cost", GOLDEN, c);
ck("golden cost saved", r1.status === 200 && (r1.json as { result: { unitLandedCost: string } }).result.unitLandedCost === "12.00", r1.json?.result?.unitLandedCost);
const runId = (r1.json as { runId: string }).runId;

// 2. profit referencing the snapshot: server reads L from the run, ignores client landedCost
const p1 = await api("POST", "/api/v1/calculations/profit", {
  currency: "USD", salesPrice: "19.90", landedCostRunId: runId,
  landedCost: "0.01", // forged tiny cost — must be IGNORED in favour of the snapshot
  fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0",
  platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true,
}, c);
const p1r = (p1.json as { result: { contributionProfit: string; status: string } }).result;
ck("snapshot L used (forged 0.01 ignored → C=2.90)", p1r.contributionProfit === "2.90", p1r);
ck("profit COMPLETE when upstream COMPLETE", p1r.status === "COMPLETE_WITHIN_SCOPE", p1r.status);

// 3. cross-tenant snapshot read is 404
const reg2 = await api("POST", "/api/v1/auth/register", { email: `r11-other-${Date.now()}@test.local`, password: "accpass-123456", organizationName: "R1.1-B" });
const p2 = await api("POST", "/api/v1/calculations/profit", { currency: "USD", salesPrice: "19.90", landedCostRunId: runId, fulfillmentFee: "5", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true }, reg2.cookie!);
ck("foreign snapshot read rejected (404)", p2.status === 404, p2.status);

// 4. INCOMPLETE cost → profit inherits INCOMPLETE
const inc = await api("POST", "/api/v1/calculations/landed-cost", { ...GOLDEN, taxScopeMode: "ITEMIZED", manualTotalConfirmation: null }, c);
const incRun = (inc.json as { runId: string }).runId;
const incRes = (inc.json as { result: { status: string } }).result;
ck("ITEMIZED otherTaxes=2.00 cost is INCOMPLETE", incRes.status === "INCOMPLETE", incRes.status);
const p3 = await api("POST", "/api/v1/calculations/profit", { currency: "USD", salesPrice: "19.90", landedCostRunId: incRun, fulfillmentFee: "5", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true }, c);
const p3r = (p3.json as { result: { status: string; missingFields: string[] } }).result;
ck("profit inherits INCOMPLETE (not COMPLETE)", p3r.status === "INCOMPLETE", p3r.status);
ck("profit missingFields include dutyRatePct", p3r.missingFields.includes("dutyRatePct"), p3r.missingFields);

// 5. currency mismatch rejected
const p4 = await api("POST", "/api/v1/calculations/profit", { currency: "CNY", salesPrice: "19.90", landedCostRunId: runId, fulfillmentFee: "5", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true }, c);
ck("currency mismatch rejected (400)", p4.status === 400, p4.status);

console.log(`\n${ok} passed, ${fail} failed`);
if (fail > 0) { console.log("failures:", F.join(", ")); process.exit(1); }
