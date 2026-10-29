/**
 * Product import service.
 *
 * Flow: download template -> upload CSV/XLSX -> field mapping -> preview ->
 * per-row validation -> confirm import -> import report.
 *
 * Guarantees:
 *  - Re-uploading the same file does not create duplicate products (the
 *    duplicate policy decides SKIP / UPDATE / ERROR).
 *  - A partial import is supported: good rows import, bad rows are reported
 *    with a downloadable error report.
 *  - CSV formula injection is neutralised (leading = + - @ are escaped).
 */
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { AppError } from "@open-import-os/contracts/errors";
import { ProductStatus, DataSource } from "@prisma/client";
import { prisma } from "@open-import-os/db/client";
import { resolveOrgScope, requireScope, type AuthzContext } from "@open-import-os/permissions";
import { toDecimal } from "@open-import-os/contracts/money";

export const PRODUCT_TEMPLATE_COLUMNS = [
  "sku",
  "nameZh",
  "nameEn",
  "descriptionZh",
  "descriptionEn",
  "materialText",
  "brand",
  "unitOfMeasure",
  "unitPrice",
  "currency",
  "salesPrice",
  "salesCurrency",
  "htsCode",
  "originCountry",
  "shipFromCountry",
  "quantity",
] as const;

export type ProductTemplateColumn = (typeof PRODUCT_TEMPLATE_COLUMNS)[number];

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

/** Neutralise spreadsheet formula injection. */
export function sanitizeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value).trim();
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Strip control characters that could smuggle content.
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  return s;
}

export interface ParsedImport {
  fileName: string;
  sha256: string;
  headers: string[];
  rows: Array<Record<string, string>>;
}

export function parseImportFile(fileName: string, buffer: Buffer): ParsedImport {
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    throw new AppError("VALIDATION_FAILED", `file exceeds ${MAX_IMPORT_BYTES} bytes`);
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const lower = fileName.toLowerCase();

  let headers: string[] = [];
  let rows: Array<Record<string, string>> = [];

  if (lower.endsWith(".csv")) {
    const records = parse(buffer, { bom: true, columns: false, relax_column_count: true, skip_empty_lines: true });
    if (records.length === 0) throw new AppError("VALIDATION_FAILED", "empty CSV file");
    headers = (records[0] as string[]).map((h) => sanitizeCell(h));
    rows = (records.slice(1) as string[][]).map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = sanitizeCell(r[i]);
      });
      return obj;
    });
  } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]!];
    if (!sheet) throw new AppError("VALIDATION_FAILED", "workbook has no sheets");
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    if (json.length === 0) throw new AppError("VALIDATION_FAILED", "empty worksheet");
    headers = Object.keys(json[0]!).map((h) => sanitizeCell(h));
    rows = json.map((r) => {
      const obj: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) obj[sanitizeCell(k)] = sanitizeCell(v);
      return obj;
    });
  } else {
    throw new AppError("VALIDATION_FAILED", "only .csv, .xlsx and .xls are supported");
  }

  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError("VALIDATION_FAILED", `file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}`);
  }
  return { fileName, sha256, headers, rows };
}

/** Map arbitrary header names onto the canonical template columns. */
export function autoMapColumns(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const col of PRODUCT_TEMPLATE_COLUMNS) {
    const target = normalize(col);
    const match = headers.find((h) => {
      const n = normalize(h);
      return n === target || n.includes(target) || target.includes(n);
    });
    if (match) mapping[col] = match;
  }
  return mapping;
}

export interface RowValidation {
  rowNo: number;
  ok: boolean;
  mapped: Record<string, string>;
  errors: string[];
}

/** Validate one row against the required fields and formats. */
export function validateRow(
  rowNo: number,
  row: Record<string, string>,
  mapping: Record<string, string>,
): RowValidation {
  const errors: string[] = [];
  const mapped: Record<string, string> = {};
  for (const [col, header] of Object.entries(mapping)) {
    mapped[col] = (row[header] ?? "").trim();
  }
  if (!mapped.sku) errors.push("sku is required");
  if (!mapped.nameZh && !mapped.nameEn) errors.push("nameZh or nameEn is required");
  if (mapped.unitPrice && toDecimal(mapped.unitPrice) === null) errors.push("unitPrice is not a valid decimal");
  if (mapped.salesPrice && toDecimal(mapped.salesPrice) === null) errors.push("salesPrice is not a valid decimal");
  if (mapped.quantity && !/^\d+$/.test(mapped.quantity)) errors.push("quantity must be a positive integer");
  if (mapped.currency && !/^[A-Z]{3}$/.test(mapped.currency)) errors.push("currency must be a 3-letter code");
  if (mapped.htsCode && !/^\d{4,10}(\.\d{2})*$/.test(mapped.htsCode.replace(/\s/g, ""))) {
    errors.push("htsCode format looks invalid (expected digits, e.g. 9617.00.10)");
  }
  return { rowNo, ok: errors.length === 0, mapped, errors };
}

export interface ImportPreview {
  batchId: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateSkus: string[];
  validations: RowValidation[];
  columnMapping: Record<string, string>;
  headers: string[];
}

/** Stage a file, auto-map columns, and validate every row (no writes yet). */
export async function stageImport(
  ctx: AuthzContext,
  fileName: string,
  buffer: Buffer,
  duplicatePolicy: "SKIP" | "UPDATE" | "ERROR" = "SKIP",
): Promise<ImportPreview> {
  requireScope(ctx, "products:write");
  const organizationId = resolveOrgScope(ctx);

  const parsed = parseImportFile(fileName, buffer);
  const columnMapping = autoMapColumns(parsed.headers);

  const batch = await prisma.productImportBatch.create({
    data: {
      organizationId,
      fileName: parsed.fileName,
      fileSha256: parsed.sha256,
      duplicatePolicy,
      totalRows: parsed.rows.length,
      status: "MAPPED",
      columnMapping: columnMapping as never,
      createdById: ctx.actor.userId ?? "system",
    },
  });

  // Existing SKUs in this tenant, for duplicate detection.
  const skus = parsed.rows.map((r) => {
    const header = columnMapping.sku;
    return header ? (r[header] ?? "").trim() : "";
  });
  const existing: Array<{ sku: string }> = await prisma.product.findMany({
    where: { organizationId, sku: { in: skus.filter(Boolean) } },
    select: { sku: true },
  });
  const existingSkus = new Set(existing.map((p) => p.sku));

  const validations = parsed.rows.map((row, i) => {
    const v = validateRow(i + 2, row, columnMapping);
    if (v.ok && v.mapped.sku && existingSkus.has(v.mapped.sku)) {
      v.errors.push(`duplicate SKU ${v.mapped.sku} (policy: ${duplicatePolicy})`);
      if (duplicatePolicy === "SKIP") v.ok = false;
    }
    return v;
  });

  await prisma.productImportRow.createMany({
    data: validations.map((v) => ({
      batchId: batch.id,
      organizationId,
      rowNo: v.rowNo,
      rawData: parsed.rows[v.rowNo - 2] as never,
      mappedData: v.mapped as never,
      outcome: v.ok ? "PENDING" : "FAILED",
      errors: v.errors as never,
    })),
  });

  return {
    batchId: batch.id,
    totalRows: parsed.rows.length,
    validRows: validations.filter((v) => v.ok).length,
    invalidRows: validations.filter((v) => !v.ok).length,
    duplicateSkus: [...existingSkus].filter((s): s is string => typeof s === "string"),
    validations,
    columnMapping,
    headers: parsed.headers,
  };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errorReport: string;
}

/** Confirm an import: create products for valid rows, leave bad rows failed. */
export async function confirmImport(ctx: AuthzContext, batchId: string): Promise<ImportResult> {
  requireScope(ctx, "products:write");
  const organizationId = resolveOrgScope(ctx);

  const batch = await prisma.productImportBatch.findFirst({ where: { id: batchId, organizationId } });
  if (!batch) throw new AppError("NOT_FOUND", "import batch not found");
  if (batch.status === "IMPORTED") throw new AppError("IDEMPOTENCY_CONFLICT", "this batch was already imported");

  const rows = await prisma.productImportRow.findMany({ where: { batchId }, orderBy: { rowNo: "asc" } });

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.outcome === "FAILED") {
      failed += 1;
      continue;
    }
    const data = row.mappedData as Record<string, string>;
    try {
      if (batch.duplicatePolicy === "UPDATE" && data.sku) {
        const existing = await prisma.product.findFirst({ where: { organizationId, sku: data.sku } });
        if (existing) {
          await prisma.product.update({
            where: { id: existing.id },
            data: {
              nameZh: data.nameZh || existing.nameZh,
              nameEn: data.nameEn || existing.nameEn,
              descriptionZh: data.descriptionZh ?? existing.descriptionZh,
              materialText: data.materialText ?? existing.materialText,
              brand: data.brand ?? existing.brand,
            },
          });
          await prisma.productImportRow.update({ where: { id: row.id }, data: { outcome: "IMPORTED", productId: existing.id } });
          imported += 1;
          continue;
        }
      }
      if (batch.duplicatePolicy === "SKIP" && data.sku) {
        const existing = await prisma.product.findFirst({ where: { organizationId, sku: data.sku } });
        if (existing) {
          await prisma.productImportRow.update({ where: { id: row.id }, data: { outcome: "SKIPPED", productId: existing.id } });
          skipped += 1;
          continue;
        }
      }
      const product = await prisma.product.create({
        data: {
          organizationId,
          sku: data.sku!,
          nameZh: data.nameZh || data.nameEn || data.sku!,
          nameEn: data.nameEn || data.nameZh || data.sku!,
          descriptionZh: data.descriptionZh || null,
          descriptionEn: data.descriptionEn || null,
          materialText: data.materialText || null,
          brand: data.brand || null,
          unitOfMeasure: data.unitOfMeasure || "PCS",
          status: ProductStatus.DRAFT,
          dataSource: ctx.actor.dataMode === "DEMO" ? DataSource.DEMO : DataSource.USER_ENTERED,
          createdById: ctx.actor.userId ?? "system",
        },
      });
      await prisma.productVersion.create({
        data: {
          productId: product.id,
          organizationId,
          versionNo: 1,
          changeReason: "imported from file",
          snapshot: data as never,
          createdById: ctx.actor.userId ?? "system",
        },
      });
      await prisma.productImportRow.update({ where: { id: row.id }, data: { outcome: "IMPORTED", productId: product.id } });
      imported += 1;
    } catch (e) {
      await prisma.productImportRow.update({
        where: { id: row.id },
        data: { outcome: "FAILED", errors: [{ message: (e as Error).message }] as never },
      });
      failed += 1;
    }
  }

  const errorReport = buildErrorReport(batch.fileName, rows);
  await prisma.productImportBatch.update({
    where: { id: batch.id },
    data: { status: "IMPORTED", importedRows: imported, skippedRows: skipped, failedRows: failed, errorReportUrl: errorReport },
  });

  return { imported, skipped, failed, errorReport };
}

/** A CSV of the failed rows, so the user can fix and re-upload. */
export function buildErrorReport(fileName: string, rows: Array<{ rowNo: number; outcome: string; errors: unknown; mappedData: unknown }>): string {
  const header = "row_no,outcome,sku,errors\n";
  const body = rows
    .filter((r) => r.outcome === "FAILED")
    .map((r) => {
      const mapped = (r.mappedData ?? {}) as Record<string, string>;
      const errs = Array.isArray(r.errors) ? (r.errors as Array<{ message?: string } | string>).map((e) => (typeof e === "string" ? e : e.message ?? "")).join(" | ") : "";
      return `${r.rowNo},${r.outcome},"${(mapped.sku ?? "").replace(/"/g, '""')}","${errs.replace(/"/g, '""')}"`;
    })
    .join("\n");
  return header + body;
}

/** Generate the downloadable template. */
export function generateTemplateCsv(): string {
  const header = PRODUCT_TEMPLATE_COLUMNS.join(",");
  const example = [
    "DEMO-SKU-001",
    "演示商品：不锈钢保温杯",
    "Stainless steel vacuum flask",
    "500ml double-wall flask (synthetic demo)",
    "500ml double-wall flask",
    "stainless steel 304 body",
    "DemoBrand",
    "PCS",
    "8.00",
    "USD",
    "19.90",
    "USD",
    "9617.00.10",
    "CN",
    "CN",
    "1000",
  ].join(",");
  return `${header}\n${example}\n`;
}

export { ProductStatus, DataSource };
