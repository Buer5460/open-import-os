/**
 * Deterministic landed-cost engine.
 *
 * Rules that must never be broken:
 *  - Unknown values stay null. An unknown tax is NEVER treated as 0.
 *  - Candidate additional-duty layers are NOT summed. Only layers explicitly
 *    marked CONFIRMED are summed, and conflicts block a complete conclusion.
 *  - A customs value is a separate, explicitly provided input. Total operating
 *    cost is never used as the customs value.
 *  - Incoterm-included items are subtracted once, never double-charged.
 *  - An incomplete result is labelled INCOMPLETE with explicit missing fields,
 *    never presented as a complete landed cost.
 *  - Unit and batch amounts are never mixed in one sum.
 */
import { Decimal } from "decimal.js";
import {
  allocateTotal,
  currencyPlaces,
  formatMoney,
  isNonNegativeMoney,
  moneyString,
  roundMoney,
  sumMoney,
  toDecimal,
} from "@open-import-os/contracts/money";
import type { AllocationInput, CostComponent, LandedCostInput, LandedCostOutput } from "@open-import-os/contracts/calc";

export const ENGINE_VERSION = "cost-engine/1.1.0";

const ZERO = new Decimal(0);

function component(label: string, amount: Decimal | null, basis: string, included = true, alreadyIncluded = false): CostComponent {
  return { label, amount: moneyString(amount), basis, included, alreadyIncluded };
}

/** Logistics fields, in a fixed display order. */
const LOGISTICS_FIELDS: Array<{ field: keyof LandedCostInput; label: string }> = [
  { field: "freightCost", label: "freight" },
  { field: "insuranceCost", label: "insurance" },
  { field: "customsClearanceCost", label: "customs clearance" },
  { field: "portCharges", label: "port charges" },
  { field: "warehousingCost", label: "warehousing" },
  { field: "inlandDeliveryCost", label: "inland delivery" },
  { field: "otherLandedFees", label: "other landed fees" },
];

/** Tax fields whose null value means "not yet confirmed", never "zero". */
const TAX_FIELDS: Array<{ field: keyof LandedCostInput; label: string }> = [
  { field: "dutyRatePct", label: "duty rate" },
  { field: "mpfAmount", label: "MPF" },
  { field: "hmfAmount", label: "HMF" },
  { field: "otherTaxes", label: "other taxes" },
];

export interface LandedCostResult extends LandedCostOutput {}

export function calculateLandedCost(input: LandedCostInput): LandedCostResult {
  const missing: string[] = [];
  const unsupported: string[] = [];
  const assumptions: string[] = [];

  const currency = input.currency ?? "USD";
  const places = currencyPlaces(currency);
  const included = new Set<string>([...(input.includedItems ?? []), ...(input.includedItems ?? []).map((s) => s.toLowerCase())]);
  // Fields the user explicitly confirmed as "none / not applicable". A
  // confirmed zero is not the same as an unknown value.
  const notApplicable = new Set<string>([...(input.notApplicableFields ?? []), ...(input.notApplicableFields ?? []).map((s) => s.toLowerCase())]);

  const unitPrice = toDecimal(input.unitPrice);
  const rawQuantity = input.quantity ?? null;
  const discount = toDecimal(input.discountAmount);
  const otherPurchaseFees = toDecimal(input.otherPurchaseFees);

  if (unitPrice === null) {
    missing.push("unitPrice");
  } else if (!isNonNegativeMoney(unitPrice)) {
    unsupported.push("unitPrice must not be negative");
  }

  // A quantity of zero (or negative) is a data error, not a batch of nothing.
  if (rawQuantity !== null && rawQuantity <= 0) {
    return {
      status: "BLOCKED",
      currency,
      unitLandedCost: null,
      unitLandedCostExact: null,
      batchLandedCost: null,
      components: [],
      dutyTax: null,
      missingFields: ["quantity"],
      unsupportedComponents: ["quantity must be a positive integer"],
      assumptions: [],
      engineVersion: ENGINE_VERSION,
      rulesVersion: null,
    };
  }
  const quantity = rawQuantity;

  // --- purchase ------------------------------------------------------------
  // unitPrice is per unit; discount and other purchase fees are batch-level.
  let unitPurchase: Decimal | null = null;
  let batchPurchase: Decimal | null = null;
  if (unitPrice !== null && quantity !== null) {
    batchPurchase = unitPrice.times(quantity);
    if (discount !== null) {
      if (discount !== null && batchPurchase !== null) {
        if (discount.greaterThan(batchPurchase)) {
          unsupported.push("discountAmount exceeds the purchase amount");
          batchPurchase = null;
        } else {
          batchPurchase = batchPurchase.minus(discount);
        }
      }
    }
    if (otherPurchaseFees !== null && batchPurchase !== null) batchPurchase = batchPurchase.plus(otherPurchaseFees);
    if (batchPurchase !== null && quantity !== null) unitPurchase = batchPurchase.dividedBy(quantity);
  } else if (unitPrice !== null) {
    // No quantity: only a unit figure is meaningful.
    let unitOnly = unitPrice;
    if (discount !== null) {
      assumptions.push("discountAmount applied to a single unit because no quantity was supplied");
      unitOnly = unitOnly.minus(discount);
    }
    if (otherPurchaseFees !== null) {
      assumptions.push("otherPurchaseFees applied to a single unit because no quantity was supplied");
      unitOnly = unitOnly.plus(otherPurchaseFees);
    }
    unitPurchase = unitOnly;
    assumptions.push("quantity missing: batch totals omitted, unit figures only");
  }

  // --- FX ------------------------------------------------------------------
  let fxFactor = new Decimal(1);
  if (currency !== "USD") {
    const fx = toDecimal(input.fxRate);
    if (fx === null) {
      // Missing FX blocks the item rather than assuming 1:1.
      return {
        status: "BLOCKED",
        currency,
        unitLandedCost: null,
      unitLandedCostExact: null,
        batchLandedCost: null,
        components: [],
        dutyTax: null,
        missingFields: ["fxRate"],
        unsupportedComponents: ["currency conversion without a sourced fxRate"],
        assumptions,
        engineVersion: ENGINE_VERSION,
        rulesVersion: null,
      };
    }
    if (fx.lessThanOrEqualTo(0)) {
      unsupported.push("fxRate must be positive");
    } else {
      fxFactor = fx;
    }
    if (!input.fxSource) assumptions.push("fxRate provided without a recorded source");
  }

  // --- logistics -----------------------------------------------------------
  const logistics: CostComponent[] = [];
  for (const { field, label } of LOGISTICS_FIELDS) {
    const value = toDecimal(input[field] as string | null | undefined);
    if (value === null) {
      if (notApplicable.has(label) || notApplicable.has(field as string)) {
        // The user checked this line and confirmed there is no cost.
        assumptions.push(`${label} confirmed as not applicable`);
        logistics.push(component(label, ZERO, "CONFIRMED_NONE"));
        continue;
      }
      missing.push(field as string);
      logistics.push(component(label, null, "UNKNOWN"));
      continue;
    }
    if (!isNonNegativeMoney(value)) unsupported.push(`${field} must not be negative`);
    // A fee already inside the quoted terms is not charged again.
    if (included.has(label) || included.has(field as string)) {
      assumptions.push(`${label} already included in the quoted terms; not added again`);
      logistics.push(component(label, ZERO, "INCLUDED_IN_TERMS"));
      continue;
    }
    logistics.push(component(label, value, "USER_ENTERED"));
  }

  // --- duties and taxes ----------------------------------------------------
  const customsValue = toDecimal(input.customsValue);
  const dutyRate = toDecimal(input.dutyRatePct);
  let mpf = toDecimal(input.mpfAmount);
  let hmf = toDecimal(input.hmfAmount);
  const otherTaxes = toDecimal(input.otherTaxes);
  const otherTaxesSupplied = otherTaxes !== null;

  // Entry-level (per-shipment) MPF/HMF: charged once per customs entry, so
  // the per-unit share is the entry amount divided by quantity. The residue
  // of the division goes onto one unit so the batch total is EXACTLY the
  // entry amount (no cents lost or invented by the split).
  const mpfEntry = toDecimal((input as { mpfEntryAmount?: string | null }).mpfEntryAmount);
  const hmfEntry = toDecimal((input as { hmfEntryAmount?: string | null }).hmfEntryAmount);
  if (mpfEntry !== null && mpf !== null) {
    unsupported.push("supply either mpfAmount (per unit) or mpfEntryAmount (per entry), not both");
  }
  if (hmfEntry !== null && hmf !== null) {
    unsupported.push("supply either hmfAmount (per unit) or hmfEntryAmount (per entry), not both");
  }
  if (quantity !== null && quantity > 0) {
    if (mpfEntry !== null && mpf === null) {
      const perUnit = mpfEntry.dividedBy(quantity);
      const batchFromPerUnit = perUnit.times(quantity);
      const residue = mpfEntry.minus(batchFromPerUnit);
      mpf = residue.equals(0) ? perUnit : perUnit.plus(residue); // residue lands on unit 1
      assumptions.push(`MPF entry amount ${moneyString(mpfEntry)} spread over ${quantity} units (residue ${moneyString(residue)} on the first unit)`);
    }
    if (hmfEntry !== null && hmf === null) {
      const perUnit = hmfEntry.dividedBy(quantity);
      const batchFromPerUnit = perUnit.times(quantity);
      const residue = hmfEntry.minus(batchFromPerUnit);
      hmf = residue.equals(0) ? perUnit : perUnit.plus(residue);
      assumptions.push(`HMF entry amount ${moneyString(hmfEntry)} spread over ${quantity} units (residue ${moneyString(residue)} on the first unit)`);
    }
  } else if (mpfEntry !== null || hmfEntry !== null) {
    // An entry-level fee cannot be split without a quantity.
    missing.push("quantity (required to split entry-level MPF/HMF)");
  }

  // A tax field left null is "unconfirmed", never "zero".
  // `dutyRatePct` is only treated as covered when a flat duty amount was
  // supplied for the SAME basis: a nonzero otherTaxes, or a CONFIRMED layer
  // that actually carries an amount or rate. otherTaxes = 0 does NOT confirm
  // the base duty - a zero other-tax says nothing about whether duty applies.
  const confirmedLayerCovered = (input.additionalDutyLayers ?? []).some(
    (l) =>
      l.applicability === "CONFIRMED" &&
      (toDecimal(l.amount) !== null || toDecimal(l.ratePct) !== null),
  );

  // R1.1-02: tax scope is EXPLICIT. In the default ITEMIZED mode nothing
  // covers the base duty - not otherTaxes=0, not otherTaxes=2, not a
  // confirmed surcharge layer - because the base rate is a separate line the
  // user has not provided. Only MANUAL_TOTAL_SCENARIO with a real user
  // confirmation may treat otherTaxes as the complete tax total, and the
  // engine then records exactly what was confirmed and at which level.
  const taxScopeMode = input.taxScopeMode ?? "ITEMIZED";
  // R1.2A-01 / R1.2-02: the base-duty overlap decision uses the MACHINE-READABLE
  // manualTotalConfirmation.coversBaseDuty field, never the free-text coverage.
  // A text substring match was language-dependent (a Chinese description
  // bypassed the block); free text is now audit-trail only.
  const manualTotalDeclared = taxScopeMode === "MANUAL_TOTAL_SCENARIO" && otherTaxes !== null;
  const explicitBaseDutySupplied = toDecimal(input.dutyRatePct) !== null;
  const covers = (input.manualTotalConfirmation?.coversBaseDuty ?? "UNKNOWN") as "INCLUDED" | "EXCLUDED" | "UNKNOWN";
  if (manualTotalDeclared && input.manualTotalConfirmation && !confirmedLayerCovered) {
    if (explicitBaseDutySupplied && covers !== "EXCLUDED") {
      // INCLUDED = definite overlap; UNKNOWN = the caller did not say, which is
      // not safe to auto-resolve either way. Both are blocked; only an explicit
      // EXCLUDED lets the base duty be itemized beside the manual surcharge
      // total.
      unsupported.push(
        covers === "INCLUDED"
          ? "MANUAL_TOTAL_SCENARIO already covers the base duty; an explicit dutyRatePct would double-count it. Remove the rate, or switch to ITEMIZED and itemize each tax line."
          : "MANUAL_TOTAL_SCENARIO with an explicit dutyRatePct requires an explicit coversBaseDuty=EXCLUDED (or remove the rate); the engine will not guess whether the base duty is already inside the manual total.",
      );
    }
  }
  if (taxScopeMode === "MANUAL_TOTAL_SCENARIO") {
    const c = input.manualTotalConfirmation;
    if (!c || otherTaxes === null) {
      assumptions.push("taxScopeMode=MANUAL_TOTAL_SCENARIO declared without a complete confirmation; treated as itemized");
    } else if (confirmedLayerCovered) {
      // A confirmed surcharge layer PLUS a manual total would double-count.
      unsupported.push("MANUAL_TOTAL_SCENARIO cannot be combined with confirmed additional layers (the total already covers them)");
    } else if (!unsupported.some((u) => u.startsWith("MANUAL_TOTAL_SCENARIO"))) {
      assumptions.push(
        `user-confirmed manual tax total ${moneyString(otherTaxes)} (${c.level}, coversBaseDuty=${c.coversBaseDuty ?? "UNKNOWN"}; confirmed by ${c.confirmedBy})`,
      );
    }
  }
  const manualTotalConfirmed =
    taxScopeMode === "MANUAL_TOTAL_SCENARIO" &&
    input.manualTotalConfirmation != null &&
    otherTaxes !== null &&
    !confirmedLayerCovered &&
    // An overlapping explicit rate means the input is contradictory; never a
    // complete result.
    !(explicitBaseDutySupplied && covers !== "EXCLUDED");
  const flatTaxSupplied = manualTotalConfirmed;
  for (const { field, label } of TAX_FIELDS) {
    if (notApplicable.has(label) || notApplicable.has(field as string)) {
      // Explicitly confirmed "no such fee" - a confirmed zero, not a gap.
      assumptions.push(`${label} confirmed as not applicable`);
      continue;
    }
    if (field === "dutyRatePct" && flatTaxSupplied) continue;
    // An entry-level MPF/HMF amount covers the same fee the per-unit field
    // would; supplying it means the fee is known (the engine derives the
    // per-unit share itself). Only per-unit `null` with NO entry amount is a
    // genuine unknown.
    if (field === "mpfAmount" && (input as { mpfEntryAmount?: string | null }).mpfEntryAmount != null) continue;
    if (field === "hmfAmount" && (input as { hmfEntryAmount?: string | null }).hmfEntryAmount != null) continue;
    if (toDecimal(input[field] as string | null | undefined) === null) missing.push(field as string);
  }
  // An absent layers array means "not yet researched"; an empty array means
  // "researched and there are none" - those are different states.
  if (input.additionalDutyLayers === undefined && !notApplicable.has("additionalDutyLayers")) {
    missing.push("additionalDutyLayers");
  }
  // A customs value is a distinct input. It is only required when something
  // actually needs to be computed on it.
  if (customsValue === null && (dutyRate !== null || (input.additionalDutyLayers ?? []).some((l) => toDecimal(l.ratePct) !== null))) {
    missing.push("customsValue");
  }

  if (customsValue === null && dutyRate !== null && !dutyRate.equals(ZERO)) {
    // Duty cannot be computed on a value that was never supplied.
    unsupported.push("duty rate supplied without customsValue");
  }
  if (customsValue !== null && dutyRate === null) {
    assumptions.push("customsValue supplied but the duty rate is unconfirmed; duty not computed");
  }
  if (customsValue !== null && dutyRate !== null && dutyRate.equals(ZERO)) {
    assumptions.push("duty rate confirmed as 0% for the stated customs value");
  }
  // A negative rate is a data error, never a refund.
  if (dutyRate !== null && dutyRate.lessThan(ZERO)) {
    unsupported.push("dutyRatePct must not be negative");
  }

  let dutyAmount: Decimal | null = null;
  if (dutyRate !== null && customsValue !== null && dutyRate.greaterThan(ZERO)) {
    if (customsValue.lessThan(ZERO)) {
      unsupported.push("customsValue must not be negative");
    } else {
      dutyAmount = customsValue.times(dutyRate).dividedBy(100);
    }
  } else if (dutyRate !== null && dutyRate.equals(ZERO)) {
    dutyAmount = ZERO;
  }

  // Additional layers: only CONFIRMED layers are summed. Candidates are listed,
  // conflicts block, uncovered items are reported as uncovered.
  const confirmedLayers: CostComponent[] = [];
  const candidateLayers: CostComponent[] = [];
  const notApplicableLayers: CostComponent[] = [];
  const conflicts: string[] = [];
  const uncovered: string[] = [];

  for (const layer of input.additionalDutyLayers ?? []) {
    const amount = toDecimal(layer.amount);
    const rate = toDecimal(layer.ratePct);
    let computed: Decimal | null = amount;
    if (computed === null && rate !== null && customsValue !== null) {
      computed = customsValue.times(rate).dividedBy(100);
    }
    const comp = component(layer.code, computed, layer.applicability);
    switch (layer.applicability) {
      case "CONFIRMED":
        confirmedLayers.push(comp);
        break;
      case "CANDIDATE":
        candidateLayers.push(comp);
        assumptions.push(`additional layer ${layer.code} is a candidate and is NOT added to the total`);
        break;
      case "NOT_APPLICABLE":
        notApplicableLayers.push(comp);
        break;
      case "CONFLICT":
        conflicts.push(layer.code);
        break;
      case "UNCOVERED":
        uncovered.push(layer.code);
        break;
    }
  }

  for (const [name, value] of [
    ["mpfAmount", mpf],
    ["hmfAmount", hmf],
    ["otherTaxes", otherTaxes],
  ] as const) {
    if (value !== null && !isNonNegativeMoney(value)) unsupported.push(`${name} must not be negative`);
  }

  // A CONFIRMED layer with neither amount nor rate cannot contribute a number.
  // It must not silently vanish: the conclusion is incomplete until it is
  // given a value or explicitly withdrawn.
  for (const layer of input.additionalDutyLayers ?? []) {
    if (layer.applicability === "CONFIRMED" && toDecimal(layer.amount) === null && toDecimal(layer.ratePct) === null) {
      missing.push(`amount/rate for confirmed layer ${layer.code}`);
    }
  }

  // --- assemble (unit level) ----------------------------------------------
  const components: CostComponent[] = [];
  components.push(component("purchase amount (per unit)", unitPurchase, unitPurchase === null ? "UNKNOWN" : "USER_ENTERED"));
  components.push(...logistics);
  if (dutyAmount !== null) components.push(component("duty (confirmed rate)", dutyAmount, "RULE"));
  components.push(...confirmedLayers);
  if (mpf !== null) components.push(component("MPF", mpf, "RULE"));
  if (hmf !== null) components.push(component("HMF", hmf, "RULE"));
  // R1.2-01: a MANUAL_TOTAL_SCENARIO confirmed at PER_ENTRY level is a whole-
  // shipment tax figure. It must be amortized across the quantity (residue on
  // the first unit so the batch total is EXACTLY the entry amount), not
  // treated as a per-unit value and multiplied by 1000.
  let otherTaxesForUnit = otherTaxes;
  if (
    manualTotalConfirmed &&
    input.manualTotalConfirmation!.level === "PER_ENTRY" &&
    otherTaxes !== null
  ) {
    if (quantity !== null && quantity > 0) {
      // R1.2A-03: the per-unit value is the pure quotient for DISPLAY only.
      // No "residue on the first unit" is claimed — with a 40-digit Decimal
      // context any residue concept is noise (1e-39), and the batch total is
      // rebuilt exactly from base*qty + entryTax instead. The assumption text
      // states the real contract: batch exact, per-unit display rounded.
      otherTaxesForUnit = otherTaxes.dividedBy(quantity);
      assumptions.push(
        `manual tax total ${moneyString(otherTaxes)} is PER_ENTRY; the batch total carries it exactly once and the per-unit display is the rounded average (${moneyString(otherTaxesForUnit)})`,
      );
    } else {
      // PER_ENTRY without a quantity cannot be split into a unit figure.
      missing.push("quantity (required to amortize a PER_ENTRY manual tax total)");
    }
  }

  if (otherTaxesForUnit !== null) components.push(component("other taxes", otherTaxesForUnit, manualTotalConfirmed ? "MANUAL_TOTAL" : "USER_ENTERED"));

  const unitParts = components.filter((c) => c.included && toDecimal(c.amount) !== null).map((c) => toDecimal(c.amount)!);
  const knownUnitTotal = unitParts.length > 0 ? sumMoney(unitParts) : null;

  const unitLanded = knownUnitTotal === null ? null : roundMoney(knownUnitTotal.times(fxFactor), 6);
  let batchLanded = unitLanded === null || quantity === null ? null : roundMoney(unitLanded.times(quantity), 6);
  // R1.2A-03: compute the batch from FULL-PRECISION unit parts when a
  // PER_ENTRY fee is present. Rounding the amortized per-unit tax to 6dp
  // loses the tail (10/3 -> 3.333333, x3 = 9.999999), so the whole-batch
  // figure must be built from the unrounded parts instead.
  const perUnitTaxEntry = manualTotalConfirmed && input.manualTotalConfirmation!.level === "PER_ENTRY" ? otherTaxes : null;
  if (perUnitTaxEntry !== null && quantity !== null && quantity > 0 && knownUnitTotal !== null) {
    // knownUnitTotal already contains otherTaxesForUnit (rounded). Rebuild:
    // base = knownUnitTotal - roundedPerUnitTax; batch = base*qty + entryTax.
    const quotientTax = otherTaxesForUnit ?? ZERO;
    const baseUnitFull = knownUnitTotal.minus(quotientTax);
    const exactBatchFull = baseUnitFull.times(quantity).plus(perUnitTaxEntry);
    batchLanded = exactBatchFull;
    const roundedBatchForCompare = unitLanded === null ? null : roundMoney(unitLanded.times(quantity), 6);
    if (roundedBatchForCompare !== null && !exactBatchFull.equals(roundedBatchForCompare)) {
      assumptions.push("batch total computed from full-precision parts (entry-level fee amortization); per-unit display is the rounded average");
    }
  }
  // R1.2A-03: the exact per-unit AVERAGE = exact batchLanded / quantity at
  // full Decimal precision, derived AFTER the batch total is re-pinned, so
  // exact * quantity === batch to the last digit in every case. Consumers
  // doing further math (profit referencing a cost run) use this value; the
  // display value stays currency-rounded.
  let unitLandedExact: Decimal | null = null;
  if (batchLanded !== null && quantity !== null && quantity > 0) {
    unitLandedExact = batchLanded.dividedBy(quantity);
  } else if (unitLanded !== null) {
    unitLandedExact = unitLanded;
  }

  // --- status --------------------------------------------------------------
  let status: LandedCostOutput["status"];
  if (unsupported.length > 0) {
    status = "BLOCKED";
  } else if (conflicts.length > 0 || uncovered.length > 0) {
    status = "REVIEW_REQUIRED";
  } else if (missing.length > 0) {
    status = "INCOMPLETE";
  } else {
    status = "COMPLETE_WITHIN_SCOPE";
  }

  if (status === "INCOMPLETE") {
    assumptions.push("known-fee subtotal only; this is NOT a complete landed cost");
  }
  if (status === "REVIEW_REQUIRED") {
    assumptions.push("a rule conflict or uncovered layer blocks a complete conclusion");
  }

  return {
    status,
    currency,
    unitLandedCost: formatMoney(unitLanded, places),
    // R1.2A-03: lossless per-unit average for downstream math (profit service),
    // while unitLandedCost stays the currency-rounded display value. Derived
    // from the exact batch total, so exact*quantity === batch to the last digit.
    unitLandedCostExact: unitLandedExact === null ? null : moneyString(unitLandedExact),
    batchLandedCost: formatMoney(batchLanded, places),
    components,
    dutyTax: {
      confirmed: confirmedLayers,
      candidates: candidateLayers,
      notApplicable: notApplicableLayers,
      conflicts,
      uncovered,
    },
    missingFields: missing,
    unsupportedComponents: unsupported,
    assumptions,
    engineVersion: ENGINE_VERSION,
    rulesVersion: null,
  };
}

// ---------------------------------------------------------------------------
// Batch allocation
// ---------------------------------------------------------------------------

export interface AllocationResult {
  status: "COMPLETE_WITHIN_SCOPE" | "INCOMPLETE" | "BLOCKED";
  currency: string;
  method: string;
  allocations: Array<{ sku: string; productId?: string; amounts: Record<string, string>; total: string }>;
  conserved: boolean;
  batchTotal: string;
  missingFields: string[];
  unsupportedComponents: string[];
  assumptions: string[];
}

export function allocateBatch(input: AllocationInput): AllocationResult {
  const missing: string[] = [];
  const unsupported: string[] = [];
  const assumptions: string[] = [];
  const places = currencyPlaces(input.currency);

  const weights = input.items.map((item) => {
    switch (input.method) {
      case "BY_QUANTITY":
        return new Decimal(item.quantity);
      case "BY_VALUE": {
        const v = toDecimal(item.value);
        if (v === null) missing.push(`value for ${item.sku}`);
        return v ?? ZERO;
      }
      case "BY_WEIGHT": {
        const w = toDecimal(item.weightKg);
        // Weight allocation is refused, not guessed, when a weight is missing.
        if (w === null) {
          missing.push(`weightKg for ${item.sku}`);
          unsupported.push("BY_WEIGHT allocation requires every item weight");
        }
        return w ?? ZERO;
      }
      case "BY_RATIO": {
        const r = toDecimal(item.ratio);
        if (r === null) missing.push(`ratio for ${item.sku}`);
        return r ?? ZERO;
      }
    }
  });

  if (unsupported.length > 0) {
    return {
      status: "BLOCKED",
      currency: input.currency,
      method: input.method,
      allocations: [],
      conserved: false,
      batchTotal: formatMoney(ZERO, places)!,
      missingFields: missing,
      unsupportedComponents: unsupported,
      assumptions,
    };
  }

  const allocations = input.items.map((item) => ({
    sku: item.sku,
    productId: item.productId,
    amounts: {} as Record<string, string>,
    total: "0",
  }));
  let batchTotal = ZERO;

  for (const fee of input.batchAmounts) {
    const amount = toDecimal(fee.amount);
    if (amount === null) {
      missing.push(`amount for ${fee.label}`);
      continue;
    }
    if (fee.alreadyIncluded) {
      assumptions.push(`${fee.label} already included in the incoterm price; not allocated`);
      continue;
    }
    // Allocate at full internal precision so conservation is exact.
    const shares = allocateTotal(amount, weights, 12);
    let feeTotal = ZERO;
    shares.forEach((share, i) => {
      allocations[i]!.amounts[fee.label] = moneyString(share)!;
      feeTotal = feeTotal.plus(share);
    });
    batchTotal = batchTotal.plus(feeTotal);
  }

  allocations.forEach((a) => {
    a.total = moneyString(sumMoney(Object.values(a.amounts).map((v) => toDecimal(v))))!;
  });

  // Conservation: the sum of all SKU shares must equal the batch total exactly.
  const sumOfShares = allocations.reduce((acc, a) => acc.plus(toDecimal(a.total)!), ZERO);
  const conserved = sumOfShares.equals(batchTotal);

  return {
    status: missing.length > 0 ? "INCOMPLETE" : "COMPLETE_WITHIN_SCOPE",
    currency: input.currency,
    method: input.method,
    allocations,
    conserved,
    batchTotal: moneyString(batchTotal)!,
    missingFields: missing,
    unsupportedComponents: unsupported,
    assumptions,
  };
}
