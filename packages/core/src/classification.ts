/**
 * Classification service.
 *
 * The gate that matters: full classification recommendation for a real
 * shipment is a CONTROLLED feature. Until the platform has a professional
 * partner and legal sign-off, this service only offers:
 *   - managing an already-confirmed code (with its evidence), and
 *   - clearly-labelled candidate RESEARCH.
 *
 * The gate lives here in the service layer, so the UI, REST and MCP all obey
 * it. Disabling a button in the UI cannot re-enable the capability.
 */
import { prisma } from "@open-import-os/db/client";
import { AppError } from "@open-import-os/contracts/errors";
import { ClassificationStatus } from "@prisma/client";
import { resolveOrgScope, requireScope, type AuthzContext } from "@open-import-os/permissions";
import type { AiMode } from "@prisma/client";

/** Whether the controlled "full recommendation" capability is open. */
export async function isFullClassificationEnabled(): Promise<boolean> {
  const flag = await prisma.featureFlag.findUnique({ where: { key: "REAL_CLASSIFICATION_RECOMMENDATION" } });
  return flag?.enabled === true;
}

export interface ClassificationResearchInput {
  productId: string;
  description: string;
  materialText?: string | null;
  /** Research mode. CANDIDATES is always available. */
  mode: "CANDIDATES";
  aiMode?: AiMode;
}

/**
 * Candidate research. Returns candidates with their basis, missing info and
 * source version. It NEVER returns a confirmed classification.
 */
export async function researchCandidates(
  ctx: AuthzContext,
  input: ClassificationResearchInput,
): Promise<{
  mode: AiMode;
  gated: boolean;
  candidates: Array<{
    rank: number;
    htsCode: string;
    description: string;
    matchScore: number;
    matchBasis: string;
    missingInfo: string[];
    sourceUrls: string[];
    datasetVersion: string;
  }>;
  disclaimer: string;
}> {
  requireScope(ctx, "products:read");
  const organizationId = resolveOrgScope(ctx);

  const product = await prisma.product.findFirst({ where: { id: input.productId, organizationId } });
  if (!product) throw new AppError("NOT_FOUND", "product not found");

  const aiMode: AiMode = input.aiMode ?? "RULE_BASED";

  // The active dataset version, if any. Without one we can still research
  // against nothing - but we must say so rather than invent results.
  const activeDataset = await prisma.datasetVersion.findFirst({
    where: { status: "ACTIVE" },
    orderBy: { activatedAt: "desc" },
  });

  const candidates: Array<{
    rank: number;
    htsCode: string;
    description: string;
    matchScore: number;
    matchBasis: string;
    missingInfo: string[];
    sourceUrls: string[];
    datasetVersion: string;
  }> = [];

  if (activeDataset && input.description) {
    // Token-match over the ACTIVE tariff lines. This is a research aid, not a
    // classification: every hit is a candidate with an explicit basis.
    const tokens = tokenize(`${input.description} ${input.materialText ?? ""}`);
    if (tokens.length > 0) {
      const lines = await prisma.tariffLine.findMany({
        where: { datasetVersionId: activeDataset.id },
        take: 5000,
      });
      const scored = lines
        .map((line: { description: string; htsCode: string }) => {
          const descTokens = tokenize(line.description);
          const overlap = tokens.filter((t) => descTokens.includes(t));
          return {
            line,
            overlap,
            score: overlap.length / Math.max(tokens.length, 1),
          };
        })
        .filter((s: { overlap: string[]; score: number }) => s.overlap.length > 0)
        .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
        .slice(0, 10);

      scored.forEach((s: { line: { htsCode: string; description: string }; overlap: string[]; score: number }, i: number) => {
        candidates.push({
          rank: i + 1,
          htsCode: s.line.htsCode,
          description: s.line.description,
          // A match score, explicitly NOT a calibrated probability.
          matchScore: Math.round(s.score * 1000) / 1000,
          matchBasis: `matched on ${s.overlap.slice(0, 5).join(", ")}`,
          missingInfo: missingClassificationInfo(input.description, input.materialText),
          sourceUrls: [activeDataset.ruleSourceId],
          datasetVersion: activeDataset.version,
        });
      });
    }
  }

  // Persist the research so the product page can show it.
  await prisma.classificationCandidate.deleteMany({ where: { productId: input.productId } });
  for (const c of candidates) {
    await prisma.classificationCandidate.create({
      data: {
        organizationId,
        productId: input.productId,
        rank: c.rank,
        htsCode: c.htsCode,
        description: c.description,
        matchScore: c.matchScore,
        matchBasis: c.matchBasis,
        missingInfo: c.missingInfo,
        sourceUrls: c.sourceUrls,
        datasetVersion: c.datasetVersion,
        aiMode,
      },
    });
  }

  return {
    mode: aiMode,
    gated: !(await isFullClassificationEnabled()),
    candidates,
    disclaimer:
      "These are research candidates generated by matching your description against the active tariff dataset. " +
      "They are NOT a classification. A customs value/duty determination for a real shipment requires a qualified " +
      "professional review.",
  };
}

/** Save an ALREADY-confirmed code with its evidence and who confirmed it. */
export async function saveConfirmedClassification(
  ctx: AuthzContext,
  input: {
    productId: string;
    htsCode: string;
    codeType?: string;
    confirmedBy: string;
    confirmedAt?: Date;
    evidenceText?: string | null;
    evidenceUrls?: string[];
    datasetVersion?: string | null;
  },
) {
  requireScope(ctx, "products:write");
  const organizationId = resolveOrgScope(ctx);
  const product = await prisma.product.findFirst({ where: { id: input.productId, organizationId } });
  if (!product) throw new AppError("NOT_FOUND", "product not found");

  const latest = await prisma.productVersion.findFirst({
    where: { productId: input.productId },
    orderBy: { versionNo: "desc" },
  });
  const versionNo = latest?.versionNo ?? 1;

  // Supersede any previous record so history is preserved, not overwritten.
  await prisma.classificationRecord.updateMany({
    where: { organizationId, productId: input.productId, status: ClassificationStatus.USER_CONFIRMED },
    data: { status: ClassificationStatus.SUPERSEDED },
  });

  const record = await prisma.classificationRecord.create({
    data: {
      organizationId,
      productId: input.productId,
      versionNo,
      htsCode: input.htsCode,
      codeType: input.codeType ?? "HTSUS",
      status: ClassificationStatus.USER_CONFIRMED,
      confirmedBy: input.confirmedBy,
      confirmedAt: input.confirmedAt ?? new Date(),
      evidenceText: input.evidenceText ?? null,
      evidenceUrls: input.evidenceUrls ?? [],
      datasetVersion: input.datasetVersion ?? null,
    },
  });

  await prisma.product.update({
    where: { id: input.productId },
    data: { status: "READY_FOR_REVIEW" },
  });

  return record;
}

/**
 * The controlled capability. Throws until the feature flag is on, which
 * requires a professional partner and legal review.
 */
export async function requestFullRecommendation(ctx: AuthzContext, productId: string) {
  requireScope(ctx, "products:read");
  const organizationId = resolveOrgScope(ctx);
  const product = await prisma.product.findFirst({ where: { id: productId, organizationId } });
  if (!product) throw new AppError("NOT_FOUND", "product not found");

  if (!(await isFullClassificationEnabled())) {
    throw new AppError(
      "PROFESSIONAL_SERVICE_GATED",
      "Full classification recommendation is a controlled feature. It requires a qualified professional partner " +
        "and legal review before it can be enabled. You can still manage a code you or your broker has already " +
        "confirmed, and run clearly-labelled candidate research.",
    );
  }
  throw new AppError("FEATURE_DISABLED", "partner workflow not configured yet");
}

/** Simple stop-word-filtering tokenizer for description matching. */
const STOP_WORDS = new Set(["the", "a", "an", "of", "for", "with", "and", "or", "in", "on", "to", "made", "from"]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** What a classification needs that the current profile does not have. */
export function missingClassificationInfo(description: string, materialText?: string | null): string[] {
  const missing: string[] = [];
  if (!materialText) missing.push("material / composition");
  if (description.length < 20) missing.push("detailed product description and use");
  missing.push("country of origin (does not change with the ship-from country)");
  missing.push("whether the goods are a set / kit");
  return missing;
}

export { ClassificationStatus };
