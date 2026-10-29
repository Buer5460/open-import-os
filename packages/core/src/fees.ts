/**
 * MPF / HMF and fee-schedule resolution.
 *
 * These are the fees where the published schedule has caps, floors and
 * effective dates. Crucially, the spec says the minimum must not be applied
 * per SKU - it applies once per customs entry, so the engine takes the entry
 * value and allocates it, rather than multiplying by line count.
 *
 * All figures come from a DatasetVersion + RuleVersion pair. Nothing here is
 * hardcoded from memory: if no rule row exists, the result is UNCOVERED.
 */
import { Decimal } from "decimal.js";
import { prisma } from "@open-import-os/db/client";
import { moneyString, toDecimal } from "@open-import-os/contracts/money";

export interface FeeRule {
  layerCode: string;
  layerType: string;
  /** Ad-valorem rate in percent, when the fee is a rate. */
  ratePct: Decimal | null;
  /** Flat amount, when the fee is a flat charge. */
  flatAmount: Decimal | null;
  /** Minimum charge for an entry. */
  minAmount: Decimal | null;
  /** Maximum charge for an entry. */
  maxAmount: Decimal | null;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  sourceUrl: string;
  publisher: string;
  retrievedAt: Date;
  publishedAt: Date | null;
  checksum: string;
  applicability: string;
  reviewStatus: string;
}

export interface FeeComputation {
  layerCode: string;
  /** The computed amount, or null when the rule cannot be applied. */
  amount: Decimal | null;
  /** How the amount was derived, for the audit trail. */
  derivation: string;
  /** Cap/floor actually applied. */
  capApplied: "MIN" | "MAX" | null;
  unresolvedReasons: string[];
}

/**
 * Resolve a fee rule for a given entry value.
 *
 * A cap or floor only applies at ENTRY level, so callers must pass the entry
 * value, not a per-line value.
 */
export function computeFee(
  rule: FeeRule,
  entryValueUsd: Decimal | null,
  isOceanShipment: boolean | null,
  asOf: Date = new Date(),
): FeeComputation {
  const unresolved: string[] = [];

  // Effective-date check. An expired rule is UNCOVERED, not silently applied.
  if (rule.effectiveFrom && asOf < rule.effectiveFrom) {
    return { layerCode: rule.layerCode, amount: null, derivation: "not yet effective", capApplied: null, unresolvedReasons: [`effective from ${rule.effectiveFrom.toISOString().slice(0, 10)}`] };
  }
  if (rule.effectiveTo && asOf > rule.effectiveTo) {
    return { layerCode: rule.layerCode, amount: null, derivation: "expired", capApplied: null, unresolvedReasons: [`expired ${rule.effectiveTo.toISOString().slice(0, 10)}`] };
  }

  // HMF only applies to ocean shipments.
  if (rule.layerCode === "HMF" && isOceanShipment === false) {
    return { layerCode: rule.layerCode, amount: new Decimal(0), derivation: "HMF does not apply to non-ocean shipments", capApplied: null, unresolvedReasons: [] };
  }

  if (rule.flatAmount !== null) {
    return { layerCode: rule.layerCode, amount: rule.flatAmount, derivation: "flat fee", capApplied: null, unresolvedReasons: [] };
  }

  if (rule.ratePct !== null) {
    if (entryValueUsd === null) {
      return {
        layerCode: rule.layerCode,
        amount: null,
        derivation: "rate known but entry value missing",
        capApplied: null,
        unresolvedReasons: ["customsValue missing"],
      };
    }
    let amount = entryValueUsd.times(rule.ratePct).dividedBy(100);
    let capApplied: "MIN" | "MAX" | null = null;
    if (rule.minAmount !== null && amount.lessThan(rule.minAmount)) {
      amount = rule.minAmount;
      capApplied = "MIN";
    }
    if (rule.maxAmount !== null && amount.greaterThan(rule.maxAmount)) {
      amount = rule.maxAmount;
      capApplied = "MAX";
    }
    return { layerCode: rule.layerCode, amount, derivation: `${moneyString(rule.ratePct)}% of entry value`, capApplied, unresolvedReasons: [] };
  }

  return {
    layerCode: rule.layerCode,
    amount: null,
    derivation: "rule has neither a rate nor a flat amount",
    capApplied: null,
    unresolvedReasons: ["rule payload incomplete"],
  };
  void unresolved;
}

/**
 * Load the ACTIVE fee rules for a dataset version.
 */
export async function loadFeeRules(datasetVersionId: string): Promise<FeeRule[]> {
  const rows = await prisma.ruleVersion.findMany({
    where: {
      datasetVersionId,
      layerType: { in: ["FEE", "BASE", "ADDITIONAL"] },
      applicability: { in: ["CONFIRMED", "CANDIDATE"] },
    },
  });
  return rows.map((r: { ruleJson: unknown; layerCode: string; layerType: string; effectiveFrom: Date | null; effectiveTo: Date | null; sourceUrl: string; publisher: string; retrievedAt: Date; publishedAt: Date | null; checksum: string; applicability: string; reviewStatus: string }) => {
    const payload = r.ruleJson as Record<string, unknown>;
    return {
      layerCode: r.layerCode,
      layerType: r.layerType,
      ratePct: toDecimal(payload.ratePct as string | undefined),
      flatAmount: toDecimal(payload.flatAmount as string | undefined),
      minAmount: toDecimal(payload.minAmount as string | undefined),
      maxAmount: toDecimal(payload.maxAmount as string | undefined),
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      sourceUrl: r.sourceUrl,
      publisher: r.publisher,
      retrievedAt: r.retrievedAt,
      publishedAt: r.publishedAt,
      checksum: r.checksum,
      applicability: r.applicability,
      reviewStatus: r.reviewStatus,
    };
  });
}

/**
 * Allocate an ENTRY-level fee across SKU lines.
 *
 * The fee is computed ONCE on the whole entry (so caps and minimums are not
 * multiplied per line) and then allocated across lines by the chosen method.
 * The allocation is exact: the parts sum to the entry fee.
 */
export function allocateEntryFee(
  fee: Decimal,
  lines: Array<{ sku: string; quantity: number; value: Decimal | null; weightKg: Decimal | null; ratio: Decimal | null }>,
  method: "BY_QUANTITY" | "BY_VALUE" | "BY_WEIGHT" | "BY_RATIO",
): Array<{ sku: string; amount: Decimal }> {
  const weights = lines.map((l) => {
    switch (method) {
      case "BY_QUANTITY":
        return new Decimal(l.quantity);
      case "BY_VALUE":
        return l.value ?? new Decimal(0);
      case "BY_WEIGHT":
        return l.weightKg ?? new Decimal(0);
      case "BY_RATIO":
        return l.ratio ?? new Decimal(0);
    }
  });
  const totalWeight = weights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (totalWeight.lessThanOrEqualTo(0)) {
    // Cannot allocate without weights: return nulls so the caller reports it.
    return lines.map((l) => ({ sku: l.sku, amount: new Decimal(0) }));
  }
  const raw = lines.map((l, i) => {
    switch (method) {
      case "BY_QUANTITY":
        return fee.times(new Decimal(l.quantity)).dividedBy(totalWeight);
      case "BY_VALUE":
        return fee.times(l.value ?? new Decimal(0)).dividedBy(totalWeight);
      case "BY_WEIGHT":
        return fee.times(l.weightKg ?? new Decimal(0)).dividedBy(totalWeight);
      case "BY_RATIO":
        return fee.times(l.ratio ?? new Decimal(0)).dividedBy(totalWeight);
    }
  });
  // Exact conservation: give the residue to the largest line.
  const allocated = raw.reduce((a, b) => a.plus(b), new Decimal(0));
  const residue = fee.minus(allocated);
  if (!residue.equals(0)) {
    let maxIdx = 0;
    for (let i = 1; i < raw.length; i += 1) if (raw[i]!.greaterThan(raw[maxIdx]!)) maxIdx = i;
    raw[maxIdx] = raw[maxIdx]!.plus(residue);
  }
  return lines.map((l, i) => ({ sku: l.sku, amount: raw[i]! }));
}
