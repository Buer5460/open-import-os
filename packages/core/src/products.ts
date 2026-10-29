/**
 * Product service: the ProductImportProfile is the single business centre.
 *
 * Every mutation writes a new ProductVersion, so an old classification or an
 * old calculation is always traceable to the profile state it was computed on.
 */
import { Decimal } from "decimal.js";
import { prisma } from "@open-import-os/db/client";
import { AppError } from "@open-import-os/contracts/errors";
import { DataSource, ProductStatus } from "@prisma/client";
import type { AuthzContext } from "@open-import-os/permissions";
import { resolveOrgScope, requireScope } from "@open-import-os/permissions";

export interface CreateProductInput {
  organizationId?: string;
  sku: string;
  nameZh: string;
  nameEn: string;
  descriptionZh?: string | null;
  descriptionEn?: string | null;
  materialText?: string | null;
  materialRatio?: unknown;
  imageUrl?: string | null;
  brand?: string | null;
  unitOfMeasure?: string;
  status?: ProductStatus;
  changeReason?: string;
  profile?: Record<string, unknown>;
}

export async function createProduct(ctx: AuthzContext, input: CreateProductInput) {
  requireScope(ctx, "products:write");
  const organizationId = resolveOrgScope(ctx, input.organizationId);

  const existing = await prisma.product.findUnique({
    where: { organizationId_sku: { organizationId, sku: input.sku } },
  });
  if (existing) {
    throw new AppError("DUPLICATE", `SKU ${input.sku} already exists in this organization`);
  }

  const product = await prisma.product.create({
    data: {
      organizationId,
      sku: input.sku,
      nameZh: input.nameZh,
      nameEn: input.nameEn,
      descriptionZh: input.descriptionZh ?? null,
      descriptionEn: input.descriptionEn ?? null,
      materialText: input.materialText ?? null,
      materialRatio: (input.materialRatio ?? undefined) as never,
      imageUrl: input.imageUrl ?? null,
      brand: input.brand ?? null,
      unitOfMeasure: input.unitOfMeasure ?? "PCS",
      status: input.status ?? ProductStatus.DRAFT,
      dataSource: ctx.actor.dataMode === "DEMO" ? DataSource.DEMO : DataSource.USER_ENTERED,
      createdById: ctx.actor.userId ?? "system",
    },
  });

  await createVersion(product.id, organizationId, 1, input.profile ?? {}, input.changeReason ?? "created", ctx);
  return product;
}

/**
 * Update a product. Always creates a new version; never silently overwrites.
 */
export async function updateProduct(
  ctx: AuthzContext,
  productId: string,
  patch: Partial<CreateProductInput> & { changeReason?: string },
) {
  requireScope(ctx, "products:write");
  const product = await getProductOrThrow(ctx, productId);

  const data: Record<string, unknown> = {};
  for (const key of ["nameZh", "nameEn", "descriptionZh", "descriptionEn", "materialText", "imageUrl", "brand", "unitOfMeasure", "status"] as const) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }
  if (patch.materialRatio !== undefined) data.materialRatio = patch.materialRatio as never;

  const updated = await prisma.product.update({ where: { id: product.id }, data });

  const last = await prisma.productVersion.findFirst({
    where: { productId: product.id },
    orderBy: { versionNo: "desc" },
  });
  const nextNo = (last?.versionNo ?? 0) + 1;
  await createVersion(product.id, product.organizationId, nextNo, { ...(last?.snapshot as object), ...(patch.profile ?? {}) }, patch.changeReason ?? "updated", ctx);

  // A material change invalidates a previous REVIEWED state.
  if (patch.changeReason && product.status === ProductStatus.REVIEWED) {
    await prisma.product.update({
      where: { id: product.id },
      data: { status: ProductStatus.RECHECK_REQUIRED },
    });
  }
  return updated;
}

async function createVersion(
  productId: string,
  organizationId: string,
  versionNo: number,
  snapshot: unknown,
  changeReason: string,
  ctx: AuthzContext,
) {
  return prisma.productVersion.create({
    data: {
      productId,
      organizationId,
      versionNo,
      snapshot: snapshot as never,
      changeReason,
      createdById: ctx.actor.userId ?? "system",
    },
  });
}

/** Tenant-scoped read. Cross-tenant ids return 404, never 403-with-content. */
export async function getProductOrThrow(ctx: AuthzContext, productId: string) {
  requireScope(ctx, "products:read");
  const organizationId = resolveOrgScope(ctx);
  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId },
    include: {
      versions: { orderBy: { versionNo: "desc" }, take: 20 },
      records: { orderBy: { confirmedAt: "desc" }, take: 10 },
      candidates: { orderBy: { rank: "asc" }, take: 20 },
    },
  });
  if (!product) throw new AppError("NOT_FOUND", "product not found");
  return product;
}

export async function listProducts(
  ctx: AuthzContext,
  opts: { q?: string; status?: ProductStatus; limit?: number; offset?: number; dataMode?: "DEMO" | "REAL" } = {},
) {
  requireScope(ctx, "products:read");
  const organizationId = resolveOrgScope(ctx);
  const where: Record<string, unknown> = { organizationId, archivedAt: null };
  if (opts.q) {
    where.OR = [
      { sku: { contains: opts.q, mode: "insensitive" } },
      { nameZh: { contains: opts.q, mode: "insensitive" } },
      { nameEn: { contains: opts.q, mode: "insensitive" } },
    ];
  }
  if (opts.status) where.status = opts.status;
  if (opts.dataMode) where.dataSource = opts.dataMode === "DEMO" ? DataSource.DEMO : { not: DataSource.DEMO };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
      skip: opts.offset ?? 0,
      include: { _count: { select: { versions: true } } },
    }),
    prisma.product.count({ where }),
  ]);
  return { items, total };
}

/**
 * Data-completeness of a profile. The four dimensions the spec requires to be
 * shown separately (never merged into one green "all compliant" badge).
 */
export function assessCompleteness(profile: {
  materialText?: string | null;
  htsCode?: string | null;
  classificationConfirmed?: boolean;
  unitPrice?: string | null;
  salesPrice?: string | null;
  rulesCurrent?: boolean;
}): {
  dataCompleteness: number;
  classification: "NONE" | "CANDIDATE_RESEARCH" | "USER_CONFIRMED" | "NEEDS_REVIEW" | "SUPERSEDED";
  ruleCurrency: "CURRENT" | "EXPIRED" | "UNKNOWN";
  calculationReadiness: "READY" | "MISSING_COST_INPUTS" | "MISSING_SALES_INPUTS" | "MISSING_BOTH";
} {
  const fields = ["materialText", "unitPrice", "salesPrice"] as const;
  const filled = fields.filter((f) => profile[f] !== null && profile[f] !== undefined && profile[f] !== "").length;
  const dataCompleteness = Math.round((filled / fields.length) * 100);

  let classification: "NONE" | "CANDIDATE_RESEARCH" | "USER_CONFIRMED" | "NEEDS_REVIEW" | "SUPERSEDED" = "NONE";
  if (profile.htsCode && profile.classificationConfirmed) classification = "USER_CONFIRMED";
  else if (profile.htsCode) classification = "CANDIDATE_RESEARCH";
  else if (profile.classificationConfirmed) classification = "SUPERSEDED";

  const ruleCurrency = profile.rulesCurrent === true ? "CURRENT" : profile.rulesCurrent === false ? "EXPIRED" : "UNKNOWN";

  const hasCost = profile.unitPrice !== null && profile.unitPrice !== undefined && profile.unitPrice !== "";
  const hasSales = profile.salesPrice !== null && profile.salesPrice !== undefined && profile.salesPrice !== "";
  const calculationReadiness =
    hasCost && hasSales ? "READY" : !hasCost && !hasSales ? "MISSING_BOTH" : hasCost ? "MISSING_SALES_INPUTS" : "MISSING_COST_INPUTS";

  return { dataCompleteness, classification, ruleCurrency, calculationReadiness };
}

/** Recompute and persist a product's status from its assessment. */
export async function refreshProductStatus(ctx: AuthzContext, productId: string): Promise<ProductStatus> {
  const product = await getProductOrThrow(ctx, productId);
  const assessment = assessCompleteness({
    materialText: product.materialText,
    htsCode: product.records[0]?.htsCode ?? null,
    classificationConfirmed: product.records[0]?.status === "USER_CONFIRMED",
    unitPrice: null,
    salesPrice: null,
    rulesCurrent: undefined,
  });

  let status = product.status;
  if (product.status === ProductStatus.DRAFT) {
    status =
      assessment.dataCompleteness < 100
        ? ProductStatus.NEEDS_INFO
        : assessment.classification === "NONE"
          ? ProductStatus.NEEDS_INFO
          : ProductStatus.READY_FOR_REVIEW;
  }
  if (status !== product.status) {
    await prisma.product.update({ where: { id: product.id }, data: { status } });
  }
  return status;
}

export { ProductStatus, DataSource };
