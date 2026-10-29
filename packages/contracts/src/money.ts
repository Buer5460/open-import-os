/**
 * Money and decimal primitives.
 *
 * Every monetary amount is a Decimal. Public JSON exposes decimal *strings*
 * with an explicit currency, never JS numbers (which lose precision above 2^53
 * and cannot distinguish 0 from "unknown").
 */
import { Decimal } from "decimal.js";

// Deterministic, platform-independent rounding. ROUND_HALF_UP matches the
// convention customs brokers and accounting teams expect for display.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -18 });

export type MoneyLike = string | number | Decimal;

/** Currency codes we support out of the box. USD is the default for US import. */
export const SUPPORTED_CURRENCIES = ["USD", "CNY", "EUR", "GBP", "JPY", "VND", "THB", "SGD", "MYR", "IDR"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export function isCurrencyCode(v: unknown): v is CurrencyCode {
  return typeof v === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(v);
}

/** Parse user input into a Decimal. Returns null for empty/unknown. */
export function toDecimal(value: MoneyLike | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Decimal) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return new Decimal(value);
  }
  const s = value.trim();
  if (s === "") return null;
  // Reject anything that is not a plain decimal number (no hex, no NaN, no Infinity).
  if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;
  try {
    return new Decimal(s);
  } catch {
    return null;
  }
}

/**
 * Lossless decimal serialization.
 *
 * `toString()` keeps full internal precision, unlike `toFixed()`, which would
 * truncate repeating values (1/3) and break exact conservation checks. Use
 * this for any value that is later re-parsed and summed.
 */
export function moneyString(d: Decimal | null): string | null {
  if (d === null) return null;
  return d.toString();
}

/**
 * Canonical display serialization with a fixed number of decimal places.
 * Headline amounts use this so 3 and 3.00 are never confused and every client
 * formats identically.
 */
export function formatMoney(d: Decimal | null, places = 2): string | null {
  if (d === null) return null;
  return d.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

/** Decimal places for a currency's smallest unit. */
export function currencyPlaces(currency: string): number {
  return currency === "JPY" ? 0 : 2;
}

/** Display rounding to `places` digits, ROUND_HALF_UP. */
export function roundMoney(d: Decimal | null, places = 2): Decimal | null {
  if (d === null) return null;
  return d.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
}

/** Display string for a rounded money amount. */
export function displayMoney(d: Decimal | null, places = 2): string | null {
  const r = roundMoney(d, places);
  return r === null ? null : r.toFixed(places);
}

/** Rate string with a fixed number of places (for percentages / rates). */
export function displayRate(d: Decimal | null, places = 6): string | null {
  if (d === null) return null;
  return d.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

/** Percent value (0.1457) rendered as "14.57%". */
export function displayPercent(ratio: Decimal | null, places = 2): string | null {
  if (ratio === null) return null;
  const pct = ratio.times(100).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  return `${pct.toFixed(places)}%`;
}

/** Sum a list, treating nulls as "skip". Returns null when everything is null. */
export function sumMoney(values: Array<Decimal | null>): Decimal | null {
  let total: Decimal | null = null;
  for (const v of values) {
    if (v === null) continue;
    total = total === null ? v : total.plus(v);
  }
  return total;
}

/** Non-negative check for money inputs. */
export function isNonNegativeMoney(d: Decimal | null): boolean {
  return d !== null && d.greaterThanOrEqualTo(0);
}

/**
 * Break a total across parts so the parts sum EXACTLY to the total.
 *
 * `precision` is the decimal place count shares are rounded to (default 2 for
 * currency). The rounding residue is distributed deterministically to the
 * leading parts, so the result never depends on map iteration order.
 */
export function allocateTotal(
  total: Decimal,
  weights: Decimal[],
  precision = 2,
): Decimal[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a.plus(b), new Decimal(0));
  if (sum.lessThanOrEqualTo(0)) {
    throw new Error("ALLOCATION_WEIGHTS_NON_POSITIVE");
  }
  const quantum = new Decimal(10).pow(-precision);
  const exact = weights.map((w) => total.times(w).dividedBy(sum));
  const shares = exact.map((v) => v.toDecimalPlaces(precision, Decimal.ROUND_HALF_UP));
  let residue = total.minus(shares.reduce((a, b) => a.plus(b), new Decimal(0)));
  const out = shares.slice();
  let i = 0;
  const guard = out.length * (precision + 4) + 8;
  while (residue.abs().greaterThan(0) && i < guard) {
    const idx = i % out.length;
    const step = residue.greaterThan(0) ? quantum : quantum.negated();
    out[idx] = out[idx]!.plus(step);
    residue = residue.minus(step);
    i += 1;
  }
  // Any surviving residue folds into the last part, preserving the invariant.
  if (residue.abs().greaterThan(0)) {
    out[out.length - 1] = out[out.length - 1]!.plus(residue);
  }
  return out;
}
