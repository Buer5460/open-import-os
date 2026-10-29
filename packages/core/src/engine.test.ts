import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { calculateLandedCost, allocateBatch } from "./cost.js";
import { calculateProfit, verifyTargetPrice } from "./profit.js";
import { allocateTotal, displayMoney, displayPercent, toDecimal } from "@open-import-os/contracts/money";
import { LandedCostInputSchema } from "@open-import-os/contracts/calc";
import type { LandedCostInput, ProfitInput } from "@open-import-os/contracts/calc";

/**
 * GOLDEN CASES from the specification.
 * These are synthetic test assumptions, not real tariff rates for any product.
 */

/** The raw fixture fields, before schema validation. */
const rawCost = (over: Record<string, unknown> = {}) => ({
  currency: "USD",
  unitPrice: "8.00",
  quantity: 1000,
  freightCost: "1.20",
  insuranceCost: "0",
  customsClearanceCost: "0.80",
  dutyRatePct: "0",
  customsValue: "0",
  shipmentMode: "OCEAN",
  incoterm: "FOB",
  // The golden samples only describe four cost lines. Everything else is
  // explicitly confirmed as "not applicable" so the sample is a complete,
  // auditable scenario rather than a silent guess.
  additionalDutyLayers: [],
  notApplicableFields: [
    "insurance",
    "portCharges",
    "warehousing",
    "inlandDeliveryCost",
    "otherLandedFees",
    "MPF",
    "HMF",
    "additionalDutyLayers",
  ],
  ...over,
});

/**
 * Build a landed-cost fixture through the real schema so Zod defaults are
 * applied. This also makes the golden samples validated contracts rather than
 * hand-written literals that could drift from the schema.
 */
const baseCost = (over: Record<string, unknown> = {}): LandedCostInput =>
  LandedCostInputSchema.parse(rawCost(over));

/**
 * A fixture that deliberately SKIPS schema validation. The engines keep
 * runtime guards for values that reach them unvalidated (e.g. rows loaded
 * from the database), and those guards need their own tests.
 */
const unvalidatedCost = (over: Record<string, unknown> = {}): LandedCostInput =>
  rawCost(over) as unknown as LandedCostInput;

describe("A06 - golden landed cost / profit (sample 1)", () => {
  it("computes 12.00 unit landed cost, 2.90 profit, 14.57% margin", () => {
    const cost = calculateLandedCost(
      baseCost({
        dutyRatePct: null,
        customsValue: null,
        otherTaxes: "2.00",
        // The golden sample's 2.00 is the sample's complete tax figure.
        // Migration note: legacy snapshots that used otherTaxes this way are
        // re-read under ITEMIZED and flagged to pick a scope; new runs must
        // declare the mode explicitly (R1.1-02).
        taxScopeMode: "MANUAL_TOTAL_SCENARIO",
        manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT", confirmedBy: "golden-sample-spec" },
      }),
    );
    expect(cost.unitLandedCost).toBe("12.00");
    expect(cost.status).toBe("COMPLETE_WITHIN_SCOPE");

    const profit = calculateProfit({
      currency: "USD",
      salesPrice: "19.90",
      landedCost: "12.00",
      fulfillmentFee: "5.00",
      // The golden sample's fee schedule: ad spend and other fixed fees are
      // CONFIRMED zero in the sample, not unknown (unknown would make the
      // result incomplete by design).
      adSpendPerUnit: "0",
      otherFixedFee: "0",
      platformFeePct: "0",
      paymentFeePct: "0",
      otherVariableFeePct: "0",
      ratioFeesSameBase: true,
    } satisfies ProfitInput);
    expect(profit.contributionProfit).toBe("2.90");
    expect(displayPercent(toDecimal(profit.contributionMargin))).toBe("14.57%");
  });

  it("recomputes 12.80 / 2.10 / 10.55% when the tax becomes 2.80", () => {
    const cost = calculateLandedCost(
      baseCost({
        dutyRatePct: null,
        customsValue: null,
        otherTaxes: "2.80",
        taxScopeMode: "MANUAL_TOTAL_SCENARIO",
        manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT", confirmedBy: "golden-sample-spec" },
      }),
    );
    expect(cost.unitLandedCost).toBe("12.80");

    const profit = calculateProfit({
      currency: "USD",
      salesPrice: "19.90",
      landedCost: "12.80",
      fulfillmentFee: "5.00",
      adSpendPerUnit: "0",
      otherFixedFee: "0",
      platformFeePct: "0",
      paymentFeePct: "0",
      otherVariableFeePct: "0",
      ratioFeesSameBase: true,
    });
    expect(profit.contributionProfit).toBe("2.10");
    expect(displayPercent(toDecimal(profit.contributionMargin))).toBe("10.55%");
  });

  it("shows the 800.00 contribution-profit drop over 1000 units", () => {
    const a = calculateProfit({ currency: "USD", salesPrice: "19.90", landedCost: "12.00", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "5.00", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    const b = calculateProfit({ currency: "USD", salesPrice: "19.90", landedCost: "12.80", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "5.00", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    const delta = toDecimal(a.contributionProfit)!.minus(toDecimal(b.contributionProfit)!).times(1000);
    expect(displayMoney(delta)).toBe("800.00");
  });
});

describe("A07 - golden profit model (sample 2)", () => {
  const input: ProfitInput = {
    currency: "USD",
    salesPrice: "20",
    landedCost: "12",
    fulfillmentFee: "3",
    adSpendPerUnit: "0",
    otherFixedFee: "0",
    platformFeePct: "10",
    paymentFeePct: "0",
    otherVariableFeePct: "0",
    ratioFeesSameBase: true,
    targetMarginPct: "20",
  };

  it("computes C=3.00 and margin 15%", () => {
    const r = calculateProfit(input);
    expect(r.contributionProfit).toBe("3.00");
    expect(displayPercent(toDecimal(r.contributionMargin))).toBe("15.00%");
  });

  it("computes breakeven 16.67 and target 21.43", () => {
    const r = calculateProfit(input);
    expect(r.breakevenPrice).toBe("16.67");
    expect(r.targetPrice).toBe("21.43");
  });

  it("the rounded-up target price still satisfies the 20% target", () => {
    const r = calculateProfit(input);
    const quote = toDecimal(r.targetPrice)!;
    expect(verifyTargetPrice(quote, new Decimal(12), new Decimal(3), new Decimal(10), new Decimal(20))).toBe(true);
    // margin at the quote must be >= 20%
    const marginAtQuote = quote.times(0.9).minus(15).dividedBy(quote);
    expect(marginAtQuote.greaterThanOrEqualTo(new Decimal("0.20"))).toBe(true);
  });
});

describe("A08 - incomplete inputs never pass silently", () => {
  it("rejects quantity 0", () => {
    // A quantity of 0 is rejected by the schema at the API boundary. It can
    // still reach the engine from an unvalidated source, so the engine keeps
    // its own guard - and that guard is what this test exercises.
    expect(() => LandedCostInputSchema.parse(rawCost({ quantity: 0 }))).toThrow();
    const cost = calculateLandedCost(unvalidatedCost({ quantity: 0 }));
    expect(cost.status).toBe("BLOCKED");
    expect(cost.missingFields).toContain("quantity");
  });

  it("blocks a non-USD currency with no fxRate instead of assuming 1:1", () => {
    const cost = calculateLandedCost(baseCost({ currency: "CNY", fxRate: null }));
    expect(cost.status).toBe("BLOCKED");
    expect(cost.missingFields).toContain("fxRate");
  });

  it("treats an unknown tax as unknown, not 0", () => {
    // dutyRatePct, MPF and HMF are explicitly "not applicable" here; only
    // otherTaxes is left genuinely unknown.
    const cost = calculateLandedCost(
      baseCost({
        dutyRatePct: null,
        customsValue: null,
        otherTaxes: null,
        notApplicableFields: ["insurance", "portCharges", "warehousing", "inlandDeliveryCost", "otherLandedFees", "MPF", "HMF", "additionalDutyLayers", "duty rate"],
      }),
    );
    expect(cost.status).toBe("INCOMPLETE");
    expect(cost.missingFields).toContain("otherTaxes");
    // An unknown component must not contribute a 0 to the total.
    expect(cost.components.find((c) => c.label === "other taxes")).toBeUndefined();
    // And the unknown must be visible in the breakdown, not silently dropped.
    expect(cost.dutyTax).not.toBeNull();
  });

  it("refuses weight allocation when a weight is missing", () => {
    const r = allocateBatch({
      currency: "USD",
      method: "BY_WEIGHT",
      batchAmounts: [{ label: "freight", amount: "100", alreadyIncluded: false }],
      items: [
        { sku: "A", quantity: 10, weightKg: "5" },
        { sku: "B", quantity: 10, weightKg: null },
      ],
    });
    expect(r.status).toBe("BLOCKED");
    expect(r.missingFields).toContain("weightKg for B");
  });

  it("marks expired rule data as review-required rather than current", () => {
    const cost = calculateLandedCost(
      baseCost({
        additionalDutyLayers: [
          { code: "SEC301-EXPIRED", applicability: "UNCOVERED", ratePct: "25", note: "collection stopped" },
        ],
      }),
    );
    expect(cost.status).toBe("REVIEW_REQUIRED");
    expect(cost.dutyTax?.uncovered).toContain("SEC301-EXPIRED");
  });
});

describe("A09 - allocation conserves money and never double-charges", () => {
  it("BY_VALUE allocation sums exactly to the batch total", () => {
    const r = allocateBatch({
      currency: "USD",
      method: "BY_VALUE",
      batchAmounts: [{ label: "freight", amount: "100.00", alreadyIncluded: false }, { label: "insurance", amount: "33.33", alreadyIncluded: false }],
      items: [
        { sku: "A", quantity: 10, value: "300" },
        { sku: "B", quantity: 20, value: "100" },
        { sku: "C", quantity: 5, value: "600" },
      ],
    });
    expect(r.conserved).toBe(true);
    const sum = r.allocations.reduce((a, b) => a.plus(toDecimal(b.total)!), new Decimal(0));
    expect(sum.equals(new Decimal("133.33"))).toBe(true);
  });

  it("BY_QUANTITY allocation with an awkward total still conserves", () => {
    const r = allocateBatch({
      currency: "USD",
      method: "BY_QUANTITY",
      batchAmounts: [{ label: "clearance", amount: "100", alreadyIncluded: false }],
      items: [
        { sku: "A", quantity: 1 },
        { sku: "B", quantity: 1 },
        { sku: "C", quantity: 1 },
      ],
    });
    expect(r.conserved).toBe(true);
    expect(new Decimal(r.batchTotal).equals(new Decimal("100"))).toBe(true);
  });

  it("a fee already inside the incoterm is not charged again", () => {
    const cost = calculateLandedCost(
      baseCost({
        freightCost: "1.20",
        includedItems: ["freight"],
        incoterm: "CIF",
      }),
    );
    const freight = cost.components.find((c) => c.label === "freight");
    expect(freight?.amount).toBe("0");
    expect(freight?.basis).toBe("INCLUDED_IN_TERMS");
    // 8 + 0 (freight skipped) + 0.8 = 8.80
    expect(cost.unitLandedCost).toBe("8.80");
  });

  it("allocateTotal distributes residue deterministically", () => {
    const parts = allocateTotal(new Decimal("1"), [new Decimal(1), new Decimal(1), new Decimal(1)]);
    expect(parts.reduce((a, b) => a.plus(b), new Decimal(0)).equals(new Decimal(1))).toBe(true);
  });
});

describe("A10 - candidate layers are never auto-summed", () => {
  it("candidate additional duties do not join the total", () => {
    const cost = calculateLandedCost(
      baseCost({
        dutyRatePct: "3.5",
        customsValue: "10",
        otherTaxes: null,
        insuranceCost: null,
        additionalDutyLayers: [
          { code: "SEC301", applicability: "CANDIDATE", ratePct: "25" },
          { code: "IEEPA", applicability: "CONFIRMED", ratePct: "10" },
        ],
      }),
    );
    // duty 10*3.5% = 0.35 + confirmed IEEPA 10*10% = 1.00 => 1.35 taxes
    const taxes = cost.dutyTax!.confirmed.find((c) => c.label === "IEEPA");
    expect(taxes?.amount).toBe("1");
    expect(cost.dutyTax!.candidates).toHaveLength(1);
    // purchase 8 + freight 1.2 + clearance 0.8 + duty 0.35 + IEEPA 1.0 = 11.35
    expect(cost.unitLandedCost).toBe("11.35");
  });

  it("conflicting rules block a complete conclusion", () => {
    const cost = calculateLandedCost(
      baseCost({
        dutyRatePct: "3.5",
        customsValue: "10",
        additionalDutyLayers: [
          { code: "A", applicability: "CONFLICT", ratePct: "10" },
          { code: "B", applicability: "CONFLICT", ratePct: "20" },
        ],
      }),
    );
    expect(cost.status).toBe("REVIEW_REQUIRED");
    expect(cost.dutyTax?.conflicts).toEqual(["A", "B"]);
  });

  it("a duty rate without a customs value is not computed", () => {
    const cost = calculateLandedCost(baseCost({ dutyRatePct: "5", customsValue: null }));
    expect(cost.missingFields).toContain("customsValue");
    expect(cost.unsupportedComponents).toContain("duty rate supplied without customsValue");
  });
});

describe("A11 - determinism and replay", () => {
  it("identical inputs and engine version produce identical results", () => {
    const input = baseCost({ dutyRatePct: "3.5", customsValue: "10", otherTaxes: "0.5" });
    const a = calculateLandedCost(input);
    const b = calculateLandedCost(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.engineVersion).toBe(b.engineVersion);
  });
});

describe("negative profit is allowed; nonsense is not", () => {
  it("allows a negative contribution profit", () => {
    const r = calculateProfit({ currency: "USD", salesPrice: "10", landedCost: "12", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "5", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    expect(r.contributionProfit).toBe("-7.00");
    expect(r.status).toBe("COMPLETE_WITHIN_SCOPE");
  });

  it("refuses a non-positive sales price", () => {
    const r = calculateProfit({ currency: "USD", salesPrice: "0", landedCost: "12", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "5", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    expect(r.status).toBe("BLOCKED");
    expect(r.contributionMargin).toBeNull();
  });

  it("reports an unreachable target instead of a negative denominator", () => {
    // r = 85% leaves only 15% for cost+margin; asking for a further 20% margin
    // makes the denominator negative. The engine must refuse, not emit a
    // negative "required price".
    const r = calculateProfit({ currency: "USD", salesPrice: "20", landedCost: "12", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "3", platformFeePct: "85", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true, targetMarginPct: "20" });
    expect(r.status).toBe("BLOCKED");
    expect(r.targetPrice).toBeNull();
    expect(r.unsupportedComponents.join(" ")).toContain("unreachable");
  });

  it("reports an unreachable breakeven when fees consume the whole price", () => {
    const r = calculateProfit({ currency: "USD", salesPrice: "20", landedCost: "12", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "3", platformFeePct: "100", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    expect(r.status).toBe("BLOCKED");
    expect(r.breakevenPrice).toBeNull();
    expect(r.unsupportedComponents.join(" ")).toContain("unreachable");
  });

  it("refuses the closed form when fee bases differ", () => {
    const r = calculateProfit({ currency: "USD", salesPrice: "20", landedCost: "12", adSpendPerUnit: "0",
      otherFixedFee: "0",
      fulfillmentFee: "3", platformFeePct: "10", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: false });
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toContain("same base");
  });
});
