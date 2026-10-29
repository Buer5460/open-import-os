/**
 * Calculation service: runs the deterministic engines and persists an
 * IMMUTABLE CalculationRun.
 *
 * A saved run can always be replayed: the input snapshot, engine version and
 * rules version are stored with it. A new rule version never rewrites an old
 * snapshot; it produces a new run alongside it.
 */
import { Decimal } from "decimal.js";
import { prisma } from "@open-import-os/db/client";
import { AppError } from "@open-import-os/contracts/errors";
import { AiMode, CalculationStatus, DataSource } from "@prisma/client";
import { calculateLandedCost } from "./cost.js";
import { calculateProfit } from "./profit.js";
import { resolveOrgScope, requireScope, type AuthzContext } from "@open-import-os/permissions";
import type { LandedCostInput, ProfitInput, ProfitOutput } from "@open-import-os/contracts/calc";

export async function runLandedCostCalculation(
  ctx: AuthzContext,
  input: LandedCostInput & { productId?: string; shipmentId?: string },
) {
  requireScope(ctx, "calculations:write");
  const organizationId = resolveOrgScope(ctx);

  const result = calculateLandedCost(input);

  // A product must belong to this tenant before a run may be attached to it.
  if (input.productId) {
    const owned = await prisma.product.findFirst({ where: { id: input.productId, organizationId } });
    if (!owned) throw new AppError("NOT_FOUND", "product not found");
  }
  if (input.shipmentId) {
    const owned = await prisma.shipment.findFirst({ where: { id: input.shipmentId, organizationId } });
    if (!owned) throw new AppError("NOT_FOUND", "shipment not found");
  }

  const run = await prisma.calculationRun.create({
    data: {
      organizationId,
      productId: input.productId ?? null,
      shipmentId: input.shipmentId ?? null,
      kind: "LANDED_COST",
      status: mapStatus(result.status),
      engineVersion: result.engineVersion,
      rulesVersion: result.rulesVersion,
      inputSnapshot: input as never,
      resultJson: result as never,
      assumptions: result.assumptions as never,
      missingFields: result.missingFields,
      unsupportedComponents: result.unsupportedComponents,
      currency: input.currency ?? "USD",
      aiMode: AiMode.RULE_BASED,
      dataSource: ctx.actor.dataMode === "DEMO" ? DataSource.DEMO : DataSource.USER_ENTERED,
      createdById: ctx.actor.userId ?? "system",
    },
  });

  return { run, result };
}

/**
 * R2A-02: the shared, side-effect-free profit computation. Resolves the
 * referenced landed-cost run (tenant checks, currency check), inherits the
 * upstream verdict, and computes the profit — but NEVER writes. Both the
 * saving path (runProfitCalculation) and the replay path (replayCalculation)
 * go through this function, so a replay can no longer create a
 * CalculationRun as a side effect.
 */
async function computeProfitFromInput(
  organizationId: string,
  input: ProfitInput & { productId?: string; landedCostRunId?: string },
): Promise<{ result: ProfitOutput; rulesVersion: string | null; engineVersion: string | null; effectiveInput: ProfitInput }> {
  // Same tenant guard as the landed-cost path: a profit run must never attach
  // to a foreign product or consume a foreign run's output.
  if (input.productId) {
    const owned = await prisma.product.findFirst({ where: { id: input.productId, organizationId } });
    if (!owned) throw new AppError("NOT_FOUND", "product not found");
  }

  // When a prior landed-cost run is referenced, reuse its exact output so the
  // profit is computed on the same L the customer saw. A client-supplied
  // `landedCost` is deliberately IGNORED in this mode (R1.1-04): the stored
  // snapshot is authoritative, so nobody can hand-pick a friendlier number
  // while citing someone else's record.
  let landedCost: string | null = input.landedCost ?? null;
  let rulesVersion: string | null = null;
  let engineVersion: string | null = null;
  let inherited: { status: string; missingFields: string[]; unsupportedComponents: string[]; assumptions: string[]; currency: string | null } | null = null;
  if (input.landedCostRunId) {
    const prior = await prisma.calculationRun.findFirst({
      where: { id: input.landedCostRunId, organizationId, kind: "LANDED_COST" },
    });
    if (!prior) throw new AppError("NOT_FOUND", "landed cost run not found");
    const priorResult = prior.resultJson as {
      unitLandedCost: string | null; unitLandedCostExact?: string | null;
      rulesVersion: string | null; engineVersion: string;
      status: string; missingFields: string[]; unsupportedComponents: string[]; assumptions: string[];
    };
    // R1.2A-03: prefer the lossless per-unit average. A snapshot from before
    // R1.2A has no exact field (or a null one) and falls back to the rounded
    // display value — old snapshots keep working, new ones never lose the
    // tail cents of an entry-level fee amortization.
    landedCost =
      priorResult.unitLandedCostExact != null && priorResult.unitLandedCostExact !== ""
        ? priorResult.unitLandedCostExact
        : priorResult.unitLandedCost;
    rulesVersion = priorResult.rulesVersion;
    engineVersion = priorResult.engineVersion;
    // Currency must match: mixing a CNY cost into a USD profit silently
    // changes the meaning of every number.
    if (input.currency && input.currency !== prior.currency) {
      throw new AppError("VALIDATION_FAILED", `currency mismatch: the referenced run is ${prior.currency}`);
    }
    inherited = {
      status: priorResult.status,
      missingFields: priorResult.missingFields ?? [],
      unsupportedComponents: priorResult.unsupportedComponents ?? [],
      assumptions: priorResult.assumptions ?? [],
      currency: prior.currency,
    };
  }

  const effectiveInput: ProfitInput = { ...input, landedCost };
  const result = calculateProfit(effectiveInput);

  // R1.1-04: the profit inherits the upstream verdict. A BLOCKED cost cannot
  // yield a COMPLETE profit; INCOMPLETE stays incomplete; REVIEW_REQUIRED
  // keeps its review flag. The inherited gaps are merged into the output so
  // the client sees WHY, and they are persisted with the run.
  if (inherited) {
    if (inherited.status === "BLOCKED") {
      result.status = "BLOCKED";
      result.contributionProfit = null;
      result.contributionMargin = null;
      result.breakevenPrice = null;
      result.targetPrice = null;
      result.unsupportedComponents = [
        ...result.unsupportedComponents,
        `upstream landed-cost run is BLOCKED: ${inherited.unsupportedComponents.join("; ") || "see the referenced run"}`,
      ];
    } else if (result.status === "COMPLETE_WITHIN_SCOPE" && inherited.status !== "COMPLETE_WITHIN_SCOPE") {
      result.status = inherited.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "INCOMPLETE";
    }
    result.missingFields = [...new Set([...result.missingFields, ...inherited.missingFields])];
    result.assumptions = [...inherited.assumptions, ...result.assumptions];
  }

  return { result, rulesVersion, engineVersion, effectiveInput };
}

export async function runProfitCalculation(
  ctx: AuthzContext,
  input: ProfitInput & { productId?: string; landedCostRunId?: string },
) {
  requireScope(ctx, "calculations:write");
  const organizationId = resolveOrgScope(ctx);

  const { result, rulesVersion, engineVersion, effectiveInput } = await computeProfitFromInput(organizationId, input);

  const run = await prisma.calculationRun.create({
    data: {
      organizationId,
      productId: input.productId ?? null,
      kind: "PROFIT",
      status: mapStatus(result.status),
      engineVersion: engineVersion ?? result.engineVersion,
      rulesVersion,
      inputSnapshot: effectiveInput as never,
      resultJson: result as never,
      assumptions: result.assumptions as never,
      missingFields: result.missingFields,
      unsupportedComponents: result.unsupportedComponents,
      currency: input.currency ?? "USD",
      aiMode: AiMode.RULE_BASED,
      dataSource: ctx.actor.dataMode === "DEMO" ? DataSource.DEMO : DataSource.USER_ENTERED,
      createdById: ctx.actor.userId ?? "system",
    },
  });

  return { run, result };
}

export async function getCalculation(ctx: AuthzContext, id: string) {
  requireScope(ctx, "calculations:read");
  const organizationId = resolveOrgScope(ctx);
  const run = await prisma.calculationRun.findFirst({
    where: { id, organizationId },
    include: { scenario: true },
  });
  if (!run) throw new AppError("NOT_FOUND", "calculation not found");
  return run;
}

/**
 * Replay a stored run: recompute from its snapshot and confirm the result is
 * byte-identical. This is the acceptance test for "same input + version =>
 * same result" (A11).
 *
 * R1.2-03: a PROFIT run saved with a landedCostRunId inherited the upstream
 * cost's status/missing/assumptions at save time. Recomputing with
 * calculateProfit(snapshot) alone would drop that inheritance and could
 * report a different (even COMPLETE) verdict. The replay therefore re-runs
 * the SAME service path, resolving the referenced run again - never the bare
 * engine function.
 */
export async function replayCalculation(ctx: AuthzContext, id: string): Promise<{ identical: boolean; run: Awaited<ReturnType<typeof getCalculation>> }> {
  const run = await getCalculation(ctx, id);
  const snapshot = run.inputSnapshot as Record<string, unknown>;
  let recomputed: unknown;
  if (run.kind === "LANDED_COST") {
    recomputed = calculateLandedCost(snapshot as never);
  } else if (run.kind === "PROFIT") {
    // R2A-02: re-run through the SHARED side-effect-free path so upstream
    // inheritance (landedCostRunId resolution, currency check, status
    // propagation) is reproduced exactly as at save time — WITHOUT creating
    // a new CalculationRun. The organisation scope comes from the stored
    // run's own tenant.
    const priorLandedRunId = snapshot.landedCostRunId as string | undefined;
    if (priorLandedRunId) {
      const { result: replayed } = await computeProfitFromInput(run.organizationId, snapshot as never);
      recomputed = replayed;
    } else {
      recomputed = calculateProfit(snapshot as never);
    }
  } else {
    throw new AppError("NOT_FOUND", "unsupported calculation kind");
  }

  // Engine/contract version drift: an old snapshot recomputed under a newer
  // engine may legitimately differ. Never claim "identical" for a version
  // mismatch - say so instead of silently overwriting history.
  const resultEngine = (recomputed as { engineVersion?: string }).engineVersion ?? null;
  const storedEngine = (run.resultJson as { engineVersion?: string }).engineVersion ?? null;
  const versionMismatch = resultEngine !== null && storedEngine !== null && resultEngine !== storedEngine;

  // R1.2-03: compare SEMANTICS, not insertion order. The save path merges the
  // upstream assumptions into the result object after construction, which
  // changes key order but not meaning; a byte-wise JSON.stringify of the two
  // objects would report a false mismatch for identical data.
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, val]) => [k, stable(val)]),
      );
    }
    return v;
  };
  const identical =
    !versionMismatch &&
    JSON.stringify(stable(recomputed)) === JSON.stringify(stable(run.resultJson));
  return {
    identical,
    run: { ...run, replayVersionMismatch: versionMismatch } as never,
  };
}

function mapStatus(s: "COMPLETE_WITHIN_SCOPE" | "INCOMPLETE" | "REVIEW_REQUIRED" | "BLOCKED"): CalculationStatus {
  switch (s) {
    case "COMPLETE_WITHIN_SCOPE":
      return CalculationStatus.COMPLETE_WITHIN_SCOPE;
    case "INCOMPLETE":
      return CalculationStatus.INCOMPLETE;
    case "REVIEW_REQUIRED":
      return CalculationStatus.REVIEW_REQUIRED;
    case "BLOCKED":
      return CalculationStatus.BLOCKED;
  }
}

export { Decimal };
