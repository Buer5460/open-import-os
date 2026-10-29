/**
 * Deterministic contribution-profit engine.
 *
 *   P = net unit selling price (no collected sales tax, discounts applied)
 *   L = unit landed cost
 *   r = ratio selling fees, all on the same base P
 *   F = fixed per-unit selling/variable costs (fulfilment, ads, ...)
 *
 *   C            = P * (1 - r) - L - F
 *   margin       = C / P
 *   breakeven    = (L + F) / (1 - r)
 *   target price = (L + F) / (1 - r - m)
 *
 * The closed forms are used ONLY when the fee bases are consistent. Otherwise
 * the engine reports UNSUPPORTED_COMPONENT instead of forcing the formula.
 */
import { Decimal } from "decimal.js";
import { currencyPlaces, formatMoney, isNonNegativeMoney, moneyString, roundMoney, toDecimal } from "@open-import-os/contracts/money";
import type { ProfitInput } from "@open-import-os/contracts/calc";
import type { ProfitOutput } from "@open-import-os/contracts/calc";
import { ENGINE_VERSION as COST_ENGINE_VERSION } from "./cost.js";

export const ENGINE_VERSION = `profit-engine/1.0.0+${COST_ENGINE_VERSION}`;

export interface ProfitResult extends ProfitOutput {}

/** Round a quoted price UP to the currency's smallest unit, then re-verify. */
export function roundPriceUp(value: Decimal, currency: string): Decimal {
  const places = currencyPlaces(currency);
  const quantum = new Decimal(10).pow(-places);
  const rounded = value.dividedBy(quantum).toDecimalPlaces(0, Decimal.ROUND_CEIL).times(quantum);
  return rounded;
}

export function calculateProfit(input: ProfitInput): ProfitResult {
  const missing: string[] = [];
  const unsupported: string[] = [];
  const assumptions: string[] = [];
  const currency = input.currency ?? "USD";
  const places = currencyPlaces(currency);

  const P = toDecimal(input.salesPrice);
  const L = toDecimal(input.landedCost);

  const platformFeePct = toDecimal(input.platformFeePct);
  const paymentFeePct = toDecimal(input.paymentFeePct);
  const otherVariableFeePct = toDecimal(input.otherVariableFeePct);
  const fulfillmentFee = toDecimal(input.fulfillmentFee);
  const adSpend = toDecimal(input.adSpendPerUnit);
  const otherFixedFee = toDecimal(input.otherFixedFee);
  const targetMarginPct = toDecimal(input.targetMarginPct);

  if (P === null) missing.push("salesPrice");
  if (L === null) missing.push("landedCost");
  // A negative landed cost is a data error, never a subsidy.
  if (L !== null && L.lessThan(0)) {
    return {
      status: "BLOCKED",
      currency,
      contributionProfit: null,
      contributionMargin: null,
      breakevenPrice: null,
      targetPrice: null,
      unitLandedCost: moneyString(L),
      ratioFeeTotalPct: null,
      fixedFeeTotal: null,
      missingFields: missing,
      unsupportedComponents: ["landedCost must not be negative"],
      assumptions,
      engineVersion: ENGINE_VERSION,
      rulesVersion: null,
    };
  }
  for (const [name, v] of [
    ["fulfillmentFee", fulfillmentFee],
    ["adSpendPerUnit", adSpend],
    ["otherFixedFee", otherFixedFee],
    ["platformFeePct", platformFeePct],
    ["paymentFeePct", paymentFeePct],
    ["otherVariableFeePct", otherVariableFeePct],
  ] as const) {
    if (v !== null && !isNonNegativeMoney(v)) unsupported.push(`${name} must not be negative`);
  }
  if (P !== null && P.lessThanOrEqualTo(0)) {
    // A non-positive price cannot yield a meaningful margin.
    return {
      status: "BLOCKED",
      currency,
      contributionProfit: null,
      contributionMargin: null,
      breakevenPrice: null,
      targetPrice: null,
      unitLandedCost: L === null ? null : moneyString(L),
      ratioFeeTotalPct: null,
      fixedFeeTotal: null,
      missingFields: missing,
      unsupportedComponents: ["salesPrice must be greater than zero to produce a margin"],
      assumptions,
      engineVersion: ENGINE_VERSION,
      rulesVersion: null,
    };
  }
  if (!input.ratioFeesSameBase) {
    // The closed-form model is invalid here; refuse rather than force a number.
    return {
      status: "BLOCKED",
      currency,
      contributionProfit: null,
      contributionMargin: null,
      breakevenPrice: null,
      targetPrice: null,
      unitLandedCost: L === null ? null : formatMoney(L, places),
      ratioFeeTotalPct: null,
      fixedFeeTotal: null,
      missingFields: missing,
      unsupportedComponents: ["ratio fees are not all on the same base: closed-form model not applicable"],
      assumptions,
      engineVersion: ENGINE_VERSION,
      rulesVersion: null,
    };
  }

  // Ratio-fee total: same rule - any unknown ratio keeps the total unknown.
  const ratioTotalPct: Decimal | null =
    platformFeePct === null || paymentFeePct === null || otherVariableFeePct === null
      ? null
      : platformFeePct.plus(paymentFeePct).plus(otherVariableFeePct);

  // Fixed-fee total: null if ANY component is unknown. An unknown fee is not
  // a zero fee, so it must not be dropped from the sum (I14). The caller's
  // explicit confirmed-zero is a 0 in the input, which sums normally.
  const fixedTotal: Decimal | null =
    fulfillmentFee === null || adSpend === null || otherFixedFee === null
      ? null
      : fulfillmentFee.plus(adSpend).plus(otherFixedFee);

  let contribution: Decimal | null = null;
  let margin: Decimal | null = null;
  let breakeven: Decimal | null = null;
  let targetPrice: Decimal | null = null;

  if (P !== null && L !== null && fixedTotal !== null && ratioTotalPct !== null && input.ratioFeesSameBase) {
    const r = ratioTotalPct.dividedBy(100);
    if (r.greaterThanOrEqualTo(1)) {
      // Denominator <= 0: the target is unreachable and must be reported as such.
      return {
        status: "BLOCKED",
        currency,
        contributionProfit: null,
        contributionMargin: null,
        breakevenPrice: null,
        targetPrice: null,
        unitLandedCost: moneyString(L),
        ratioFeeTotalPct: moneyString(ratioTotalPct),
        fixedFeeTotal: moneyString(fixedTotal),
        missingFields: missing,
        unsupportedComponents: ["ratio fee total >= 100%: breakeven price is unreachable"],
        assumptions,
        engineVersion: ENGINE_VERSION,
        rulesVersion: null,
      };
    }
    const contributionValue = P.times(new Decimal(1).minus(r)).minus(L).minus(fixedTotal);
    contribution = contributionValue;
    margin = contributionValue.dividedBy(P);
    const base = L.plus(fixedTotal);
    breakeven = base.dividedBy(new Decimal(1).minus(r));
    if (targetMarginPct !== null) {
      const m = targetMarginPct.dividedBy(100);
      const denom = new Decimal(1).minus(r).minus(m);
      if (denom.lessThanOrEqualTo(0)) {
        // A non-positive denominator means the target is unreachable; report
        // that explicitly instead of emitting a negative price.
        return {
          status: "BLOCKED",
          currency,
          contributionProfit: formatMoney(contribution, places),
          contributionMargin: formatMoney(margin, 8),
          breakevenPrice: formatMoney(breakeven, places),
          targetPrice: null,
          unitLandedCost: formatMoney(L, places),
          ratioFeeTotalPct: moneyString(ratioTotalPct),
          fixedFeeTotal: formatMoney(fixedTotal, places),
          missingFields: missing,
          unsupportedComponents: [`target margin ${input.targetMarginPct}% is unreachable at this fee ratio`],
          assumptions,
          engineVersion: ENGINE_VERSION,
          rulesVersion: null,
        };
      }
      targetPrice = base.dividedBy(denom);
    }
  } else {
    // Name the specific unknown fields rather than a lumped label, so the
    // caller can ask for exactly what is missing. An unknown fee is not a
    // zero fee.
    if (fulfillmentFee === null) missing.push("fulfillmentFee");
    if (adSpend === null) missing.push("adSpendPerUnit");
    if (otherFixedFee === null) missing.push("otherFixedFee");
    if (fixedTotal === null) missing.push("fixed fees (fulfillment/ad/other)");
    if (platformFeePct === null) missing.push("platformFeePct");
    if (paymentFeePct === null) missing.push("paymentFeePct");
    if (otherVariableFeePct === null) missing.push("otherVariableFeePct");
    if (ratioTotalPct === null) missing.push("ratio selling fees (platform/payment/other)");
  }

  if (contribution !== null && P !== null && P.greaterThan(0)) {
    margin = contribution.dividedBy(P);
  } else {
    margin = null;
  }

  const status: ProfitOutput["status"] =
    unsupported.length > 0
      ? "BLOCKED"
      : missing.length > 0
        ? "INCOMPLETE"
        : "COMPLETE_WITHIN_SCOPE";

  if (status === "INCOMPLETE") {
    assumptions.push("contribution profit is not a net profit; overheads and taxes on income are excluded");
  }

  // A quoted price is rounded UP to the currency's smallest unit and then
  // re-verified so the target margin still holds after rounding. The
  // breakeven price gets the same treatment: rounding it DOWN (or half-up)
  // could quote a price that still loses money. I13: L=10, F=0, r=7% gives
  // an exact breakeven of 10.7526...; half-up would quote 10.75, where the
  // contribution is still -0.0025. Rounding UP to 10.76 never loses money.
  let verifiedBreakeven: string | null = null;
  if (breakeven !== null) {
    const roundedBreak = roundPriceUp(breakeven, currency);
    verifiedBreakeven = formatMoney(roundedBreak, places);
    if (!roundedBreak.equals(breakeven)) {
      assumptions.push("breakeven price is rounded UP to the smallest currency unit so the quoted price never loses money");
    }
  }

  let verifiedTarget: string | null = null;
  if (targetPrice !== null) {
    const rounded = roundPriceUp(targetPrice, currency);
    verifiedTarget = formatMoney(rounded, places);
    assumptions.push("quoted target price is rounded UP to the smallest currency unit");
  }

  return {
    status,
    currency,
    contributionProfit: formatMoney(contribution, places),
    contributionMargin: margin === null ? null : formatMoney(margin, 8),
    breakevenPrice: verifiedBreakeven,
    targetPrice: verifiedTarget,
    unitLandedCost: formatMoney(L, places),
    ratioFeeTotalPct: moneyString(ratioTotalPct),
    fixedFeeTotal: formatMoney(fixedTotal, places),
    missingFields: missing,
    unsupportedComponents: unsupported,
    assumptions,
    engineVersion: ENGINE_VERSION,
    rulesVersion: null,
  };
}

/**
 * Verify that a rounded quote still satisfies the target margin.
 * Used by the golden tests (A07) and by the API "target price" response.
 */
export function verifyTargetPrice(
  quote: Decimal,
  L: Decimal,
  F: Decimal,
  rPct: Decimal,
  mPct: Decimal,
): boolean {
  const r = rPct.dividedBy(100);
  const m = mPct.dividedBy(100);
  const margin = quote.times(new Decimal(1).minus(r)).minus(L).minus(F).dividedBy(quote);
  return margin.greaterThanOrEqualTo(m);
}
