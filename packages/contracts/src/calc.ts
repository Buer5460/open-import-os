/**
 * Shared calculation input/output contracts.
 *
 * The deterministic engine (packages/core) validates against these schemas.
 * `null` means "unknown" - it is never coerced to 0.
 */
import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "./money.js";

export const CurrencySchema = z.enum(SUPPORTED_CURRENCIES);

// A monetary amount: decimal string with currency. Rejects NaN/Infinity/hex.
export const MoneySchema = z
  .string()
  .regex(/^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/, "must be a decimal string")
  .refine((v) => Number.isFinite(Number(v)), "must be finite");

export const MoneyWithCurrency = z.object({
  amount: MoneySchema,
  currency: CurrencySchema,
});

export const AllocationMethodSchema = z.enum(["BY_QUANTITY", "BY_VALUE", "BY_WEIGHT", "BY_RATIO"]);

export const ShipmentModeSchema = z.enum(["OCEAN", "AIR", "RAIL", "PARCEL", "UNKNOWN"]);
export const IncotermSchema = z.enum(["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP", "UNKNOWN"]);

/** Per-unit landed-cost inputs for a single SKU. */
export const LandedCostInputSchema = z.object({
  productId: z.string().optional(),
  sku: z.string().optional(),
  currency: CurrencySchema.default("USD"),
  // --- purchase ---
  unitPrice: MoneySchema.nullish(),
  quantity: z.coerce.number().int().positive().nullish(),
  discountAmount: MoneySchema.nullish(),
  otherPurchaseFees: MoneySchema.nullish(),
  fxRate: MoneySchema.nullish(),
  fxSource: z.string().nullish(),
  // --- logistics (per unit, already allocated, non-overlapping) ---
  freightCost: MoneySchema.nullish(),
  insuranceCost: MoneySchema.nullish(),
  customsClearanceCost: MoneySchema.nullish(),
  portCharges: MoneySchema.nullish(),
  warehousingCost: MoneySchema.nullish(),
  inlandDeliveryCost: MoneySchema.nullish(),
  otherLandedFees: MoneySchema.nullish(),
  // --- duties / taxes (each may be null = unknown) ---
  customsValue: MoneySchema.nullish(),
  dutyRatePct: MoneySchema.nullish(),
  additionalDutyLayers: z
    .array(
      z.object({
        code: z.string(),
        // Only layers explicitly confirmed applicable are summed by the engine.
        applicability: z.enum(["CONFIRMED", "CANDIDATE", "NOT_APPLICABLE", "CONFLICT", "UNCOVERED"]),
        ratePct: MoneySchema.nullish(),
        amount: MoneySchema.nullish(),
        note: z.string().nullish(),
      }),
    )
    .nullish(),
  mpfAmount: MoneySchema.nullish(),
  hmfAmount: MoneySchema.nullish(),
  otherTaxes: MoneySchema.nullish(),
  /**
   * ENTRY-LEVEL (per shipment) fee amounts. MPF/HMF are charged once per
   * customs entry, not per unit. When supplied here the engine divides by
   * quantity to obtain the per-unit share (with the residue on one unit so
   * the batch total is exact). Do NOT also fill `mpfAmount`/`hmfAmount` —
   * those are already-per-unit values, and supplying both double-counts.
   */
  mpfEntryAmount: MoneySchema.nullish(),
  hmfEntryAmount: MoneySchema.nullish(),
  /**
   * Tax-scope mode (R1.1-02): what `otherTaxes` MEANS.
   *
   *  - ITEMIZED (default): otherTaxes is one line item among others. It does
   *    NOT stand in for the base duty rate; an unknown dutyRatePct keeps the
   *    result incomplete no matter what otherTaxes contains (0, 2, anything).
   *  - MANUAL_TOTAL_SCENARIO: the user has EXPLICITLY confirmed that
   *    otherTaxes is the complete tax total for the shipment (covering base
   *    duty + surcharges). Only this mode may treat the base rate as covered,
   *    and the engine records the confirmation, the level and the assumption.
   *    The mode is never auto-switched by a non-zero number.
   */
  taxScopeMode: z.enum(["ITEMIZED", "MANUAL_TOTAL_SCENARIO"]).default("ITEMIZED"),
  /** Required context when taxScopeMode = MANUAL_TOTAL_SCENARIO. */
  manualTotalConfirmation: z
    .object({
      /** The user's own words of what the total covers (descriptive only —
       * the safe decision uses coversBaseDuty below, never this text). */
      coverage: z.string().min(3),
      /** The level the total applies to: per unit or per entry. */
      level: z.enum(["PER_UNIT", "PER_ENTRY"]),
      /** Who/where the confirmation came from. */
      confirmedBy: z.string().min(1),
      /**
       * R1.2A-01: machine-readable scope of the manual total. This is the
       * ONLY field the engine reasons about when deciding whether an explicit
       * dutyRatePct would double-count; `coverage` is free text for the audit
       * trail and is never parsed for meaning.
       *
       *  - INCLUDED: the total covers the base duty. An explicit dutyRatePct
       *    (or a confirmed duty-bearing layer) overlaps -> BLOCKED.
       *  - EXCLUDED: the total covers surcharges only; the base duty is
       *    itemized separately (dutyRatePct + customsValue are then required).
       *  - UNKNOWN: the caller did not say. The engine treats it conservatively
       *    (BLOCKED when an explicit rate is also present) instead of guessing.
       */
      coversBaseDuty: z.enum(["INCLUDED", "EXCLUDED", "UNKNOWN"]).default("UNKNOWN"),
    })
    .nullish(),
  // --- meta ---
  shipmentMode: ShipmentModeSchema.default("UNKNOWN"),
  incoterm: IncotermSchema.default("UNKNOWN"),
  includedItems: z.array(z.string()).default([]),
  /**
   * Fields the caller has explicitly confirmed as "not applicable / none".
   * This is deliberately distinct from `null` (unknown): a cost the user has
   * checked and found to be zero is a CONFIRMED zero, while `null` is an
   * unconfirmed gap. The distinction is what stops the engine from either
   * inventing a 0 or blocking forever on optional line items.
   */
  notApplicableFields: z.array(z.string()).default([]),
});
export type LandedCostInput = z.infer<typeof LandedCostInputSchema>;

/** Batch allocation: a shipment-level fee spread across SKUs. */
export const AllocationInputSchema = z.object({
  currency: CurrencySchema.default("USD"),
  shipmentId: z.string().optional(),
  method: AllocationMethodSchema,
  // Shipment-level amounts to allocate.
  batchAmounts: z.array(
    z.object({
      label: z.string(),
      amount: MoneySchema,
      // Whether this fee is already included in the incoterm price.
      alreadyIncluded: z.boolean().default(false),
    }),
  ),
  items: z
    .array(
      z.object({
        productId: z.string().optional(),
        sku: z.string(),
        quantity: z.coerce.number().int().positive(),
        value: MoneySchema.nullish(),
        weightKg: MoneySchema.nullish(),
        ratio: MoneySchema.nullish(),
      }),
    )
    .min(1),
});
export type AllocationInput = z.infer<typeof AllocationInputSchema>;

/** Contribution-profit inputs. */
export const ProfitInputSchema = z.object({
  productId: z.string().optional(),
  sku: z.string().optional(),
  currency: CurrencySchema.default("USD"),
  /**
   * Reference to a persisted LANDED_COST run (R1.1-04). When set, the server
   * reads that run's real output as L - a client-supplied `landedCost` is
   * ignored in favour of the stored snapshot - and the run's organization,
   * kind, currency and status are validated server-side. The schema keeps
   * the field so it is never silently dropped at parse time.
   */
  landedCostRunId: z.string().optional(),
  // P: net unit selling price, excluding collected sales tax, after discounts.
  salesPrice: MoneySchema.nullish(),
  // L: unit landed cost (from a prior calculation or direct input).
  landedCost: MoneySchema.nullish(),
  // r: ratio sales fees, all expressed on the same base P.
  platformFeePct: MoneySchema.nullish(),
  paymentFeePct: MoneySchema.nullish(),
  otherVariableFeePct: MoneySchema.nullish(),
  // F: fixed per-unit selling/variable costs.
  fulfillmentFee: MoneySchema.nullish(),
  adSpendPerUnit: MoneySchema.nullish(),
  otherFixedFee: MoneySchema.nullish(),
  // Whether all ratio fees share the same base (P). If false, the closed-form
  // model does not apply and the engine must refuse rather than force it.
  ratioFeesSameBase: z.boolean().default(true),
  // Optional target margin for the required-price calculation.
  targetMarginPct: MoneySchema.nullish(),
});
export type ProfitInput = z.infer<typeof ProfitInputSchema>;

/** A scenario is a full input snapshot, so old comparisons never change. */
export const ScenarioInputSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum([
    "BASE",
    "SUPPLIER",
    "SHIPPING_MODE",
    "PURCHASE_PRICE",
    "FREIGHT",
    "TAX_ASSUMPTION",
    "SALES_PRICE",
    "AD_SPEND",
    "CUSTOM",
  ]),
  landedCost: LandedCostInputSchema,
  profit: ProfitInputSchema,
});
export type ScenarioInput = z.infer<typeof ScenarioInputSchema>;

// ---------------------------------------------------------------------------
// Output contracts
// ---------------------------------------------------------------------------

export const CalculationStatusSchema = z.enum([
  "COMPLETE_WITHIN_SCOPE",
  "INCOMPLETE",
  "REVIEW_REQUIRED",
  "BLOCKED",
]);

export const CostComponentSchema = z.object({
  label: z.string(),
  amount: MoneySchema.nullable(),
  // Where this number came from: USER_ENTERED | RULE | ALLOCATED | UNKNOWN
  basis: z.string(),
  included: z.boolean(),
  // Whether this fee is already included in the incoterm price (to avoid double-charging).
  alreadyIncluded: z.boolean().default(false),
});

export type CostComponent = z.infer<typeof CostComponentSchema>;

export type CalculationStatusCode = z.infer<typeof CalculationStatusSchema>;

export const LandedCostOutputSchema = z.object({
  status: CalculationStatusSchema,
  currency: CurrencySchema,
  unitLandedCost: MoneySchema.nullable(),
  /**
   * R1.2A-03: lossless per-unit average (full Decimal precision, e.g.
   * "13.333333333333333333"). `unitLandedCost` stays the currency-rounded
   * display value; consumers that feed the unit cost into further math (the
   * profit service referencing a cost run) MUST use the exact value, so a
   * 3-unit batch with an entry-level fee never loses its tail cents.
   */
  unitLandedCostExact: z.string().nullable(),
  batchLandedCost: MoneySchema.nullable(),
  components: z.array(CostComponentSchema),
  dutyTax: z
    .object({
      confirmed: z.array(CostComponentSchema),
      candidates: z.array(CostComponentSchema),
      notApplicable: z.array(CostComponentSchema),
      conflicts: z.array(z.string()),
      uncovered: z.array(z.string()),
    })
    .nullable(),
  missingFields: z.array(z.string()),
  unsupportedComponents: z.array(z.string()),
  assumptions: z.array(z.string()),
  engineVersion: z.string(),
  rulesVersion: z.string().nullable(),
});

export type ProfitOutput = z.infer<typeof ProfitOutputSchema>;

export type LandedCostOutput = z.infer<typeof LandedCostOutputSchema>;

export const ProfitOutputSchema = z.object({
  status: CalculationStatusSchema,
  currency: CurrencySchema,
  contributionProfit: MoneySchema.nullable(),
  contributionMargin: MoneySchema.nullable(),
  breakevenPrice: MoneySchema.nullable(),
  targetPrice: MoneySchema.nullable(),
  unitLandedCost: MoneySchema.nullable(),
  ratioFeeTotalPct: MoneySchema.nullable(),
  fixedFeeTotal: MoneySchema.nullable(),
  missingFields: z.array(z.string()),
  unsupportedComponents: z.array(z.string()),
  assumptions: z.array(z.string()),
  engineVersion: z.string(),
  rulesVersion: z.string().nullable(),
});
