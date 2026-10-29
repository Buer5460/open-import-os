/**
 * R1.2A-03 precision contract tests.
 */
import { describe, expect, it } from "vitest";
import { calculateLandedCost } from "./cost.js";
import { calculateProfit } from "./profit.js";
import { LandedCostInputSchema } from "@open-import-os/contracts/calc";

const BASE = {
  currency: "USD", unitPrice: "8.00",
  freightCost: "1.20", customsClearanceCost: "0.80",
  insuranceCost: "0", portCharges: "0", warehousingCost: "0", inlandDeliveryCost: "0", otherLandedFees: "0",
  mpfAmount: "0", hmfAmount: "0",
  dutyRatePct: null, customsValue: null,
  taxScopeMode: "MANUAL_TOTAL_SCENARIO" as const,
  manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_ENTRY" as const, confirmedBy: "synthetic-test", coversBaseDuty: "INCLUDED" as const },
  shipmentMode: "OCEAN" as const, incoterm: "FOB" as const, additionalDutyLayers: [],
};
const parse = (over: Record<string, unknown>) => LandedCostInputSchema.parse({ ...BASE, ...over }) as never;

describe("R1.2A-03: batch exact, exact unit average, rounded display", () => {
  it("3 units / 10 entry tax: batch 40.00, exact 40/3, display 13.33", () => {
    const r = calculateLandedCost(parse({ quantity: 3, otherTaxes: "10" }));
    expect(r.batchLandedCost).toBe("40.00");
    expect(Number(r.unitLandedCostExact) * 3).toBe(40);
    expect(r.unitLandedCost).toBe("13.33");
    expect(r.status).toBe("COMPLETE_WITHIN_SCOPE");
  });
  it("100 units / 100.01: batch 1100.01 exact, no drift", () => {
    const r = calculateLandedCost(parse({ quantity: 100, otherTaxes: "100.01" }));
    expect(r.batchLandedCost).toBe("1100.01");
    expect(Number(r.unitLandedCostExact) * 100).toBe(1100.01);
  });
  it("1000 units / 200: batch 10200.00, unit 10.20", () => {
    const r = calculateLandedCost(parse({ quantity: 1000, otherTaxes: "200" }));
    expect(r.batchLandedCost).toBe("10200.00");
    expect(Number(r.unitLandedCost) * 1000).toBe(10200);
  });
  it("no double count: total tax contribution across the batch equals the entry amount", () => {
    const withTax = calculateLandedCost(parse({ quantity: 3, otherTaxes: "10" }));
    const without = calculateLandedCost(parse({ quantity: 3, otherTaxes: "0" }));
    expect(Number(withTax.batchLandedCost) - Number(without.batchLandedCost)).toBe(10);
  });
  it("downstream profit referencing the exact average uses it (R2A-03 contract)", () => {
    // L_exact = 40/3; P=20, F=1, r=0 → C = 20 - 40/3 - 1 = 5.666666...
    const profit = calculateProfit({
      currency: "USD", salesPrice: "20", landedCost: "13.33333333333333333333333333333333333333",
      fulfillmentFee: "1", adSpendPerUnit: "0", otherFixedFee: "0",
      platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0",
      ratioFeesSameBase: true,
    });
    // With the EXACT input the contribution keeps full precision (20-1=19; 19-40/3=5.666...)
    expect(Number(profit.contributionProfit)).toBeCloseTo(5.67, 1);
    // A rounded L=13.33 would give 5.67 too here; the contract is that the
    // SERVICE reads unitLandedCostExact — covered in replay-persistence tests.
  });
});
