/**
 * R1 rework regression tests (task OPENIMPORT_REWORK_20261018_R1).
 *
 * Each test maps to a ChatGPT independent-check failure (I06-I26) that this
 * round fixes. Asserts on the SHIPPED functions, never a reimplementation.
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import { calculateLandedCost } from "./cost.js";
import { LandedCostInputSchema } from "@open-import-os/contracts/calc";
import { calculateProfit, verifyTargetPrice } from "./profit.js";
import { resolveOrgScope, type AuthzContext, type Actor } from "@open-import-os/permissions";
import { displayMoney, toDecimal } from "@open-import-os/contracts/money";

// ---- fixtures --------------------------------------------------------------

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
  shipmentMode: "OCEAN" as const,
  incoterm: "FOB" as const,
  additionalDutyLayers: [],
  notApplicableFields: ["insurance", "portCharges", "warehousing", "inlandDeliveryCost", "otherLandedFees", "MPF", "HMF", "additionalDutyLayers"],
  // The golden sample states 2.00 as its complete tax figure -> explicit mode.
  taxScopeMode: "MANUAL_TOTAL_SCENARIO" as const,
  manualTotalConfirmation: { coverage: "base duty + all surcharges for this synthetic sample", level: "PER_UNIT" as const, confirmedBy: "golden-sample-spec" },
};

// Golden profit fixture: fees the sample confirms as zero are explicit "0";
// unknowns stay null and make the result INCOMPLETE (that is the point).
const PROFIT1 = {
  currency: "USD" as const,
  salesPrice: "19.90",
  landedCost: "12.00",
  fulfillmentFee: "5.00",
  adSpendPerUnit: "0",
  otherFixedFee: "0",
  platformFeePct: "0",
  paymentFeePct: "0",
  otherVariableFeePct: "0",
  ratioFeesSameBase: true,
};

/** Parse through the real schema so defaults (includedItems etc.) apply. */
const cost = (over: Record<string, unknown>) =>
  calculateLandedCost(LandedCostInputSchema.parse({ ...GOLDEN, ...over }) as never);

function actor(roles: string[], organizationId = "org-a"): Actor {
  return {
    kind: "USER",
    userId: "u1",
    organizationId,
    roles: roles as Actor["roles"],
    dataMode: "REAL",
    requestId: "t",
    scopes: [],
  };
}
function ctxFor(a: Actor, grants?: AuthzContext["grants"]): AuthzContext {
  return { actor: a, grants };
}

// ---- R1-P0-01 / R1-P0-02: tenant bypass and grant expiry -------------------

describe("R1-P0-01: body org id can never cross tenants", () => {
  it("OWNER targeting a foreign org is scoped back to own tenant (I17)", () => {
    const ctx = ctxFor(actor(["OWNER"], "org-a"));
    expect(resolveOrgScope(ctx, "org-b")).toBe("org-a");
  });
  it("ADMIN/MEMBER/VIEWER likewise scoped back", () => {
    for (const role of ["ADMIN", "MEMBER", "VIEWER"]) {
      const ctx = ctxFor(actor([role], "org-a"));
      expect(resolveOrgScope(ctx, "org-b")).toBe("org-a");
    }
  });
  it("platform admin with no grant is rejected, not silently allowed", () => {
    const ctx = ctxFor(actor(["PLATFORM_ADMIN"], "org-a"));
    expect(() => resolveOrgScope(ctx, "org-b")).toThrow(/audited grant/);
  });
  it("platform admin with a live grant may target the granted org", () => {
    const ctx = ctxFor(actor(["PLATFORM_ADMIN"], "org-a"), [
      { clientOrgId: "org-b", scopes: [], revokedAt: null, expiresAt: null },
    ]);
    expect(resolveOrgScope(ctx, "org-b")).toBe("org-b");
  });
});

describe("R1-P0-02: grant expiry and revocation take effect immediately", () => {
  it("expired platform-admin grant is rejected (I19)", () => {
    const ctx = ctxFor(actor(["PLATFORM_ADMIN"], "org-a"), [
      { clientOrgId: "org-b", scopes: [], revokedAt: null, expiresAt: new Date(Date.now() - 1000) },
    ]);
    expect(() => resolveOrgScope(ctx, "org-b")).toThrow(/expired/);
  });
  it("revoked grant is rejected even if not yet expired", () => {
    const ctx = ctxFor(actor(["PLATFORM_ADMIN"], "org-a"), [
      { clientOrgId: "org-b", scopes: [], revokedAt: new Date(Date.now() - 1000), expiresAt: null },
    ]);
    expect(() => resolveOrgScope(ctx, "org-b")).toThrow(/revoked/);
  });
});

// ---- R1-P1-02: entry-level fees (I23) --------------------------------------

describe("R1-P1-02: entry-level MPF/HMF are not multiplied by quantity", () => {
  it("30 USD entry fee over 1000 units gives batch 12030 / unit 12.03", () => {
    // Baseline is the golden 12.00 (which includes otherTaxes 2.00); adding a
    // 30 USD entry-level fee must add 0.03/unit, not 30/unit (I23).
    const r = cost({mpfEntryAmount: "30"});
    expect(r.batchLandedCost).toBe("12030.00");
    expect(Number(r.unitLandedCost)).toBeCloseTo(12.03, 6);
  });
  it("the split conserves the entry amount exactly (residue kept)", () => {
    const qty = 3;
    const base = cost({quantity: qty, mpfEntryAmount: null as unknown as string});
    const withFee = cost({quantity: qty, mpfEntryAmount: "10"});
    // The fee's batch contribution must be exactly 10: (withFee - base) batch.
    const delta = new Decimal(withFee.batchLandedCost!).minus(new Decimal(base.batchLandedCost!));
    expect(delta.equals(new Decimal("10"))).toBe(true);
  });
  it("supplying both per-unit and entry MPF is rejected, not double-counted", () => {
    const r = cost({otherTaxes: null,
      notApplicableFields: [...GOLDEN.notApplicableFields, "otherTaxes"],
      mpfAmount: "1",
      mpfEntryAmount: "30"});
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toMatch(/both/);
  });
  it("entry fee without quantity is incomplete, not silently dropped", () => {
    const { quantity: _q, ...noQty } = GOLDEN;
    const r = calculateLandedCost(
      LandedCostInputSchema.parse({
        ...noQty,
        otherTaxes: null,
        notApplicableFields: [...GOLDEN.notApplicableFields, "otherTaxes"],
        mpfEntryAmount: "30",
      }) as never,
    );
    expect(r.missingFields).toContain("quantity (required to split entry-level MPF/HMF)");
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
  });
});

// ---- R1-P1-03 / R1-P1-06: unknown vs zero, negatives ------------------------

describe("R1-P1-03: unknown is never zero", () => {
  it("blank insurance (not in notApplicable) keeps the cost incomplete (I21)", () => {
    const r = cost({insuranceCost: null,
      notApplicableFields: GOLDEN.notApplicableFields.filter((f) => f !== "insurance")});
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toContain("insuranceCost");
  });
  it("otherTaxes=0 does not confirm an unknown base duty rate (I07)", () => {
    const r = cost({otherTaxes: "0",
      taxScopeMode: "ITEMIZED",
      manualTotalConfirmation: null});
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
    expect(r.missingFields).toContain("dutyRatePct");
  });
  it("non-zero otherTaxes in ITEMIZED mode does not confirm the base duty either (S06/S07)", () => {
    for (const v of ["2.00", "2.80"]) {
      const r = cost({otherTaxes: v,
        taxScopeMode: "ITEMIZED",
        manualTotalConfirmation: null});
      expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
      expect(r.missingFields).toContain("dutyRatePct");
    }
  });
  it("a confirmed surcharge layer does not cover the unknown base duty in ITEMIZED mode (S07)", () => {
    const r = cost({
      otherTaxes: null,
      taxScopeMode: "ITEMIZED",
      manualTotalConfirmation: null,
      additionalDutyLayers: [{ code: "SURCHARGE", applicability: "CONFIRMED", ratePct: null, amount: "1.00" }],
    });
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
    expect(r.missingFields).toContain("dutyRatePct");
  });
  it("MANUAL_TOTAL_SCENARIO without confirmation stays incomplete (no auto-switch)", () => {
    const r = cost({otherTaxes: "2.00",
      taxScopeMode: "MANUAL_TOTAL_SCENARIO",
      manualTotalConfirmation: null});
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
    expect(r.assumptions.join(" ")).toMatch(/without a complete confirmation/);
  });
  it("MANUAL_TOTAL_SCENARIO + confirmed layer is rejected, not double-counted", () => {
    const r = cost({
      taxScopeMode: "MANUAL_TOTAL_SCENARIO",
      additionalDutyLayers: [{ code: "SURCHARGE", applicability: "CONFIRMED", ratePct: null, amount: "1.00" }],
    });
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toMatch(/MANUAL_TOTAL_SCENARIO/);
  });
  it("a CONFIRMED layer with no amount/rate blocks a complete conclusion (I08)", () => {
    const r = cost({
      additionalDutyLayers: [{ code: "SEC301", applicability: "CONFIRMED", ratePct: null, amount: null }],
    });
    expect(r.status).not.toBe("COMPLETE_WITHIN_SCOPE");
    expect(r.missingFields.join(" ")).toMatch(/SEC301/);
  });
  it("candidate layers still never join the confirmed total (A10 preserved)", () => {
    const base = cost({});
    const withCandidate = cost({
      additionalDutyLayers: [{ code: "C1", applicability: "CANDIDATE", ratePct: "10", amount: null }],
    });
    expect(withCandidate.unitLandedCost).toBe(base.unitLandedCost);
  });
});

describe("R1-P1-06: invalid inputs are blocked, not computed", () => {
  it("negative duty rate is rejected (I06)", () => {
    const r = cost({dutyRatePct: "-5"});
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toMatch(/dutyRatePct/);
  });
  it("negative landed cost is rejected, not a windfall (I15)", () => {
    const r = calculateProfit({ ...PROFIT1, landedCost: "-1" });
    expect(r.status).toBe("BLOCKED");
    expect(r.unsupportedComponents.join(" ")).toMatch(/landedCost/);
  });
  it("unknown ad spend keeps profit incomplete (I14)", () => {
    const r = calculateProfit({ ...PROFIT1, adSpendPerUnit: null });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toContain("adSpendPerUnit");
  });
  it("unknown fulfillment and ratio fees keep profit incomplete", () => {
    const r = calculateProfit({ ...PROFIT1, fulfillmentFee: null, platformFeePct: null });
    expect(r.status).toBe("INCOMPLETE");
    expect(r.missingFields).toContain("fulfillmentFee");
    expect(r.missingFields).toContain("platformFeePct");
  });
});

// ---- R1-P1-05: upward rounding (I13) ---------------------------------------

describe("R1-P1-05: breakeven rounds UP and never quotes a loss", () => {
  it("L=10 F=0 r=7% quotes 10.76, not 10.75 (I13)", () => {
    const r = calculateProfit({
      currency: "USD",
      salesPrice: "20",
      landedCost: "10",
      fulfillmentFee: "0",
      adSpendPerUnit: "0",
      otherFixedFee: "0",
      platformFeePct: "7",
      paymentFeePct: "0",
      otherVariableFeePct: "0",
      ratioFeesSameBase: true,
    });
    expect(r.breakevenPrice).toBe("10.76");
  });
  it("the quoted breakeven yields non-negative contribution", () => {
    const r = calculateProfit({
      currency: "USD",
      salesPrice: "20",
      landedCost: "10",
      fulfillmentFee: "0",
      adSpendPerUnit: "0",
      otherFixedFee: "0",
      platformFeePct: "7",
      paymentFeePct: "0",
      otherVariableFeePct: "0",
      ratioFeesSameBase: true,
    });
    const quote = new Decimal(r.breakevenPrice!);
    const profitAtQuote = quote.times(1 - 0.07).minus(10);
    expect(profitAtQuote.greaterThanOrEqualTo(0)).toBe(true);
  });
});

// ---- preserved golden cases (C) --------------------------------------------

describe("R1-C: golden samples unchanged", () => {
  it("sample 1: 12.00 / 2.90 / 14.57%", () => {
    const r = cost({});
    expect(r.unitLandedCost).toBe("12.00");
    const profit = calculateProfit(PROFIT1);
    expect(profit.contributionProfit).toBe("2.90");
    expect((Number(profit.contributionMargin) * 100).toFixed(2)).toBe("14.57");
  });
  it("sample 1 tax 2.80: 12.80 / 2.10 / 10.55%", () => {
    const r = cost({ otherTaxes: "2.80" });
    expect(r.unitLandedCost).toBe("12.80");
    const profit = calculateProfit({ ...PROFIT1, landedCost: "12.80" });
    expect(profit.contributionProfit).toBe("2.10");
    expect((Number(profit.contributionMargin) * 100).toFixed(2)).toBe("10.55");
  });
  it("sample 1 price 9.00: 13.00 / 1.90", () => {
    const r = cost({ unitPrice: "9.00" });
    expect(r.unitLandedCost).toBe("13.00");
    const profit = calculateProfit({ ...PROFIT1, landedCost: "13.00" });
    expect(profit.contributionProfit).toBe("1.90");
  });
  it("sample 2: breakeven 16.67 / target 21.43", () => {
    const r = calculateProfit({
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
    });
    expect(r.breakevenPrice).toBe("16.67");
    expect(r.targetPrice).toBe("21.43");
  });
});
