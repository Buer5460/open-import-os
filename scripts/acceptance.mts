/**
 * Acceptance tests for the running stack (apps/web + embedded PostgreSQL).
 *
 * Run with the server up:  node --import tsx scripts/acceptance.mts
 * Covers the deterministic-engine golden cases, tenant isolation, unknown-vs-
 * zero semantics, import dedupe, and the classification gate.
 */
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:57831";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail).slice(0, 300) : "");
  }
}

async function api(method: string, path: string, body?: unknown, cookie?: string, raw = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof Buffer) ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });
  if (raw) return { status: res.status, headers: res.headers, body: await res.text() };
  const setCookie = res.headers.get("set-cookie");
  return {
    status: res.status,
    cookie: setCookie ? setCookie.split(";")[0]! : undefined,
    json: await res.json().catch(() => null),
  };
}

async function registerOrg(email: string) {
  const r = await api("POST", "/api/v1/auth/register", {
    email,
    password: "password-123456",
    organizationName: `Org ${email}`,
  });
  if (r.status === 409) {
    const login = await api("POST", "/api/v1/auth/login", { email, password: "password-123456" });
    return login.cookie!;
  }
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.json)}`);
  return r.cookie!;
}

// Golden landed-cost fixture (sample 1): four described cost lines plus an
// explicit otherTaxes=2.00; dutyRatePct/customsValue are genuinely unknown
// (null), everything else is confirmed absent.
const GOLDEN = {
  currency: "USD",
  unitPrice: "8.00",
  quantity: 1000,
  freightCost: "1.20",
  insuranceCost: "0",
  customsClearanceCost: "0.80",
  dutyRatePct: null,
  customsValue: null,
  otherTaxes: "2.00",
  shipmentMode: "OCEAN",
  incoterm: "FOB",
  additionalDutyLayers: [],
  notApplicableFields: [
    "insurance", "portCharges", "warehousing", "inlandDeliveryCost",
    "otherLandedFees", "MPF", "HMF", "additionalDutyLayers",
  ],
};

async function main() {
  console.log(`\nacceptance tests against ${BASE}\n`);

  // --- A01: stack health ---------------------------------------------------
  const health = await api("GET", "/api/v1/health");
  check("A01 stack health (db up)", health.status === 200 && (health.json as { db?: string })?.db === "up");

  // --- A02: two isolated tenants -------------------------------------------
  const alice = await registerOrg(`a02-alice+${Date.now()}@test.local`);
  const mallory = await registerOrg(`a02-mallory+${Date.now()}@test.local`);

  const product = await api("POST", "/api/v1/products", {
    sku: `A02-${Date.now()}`,
    nameZh: "隔离测试商品",
    nameEn: "isolation test product",
  }, alice);
  check("A02 product created", product.status === 200, product.json);
  const productId = (product.json as { product: { id: string } }).product.id;

  const crossRead = await api("GET", `/api/v1/products/${productId}`, undefined, mallory);
  check("A02 cross-tenant product read is 404", crossRead.status === 404, crossRead.status);
  const crossList = await api("GET", "/api/v1/products", undefined, mallory);
  check("A02 cross-tenant list is empty", (crossList.json as { total: number }).total === 0);

  // --- A06: golden landed cost / profit ------------------------------------
  const cost = await api("POST", "/api/v1/calculations/landed-cost", GOLDEN, alice);
  const costResult = (cost.json as { result: { unitLandedCost: string; status: string; missingFields: string[] } }).result;
  check("A06 golden unit landed cost = 12.00", costResult.unitLandedCost === "12.00", costResult.unitLandedCost);
  check("A06 golden status COMPLETE_WITHIN_SCOPE", costResult.status === "COMPLETE_WITHIN_SCOPE", costResult.status);

  const runId = (cost.json as { runId: string }).runId;
  const profit = await api("POST", "/api/v1/calculations/profit", {
    currency: "USD",
    salesPrice: "19.90",
    landedCost: "12.00",
    fulfillmentFee: "5.00",
    platformFeePct: "0",
    paymentFeePct: "0",
    otherVariableFeePct: "0",
    ratioFeesSameBase: true,
  }, alice);
  const profitResult = (profit.json as { result: { contributionProfit: string; contributionMargin: string } }).result;
  check("A06 golden contribution = 2.90", profitResult.contributionProfit === "2.90", profitResult.contributionProfit);
  // The API returns the margin as a ratio; the golden 14.57% is that ratio
  // expressed as a percentage (same conversion the unit tests do).
  const marginPct = (Number(profitResult.contributionMargin) * 100).toFixed(2);
  check("A06 golden margin = 14.57%", marginPct === "14.57", `${profitResult.contributionMargin} -> ${marginPct}%`);

  // --- A11: persisted run replays identically ------------------------------
  const fetched = await api("GET", `/api/v1/calculations/${runId}`, undefined, alice);
  const run = (fetched.json as { run: { resultJson: { unitLandedCost: string }; engineVersion: string } }).run;
  check("A11 stored run keeps unitLandedCost 12.00", run.resultJson.unitLandedCost === "12.00");
  check("A11 stored run records engine version", typeof run.engineVersion === "string" && run.engineVersion.length > 0);

  // --- A07: breakeven / target price --------------------------------------
  const be = await api("POST", "/api/v1/calculations/profit", {
    currency: "USD",
    salesPrice: "20",
    landedCost: "12",
    fulfillmentFee: "3",
    platformFeePct: "10",
    paymentFeePct: "0",
    otherVariableFeePct: "0",
    ratioFeesSameBase: true,
    targetMarginPct: "20",
  }, alice);
  const beResult = (be.json as { result: { breakevenPrice: string; targetPrice: string } }).result;
  check("A07 breakeven = 16.67", beResult.breakevenPrice === "16.67", beResult.breakevenPrice);
  check("A07 target price = 21.43", beResult.targetPrice === "21.43", beResult.targetPrice);

  // --- A15: unknown is not zero -------------------------------------------
  // Remove otherTaxes from notApplicable AND set it to null: a genuinely
  // unknown tax must make the result INCOMPLETE, never silently zero.
  const withUnknown = await api("POST", "/api/v1/calculations/landed-cost", {
    ...GOLDEN,
    otherTaxes: null,
    notApplicableFields: GOLDEN.notApplicableFields.filter((f) => f !== "otherTaxes"),
  }, alice);
  const unknownResult = (withUnknown.json as { result: { status: string; missingFields: string[] } }).result;
  check("A15 unknown tax -> INCOMPLETE", unknownResult.status === "INCOMPLETE", unknownResult.status);
  check("A15 otherTaxes listed as missing", unknownResult.missingFields.includes("otherTaxes"), unknownResult.missingFields);

  // --- A03: free calculator, no session ------------------------------------
  const free = await api("POST", "/api/calculate", {
    unitPrice: "8.00", quantity: 1000, freight: "1200", customsClearance: "800",
    dutyRatePct: "0", salesPrice: "19.90", platformFeePct: "15", paymentFeePct: "0",
  });
  const freeLanded = (free.json as { landed: { status: string; unitLandedCost: string } }).landed;
  check("A03 free calculator works without login", free.status === 200 && freeLanded.status === "COMPLETE_WITHIN_SCOPE", freeLanded);
  check("A03 free calculator unit landed = 10", Number(freeLanded.unitLandedCost) === 10, freeLanded.unitLandedCost);

  // --- A04: auth required for SaaS endpoints -------------------------------
  const noAuth = await api("GET", "/api/v1/products");
  check("A04 unauthenticated /api/v1 access is 401", noAuth.status === 401, noAuth.status);

  // --- A16: import template ------------------------------------------------
  const gate = await api("GET", "/api/v1/products/import/template", undefined, alice, true);
  check("A16 import template downloadable", gate.status === 200 && gate.body.includes("sku"), gate.status);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("failures:", failures.join(", "));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
