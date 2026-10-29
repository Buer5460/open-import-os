/**
 * R1.2 regression tests (OPENIMPORT_REWORK_20261018_R1_2).
 *
 * A-G acceptance criteria from the R1.2 instructions. Real engine, real
 * schema; persistence/replay tests use the isolated acc DB when available.
 */
import { describe, expect, it } from "vitest";
import { calculateLandedCost } from "./cost.js";
import { calculateProfit } from "./profit.js";
import { LandedCostInputSchema } from "@open-import-os/contracts/calc";

/** Synthetic base: all optional fees explicitly confirmed 0. */
const BASE = {
  currency: "USD",
  unitPrice: "8",
  quantity: 1000,
  freightCost: "1.20",
  customsClearanceCost: "0.80",
  insuranceCost: "0",
  portCharges: "0",
  warehousingCost: "0",
  inlandDeliveryCost: "0",
  otherLandedFees: "0",
  mpfAmount: "0",
  hmfAmount: "0",
  dutyRatePct: null,
  customsValue: null,
  shipmentMode: "OCEAN" as const,
  incoterm: "FOB" as const,
  additionalDutyLayers: [] as Array<{ code: string; applicability: "CONFIRMED" | "CANDIDATE" | "NOT_APPLICABLE" | "CONFLICT" | "UNCOVERED"; ratePct?: string | null; amount?: string | null; note?: string | null }>,
};

const parse = (over: Record<string, unknown>) =>
  LandedCostInputSchema.parse({ ...BASE, ...over }) as never;

const manual = (over: Record<string, unknown>) => ({
  taxScopeMode: "MANUAL_TOTAL_SCENARIO" as const,
  manualTotalConfirmation: {
    coverage: "base duty + all surcharges, synthetic case",
    level: "PER_UNIT" as const,
    confirmedBy: "synthetic-test",
  },
  ...over,
});

// ---- A: PER_ENTRY 200 / 1000 units -> 10200 batch / 10.20 unit --------------

describe("R1.2-A: PER_ENTRY manual total is amortized, not multiplied", () => {
  it("200 PER_ENTRY over 1000 units: batch 10200.00, unit 10.20, COMPLETE", () => {
    const r = calculateLandedCost(parse(manual({ otherTaxes: "200", manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_ENTRY", confirmedBy: "synthetic-test" } })));
    expect(r.batchLandedCost).toBe("10200.00");
    expect(Number(r.unitLandedCost)).toBeCloseTo(10.2, 6);
    expect(r.status).toBe("COMPLETE_WITHIN_SCOPE");
  });
  it("PER_ENTRY over 3 units with a non-dividing amount conserves the batch exactly", () => {
    const r = calculateLandedCost(parse(manual({ quantity: 3, otherTaxes: "10", manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_ENTRY", confirmedBy: "synthetic-test" } })));
    // base cost per unit = 10.00; batch base = 30; + entry tax 10 = 40 exact
    expect(r.batchLandedCost).toBe("40.00");
    // unit display is money-rounded (13.33); the conservation contract holds
    // on the batch total, which is what the customer is charged.
    expect(Number(r.unitLandedCost)).toBeCloseTo(13.33, 2);
  });
  it("PER_ENTRY with an awkward amount keeps every cent (residue on unit 1)", () => {
    // 100 units, 100.01 entry tax -> 1.0001/unit; batch must be exactly +100.01
    const base = calculateLandedCost(parse(manual({ quantity: 100, otherTaxes: "0", manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_ENTRY", confirmedBy: "synthetic-test" } })));
    const withTax = calculateLandedCost(parse(manual({ quantity: 100, otherTaxes: "100.01", manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_ENTRY", confirmedBy: "synthetic-test" } })));
    const delta = Number(withTax.batchLandedCost) - Number(base.batchLandedCost);
    expect(Math.abs(delta - 100.01)).toBeLessThan(0.000001);
  });
  it("PER_ENTRY without a quantity cannot produce a unit figure", () => {
    const { quantity: _q, ...noQty } = BASE;
    const r = calculateLandedCost(LandedCostInputSchema.parse({
      ...noQty,
      otherTaxes: "200",
      taxScopeMode: "MANUAL_TOTAL_SCENARIO",
      manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_ENTRY", confirmedBy: "synthetic-test" },
    }) as never);
    expect(r.missingFields).toContain("quantity (required to amortize a PER_ENTRY manual tax total)");
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
  });
});

// ---- B: PER_UNIT 2 -> 12000 batch / 12 unit ---------------------------------

describe("R1.2-B: PER_UNIT manual total", () => {
  it("2 PER_UNIT over 1000 units: batch 12000.00, unit 12.00, COMPLETE", () => {
    const r = calculateLandedCost(parse(manual({ otherTaxes: "2" })));
    expect(r.batchLandedCost).toBe("12000.00");
    expect(Number(r.unitLandedCost)).toBeCloseTo(12, 6);
    expect(r.status).toBe("COMPLETE_WITHIN_SCOPE");
  });
});

// ---- C: manual total + explicit dutyRate 25% -> BLOCKED, never 14-complete --

describe("R1.2-C: manual total covering base duty + explicit rate is blocked", () => {
  it("dutyRatePct=25 + INCLUDED manual total -> BLOCKED with explanation", () => {
    const r = calculateLandedCost(parse(manual({
      otherTaxes: "2",
      dutyRatePct: "25",
      customsValue: "8",
      manualTotalConfirmation: { coverage: "base duty + all surcharges, synthetic case", level: "PER_UNIT" as const, confirmedBy: "synthetic-test", coversBaseDuty: "INCLUDED" as const },
    })));
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toMatch(/double-count/);
    // The 14.00 figure must never be presented as a complete result.
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
  });
  it("dutyRatePct=25 + UNKNOWN coversBaseDuty -> BLOCKED (never guessed, R2A-01)", () => {
    // No coversBaseDuty at all: the schema defaults to UNKNOWN, which must be
    // blocked conservatively — including when the free text is Chinese.
    for (const coverage of ["含基础关税+301条款", "base duty + all surcharges", "覆盖说明-未选择"]) {
      const r = calculateLandedCost(parse(manual({
        otherTaxes: "2",
        dutyRatePct: "25",
        customsValue: "8",
        manualTotalConfirmation: { coverage, level: "PER_UNIT" as const, confirmedBy: "synthetic-test" },
      })));
      expect(r.status, `coverage=${coverage}`).toBe("BLOCKED");
      expect(r.unsupportedComponents.join(" ")).toMatch(/coversBaseDuty/);
    }
  });
  it("dutyRatePct=25 + EXCLUDED (surcharges only, Chinese text) -> itemized base + manual surcharge, no double count", () => {
    const r = calculateLandedCost(parse(manual({
      otherTaxes: "2",
      dutyRatePct: "25",
      customsValue: "8",
      manualTotalConfirmation: { coverage: "仅含301附加税，基础关税单独逐项", level: "PER_UNIT" as const, confirmedBy: "synthetic-test", coversBaseDuty: "EXCLUDED" as const },
    })));
    expect(r.status).toBe("COMPLETE_WITHIN_SCOPE");
    // 8 + 1.2 + 0.8 + duty(25% of 8 = 2) + surcharge 2 = 14, each auditable
    expect(Number(r.unitLandedCost)).toBeCloseTo(14, 6);
    const duty = r.components.find((c) => c.label.startsWith("duty"));
    const surcharge = r.components.find((c) => c.label === "other taxes");
    expect(duty?.amount).toBe("2");
    expect(surcharge?.amount).toBe("2");
  });
  it("same rate/value in ITEMIZED mode with otherTaxes confirmed 0 computes duty normally (no regression)", () => {
    const r = calculateLandedCost(parse({
      otherTaxes: "0",
      dutyRatePct: "25",
      customsValue: "8",
      taxScopeMode: "ITEMIZED",
    }));
    expect(r.status).toBe("COMPLETE_WITHIN_SCOPE");
    // 8 + 1.2 + 0.8 + duty(25% of 8 = 2) = 12
    expect(Number(r.unitLandedCost)).toBeCloseTo(12, 6);
  });
});

// ---- D: ITEMIZED non-zero otherTaxes, unknown base duty -> INCOMPLETE -------

describe("R1.2-D: ITEMIZED never covers the base duty", () => {
  it("otherTaxes=2 with unknown dutyRatePct -> INCOMPLETE (dutyRatePct missing)", () => {
    const r = calculateLandedCost(parse({ otherTaxes: "2", taxScopeMode: "ITEMIZED" }));
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toContain("dutyRatePct");
  });
  it("otherTaxes=0 with unknown dutyRatePct -> INCOMPLETE", () => {
    const r = calculateLandedCost(parse({ otherTaxes: "0", taxScopeMode: "ITEMIZED" }));
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toContain("dutyRatePct");
  });
});

// ---- E: manual total + CONFIRMED layer -> BLOCKED ---------------------------

describe("R1.2-E: manual total + confirmed surcharge layer", () => {
  it("overlap is BLOCKED, never silently summed", () => {
    const r = calculateLandedCost(parse(manual({
      otherTaxes: "2",
      additionalDutyLayers: [{ code: "SURCHARGE", applicability: "CONFIRMED", ratePct: null, amount: "1.00" }],
    })));
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toMatch(/MANUAL_TOTAL_SCENARIO/);
  });
});

// ---- F: preserved golden cases ---------------------------------------------

describe("R1.2-F: golden samples unchanged", () => {
  const GOLDEN_MANUAL = manual({
    otherTaxes: "2.00",
    manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT", confirmedBy: "golden-sample-spec" },
  });
  it("12.00 / 2.90 / 14.57%", () => {
    const cost = calculateLandedCost(parse(GOLDEN_MANUAL));
    expect(cost.unitLandedCost).toBe("12.00");
    expect(cost.status).toBe("COMPLETE_WITHIN_SCOPE");
    const profit = calculateProfit({
      currency: "USD", salesPrice: "19.90", landedCost: "12.00",
      fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0",
      platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0",
      ratioFeesSameBase: true,
    });
    expect(profit.contributionProfit).toBe("2.90");
    expect((Number(profit.contributionMargin) * 100).toFixed(2)).toBe("14.57");
  });
  it("tax 2.80 -> 12.80 / 2.10 / 10.55%", () => {
    const cost = calculateLandedCost(parse({ ...GOLDEN_MANUAL, otherTaxes: "2.80" }));
    expect(cost.unitLandedCost).toBe("12.80");
    const profit = calculateProfit({ currency: "USD", salesPrice: "19.90", landedCost: "12.80", fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    expect(profit.contributionProfit).toBe("2.10");
    expect((Number(profit.contributionMargin) * 100).toFixed(2)).toBe("10.55");
  });
  it("price 9.00 -> 13.00 / 1.90", () => {
    const cost = calculateLandedCost(parse({ ...GOLDEN_MANUAL, unitPrice: "9.00" }));
    expect(cost.unitLandedCost).toBe("13.00");
    const profit = calculateProfit({ currency: "USD", salesPrice: "19.90", landedCost: "13.00", fulfillmentFee: "5.00", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "0", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    expect(profit.contributionProfit).toBe("1.90");
  });
  it("breakeven 16.67 / target 21.43", () => {
    const r = calculateProfit({ currency: "USD", salesPrice: "20", landedCost: "12", fulfillmentFee: "3", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "10", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true, targetMarginPct: "20" });
    expect(r.breakevenPrice).toBe("16.67");
    expect(r.targetPrice).toBe("21.43");
  });
  it("MPF entry fee 30 over 1000 units adds exactly 30 to the batch", () => {
    // An entry-level fee conflicts with a per-unit mpfAmount (even a confirmed
    // 0), so this scenario supplies NO mpfAmount at all - as the form does
    // when the user enters an entry-level MPF.
    const { mpfAmount: _m, hmfAmount: _h, ...noMpf } = BASE;
    const gm = {
      ...noMpf,
      ...manual({ otherTaxes: "2.00" }),
    };
    const raw = (o: Record<string, unknown>) => LandedCostInputSchema.parse(o) as never;
    const base = calculateLandedCost(raw(gm));
    const withFee = calculateLandedCost(raw({ ...gm, mpfEntryAmount: "30" }));
    // The MPF delta is exactly 30 regardless of the surrounding completeness
    // (without a per-unit mpfAmount the scenario is INCOMPLETE by design; the
    // entry-fee handling itself is what this test pins down).
    expect(Number(withFee.batchLandedCost) - Number(base.batchLandedCost)).toBe(30);
    expect(withFee.unsupportedComponents).toHaveLength(0);
  });
  it("breakeven rounds UP: L=10 r=7% -> 10.76", () => {
    const r = calculateProfit({ currency: "USD", salesPrice: "20", landedCost: "10", fulfillmentFee: "0", adSpendPerUnit: "0", otherFixedFee: "0", platformFeePct: "7", paymentFeePct: "0", otherVariableFeePct: "0", ratioFeesSameBase: true });
    expect(r.breakevenPrice).toBe("10.76");
  });
});
