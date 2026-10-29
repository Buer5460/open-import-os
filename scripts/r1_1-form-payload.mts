/**
 * R1.1-03: the exact payload the page's form now sends must produce the
 * golden numbers. No injected fields the form cannot produce.
 */
const BASE = "http://127.0.0.1:57931";
async function calc(b: Record<string, unknown>) {
  const r = await fetch(BASE + "/api/calculate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return r.json();
}
let ok = 0, fail = 0; const F: string[] = [];
const ck = (n: string, c: boolean, d?: unknown) => { if (c) { ok++; console.log("  ok ", n); } else { fail++; F.push(n); console.log("FAIL ", n, JSON.stringify(d)?.slice(0, 160)); } };

// What the form sends for the golden sample: user fills every fee box with the
// sample's values and checks the three "确认为0" boxes that apply. otherTaxes
// is the sample's complete tax figure → MANUAL_TOTAL_SCENARIO + coverage.
const goldenForm = {
  unitPrice: "8.00", quantity: "1000",
  freight: "1200", insurance: "", customsClearance: "800",
  inlandFreight: "0", otherCost: "0", portCharges: "", warehousingCost: "",
  dutyRatePct: "", mpf: "0", hmf: "0", otherTaxes: "2.00",
  taxScopeMode: "MANUAL_TOTAL_SCENARIO", taxCoverage: "含基础关税+全部附加税（合成样例）",
  naInsurance: true, naPortCharges: true, naWarehousingCost: true,
  htsCode: "", originCountry: "China",
  salesPrice: "19.90", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0",
  fulfillmentFee: "5.00", adSpendPerUnit: "", otherFixedFee: "",
  naFulfillment: undefined as unknown, naAdSpend: undefined as unknown,
};
goldenForm.naAdSpend = true;   // 样例声明广告费为0
goldenForm.naOtherFixed = true as unknown as boolean;
// note: form checkbox ids: na-fulfillmentFee/na-adSpendPerUnit/na-otherFixedFee
delete (goldenForm as Record<string, unknown>).naFulfillment;
delete (goldenForm as Record<string, unknown>).naAdSpend;
delete (goldenForm as Record<string, unknown>).naOtherFixed;
const formPayload = { ...goldenForm,
  adSpendPerUnit: "0", otherFixedFee: "0",
  naInsurance: true, naPortCharges: true, naWarehousingCost: true,
};

const r1 = await calc(formPayload) as { ok: boolean; landed: { status: string; unitLandedCost: string; totalLandedCost: string }; profit: { status: string; contribution: string; margin: string; breakevenPrice: string | null } | null };
ck("golden via form payload: landed 12", r1.ok && Number(r1.landed.unitLandedCost) === 12, r1.landed);
ck("golden via form payload: COMPLETE", r1.landed.status === "COMPLETE_WITHIN_SCOPE", r1.landed.status);
ck("golden via form payload: C=2.90", r1.profit?.contribution === "2.90", r1.profit);
ck("golden via form payload: margin 14.57%", r1.profit && (Number(r1.profit.margin) * 100).toFixed(2) === "14.57", r1.profit?.margin);
ck("profit COMPLETE via form", r1.profit?.status === "COMPLETE_WITHIN_SCOPE", r1.profit?.status);

// variant tax 2.80
const r2 = await calc({ ...formPayload, otherTaxes: "2.80" }) as typeof r1;
ck("variant 2.80: 12.80/2.10/10.55%", Number(r2.landed.unitLandedCost) === 12.8 && r2.profit?.contribution === "2.10" && (Number(r2.profit.margin) * 100).toFixed(2) === "10.55", { u: r2.landed.unitLandedCost, c: r2.profit?.contribution });

// variant price 9.00
const r3 = await calc({ ...formPayload, unitPrice: "9.00" }) as typeof r1;
ck("variant 9.00: 13.00/1.90", Number(r3.landed.unitLandedCost) === 13 && r3.profit?.contribution === "1.90", { u: r3.landed.unitLandedCost, c: r3.profit?.contribution });

// entry fee 30 over 1000 → +30 batch (synthetic)
const r4 = await calc({ ...formPayload, mpf: "30" }) as unknown as { landed: { totalLandedCost: string } };
const base = await calc(formPayload) as unknown as { landed: { totalLandedCost: string } };
const delta = Number(r4.landed.totalLandedCost) - Number(base.landed.totalLandedCost);
ck("entry fee 30 → batch +30 exactly", Math.abs(delta - 30) < 0.005, delta);

// blank tax with ITEMIZED stays incomplete; profit cannot show complete
const r5 = await calc({ ...formPayload, otherTaxes: "", taxScopeMode: "ITEMIZED", taxCoverage: "" }) as unknown as { landed: { status: string; missingFields: string[] }, profit: { status: string } | null };
ck("blank tax ITEMIZED → INCOMPLETE", r5.landed.status === "INCOMPLETE", r5.landed.status);
ck("profit not complete when cost incomplete", r5.profit === null || r5.profit.status !== "COMPLETE_WITHIN_SCOPE", r5.profit?.status);

console.log(`\n${ok} passed, ${fail} failed`);
if (fail > 0) { console.log("failures:", F.join(", ")); process.exit(1); }
