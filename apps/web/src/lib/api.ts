/**
 * /api/v1 REST router for the SaaS product.
 *
 * Mounted by server.mjs. Every handler receives the resolved AuthzContext;
 * tenancy and scope checks happen inside the core services, not here.
 *
 * Error shape (single, for every endpoint):
 *   { error: { code, message, details? } }
 */
import { createHash, randomBytes } from "node:crypto";
import { AppError, ERROR_CODES } from "@open-import-os/contracts/errors";
import {
  login as loginService,
  getAuthzContextForToken,
  destroySession,
} from "./session.js";
import {
  createProduct,
  listProducts,
  getProductOrThrow,
} from "@open-import-os/core/products";
import {
  runLandedCostCalculation,
  runProfitCalculation,
  getCalculation,
} from "@open-import-os/core/calculations";
import { stageImport, confirmImport, generateTemplateCsv } from "@open-import-os/core/import";
import { LandedCostInputSchema, ProfitInputSchema } from "@open-import-os/contracts/calc";
import { prisma } from "@open-import-os/db/client";

const COOKIE = "oios_session";
const SESSION_TTL_HOURS = 12;

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function ok(res: import("node:http").ServerResponse, body: unknown) {
  json(res, 200, body);
}

export function fail(res: import("node:http").ServerResponse, code: string, message: string, details?: unknown) {
  const status: Record<string, number> = {
    VALIDATION_FAILED: 400,
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    DUPLICATE: 409,
    IDEMPOTENCY_CONFLICT: 409,
    PROFESSIONAL_SERVICE_GATED: 409,
    OUTBOUND_DISABLED: 409,
    INVALID_CREDENTIALS: 401,
    ACCOUNT_LOCKED: 423,
    FORBIDDEN_TENANT: 403,
    RATE_LIMITED: 429,
    INTERNAL: 500,
  };
  json(res, status[code] ?? 400, { error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new AppError("VALIDATION_FAILED", "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AppError("VALIDATION_FAILED", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req: import("node:http").IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? "";
  return Object.fromEntries(
    header.split(";").map((p) => {
      const i = p.indexOf("=");
      return i === -1 ? ["", ""] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
    }),
  );
}

async function ctxForRequest(req: import("node:http").IncomingMessage) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  return getAuthzContextForToken(token);
}

function setSessionCookie(res: import("node:http").ServerResponse, token: string) {
  res.setHeader("set-cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`);
}

function clearSessionCookie(res: import("node:http").ServerResponse) {
  res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

async function requireCtx(req: import("node:http").IncomingMessage) {
  const ctx = await ctxForRequest(req);
  if (!ctx) throw new AppError("UNAUTHENTICATED", "sign in to continue");
  return ctx;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (args: {
    req: import("node:http").IncomingMessage;
    res: import("node:http").ServerResponse;
    match: RegExpMatchArray;
    url: URL;
  }) => Promise<void>;
}

const routes: Route[] = [
  // --- auth ---------------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/api\/v1\/auth\/register$/,
    handler: async ({ req, res }) => {
      const body = (await readBody(req)) as { email?: string; password?: string; organizationName?: string };
      if (!body.email || !body.password) throw new AppError("VALIDATION_FAILED", "email and password are required");
      if (body.password.length < 10) throw new AppError("VALIDATION_FAILED", "password must be at least 10 characters");
      const email = body.email.toLowerCase();
      const exists = await prisma.user.findUnique({ where: { email } });
      if (exists) throw new AppError("DUPLICATE", "an account with this email already exists");

      const { hashPassword } = await import("@open-import-os/db/password");
      const slug = `org-${createHash("sha256").update(email).digest("hex").slice(0, 10)}`;
      const user = await prisma.user.create({
        data: {
          email,
          displayName: email.split("@")[0]!,
          passwordHash: hashPassword(body.password),
        },
      });
      const org = await prisma.organization.create({
        data: {
          name: body.organizationName ?? email.split("@")[0]!,
          slug,
          ownerId: user.id,
        },
      });
      await prisma.membership.create({
        data: { userId: user.id, organizationId: org.id, role: "OWNER" },
      });
      const token = await loginService(email, body.password);
      setSessionCookie(res, token);
      ok(res, { user: { id: user.id, email: user.email }, organizationId: org.id });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/auth\/login$/,
    handler: async ({ req, res }) => {
      const body = (await readBody(req)) as { email?: string; password?: string };
      if (!body.email || !body.password) throw new AppError("VALIDATION_FAILED", "email and password are required");
      const token = await loginService(body.email, body.password);
      setSessionCookie(res, token);
      ok(res, { ok: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/auth\/logout$/,
    handler: async ({ req, res }) => {
      const token = parseCookies(req)[COOKIE];
      if (token) await destroySession(token);
      clearSessionCookie(res);
      ok(res, { ok: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/auth\/me$/,
    handler: async ({ req, res }) => {
      const ctx = await ctxForRequest(req);
      if (!ctx) throw new AppError("UNAUTHENTICATED", "sign in to continue");
      ok(res, { actor: ctx.actor, scopes: ctx.scopes });
    },
  },

  // --- products -----------------------------------------------------------
  {
    method: "GET",
    pattern: /^\/api\/v1\/products$/,
    handler: async ({ req, res, url }) => {
      const ctx = await requireCtx(req);
      const result = await listProducts(ctx, {
        q: url.searchParams.get("q") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 50),
        offset: Number(url.searchParams.get("offset") ?? 0),
      });
      ok(res, result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/products$/,
    handler: async ({ req, res }) => {
      const ctx = await requireCtx(req);
      const product = await createProduct(ctx, (await readBody(req)) as never);
      ok(res, { product });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/products\/import\/template$/,
    handler: async ({ res }) => {
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="product-template.csv"',
      });
      res.end(generateTemplateCsv());
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/products\/import\/confirm$/,
    handler: async ({ req, res }) => {
      const ctx = await requireCtx(req);
      const body = (await readBody(req)) as { batchId?: string };
      if (!body.batchId) throw new AppError("VALIDATION_FAILED", "batchId is required");
      ok(res, await confirmImport(ctx, body.batchId));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/products\/([^/]+)$/,
    handler: async ({ req, res, match }) => {
      const ctx = await requireCtx(req);
      ok(res, { product: await getProductOrThrow(ctx, match[1]!) });
    },
  },

  // --- calculations -------------------------------------------------------
  {
    method: "POST",
    pattern: /^\/api\/v1\/calculations\/landed-cost$/,
    handler: async ({ req, res }) => {
      const ctx = await requireCtx(req);
      const parsed = LandedCostInputSchema.safeParse(await readBody(req));
      if (!parsed.success) throw new AppError("VALIDATION_FAILED", "invalid landed-cost input", parsed.error.issues);
      const { run, result } = await runLandedCostCalculation(ctx, parsed.data as never);
      ok(res, { runId: run.id, status: run.status, result });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/v1\/calculations\/profit$/,
    handler: async ({ req, res }) => {
      const ctx = await requireCtx(req);
      const parsed = ProfitInputSchema.safeParse(await readBody(req));
      if (!parsed.success) throw new AppError("VALIDATION_FAILED", "invalid profit input", parsed.error.issues);
      const { run, result } = await runProfitCalculation(ctx, parsed.data as never);
      ok(res, { runId: run.id, status: run.status, result });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/v1\/calculations\/([^/]+)$/,
    handler: async ({ req, res, match }) => {
      const ctx = await requireCtx(req);
      ok(res, { run: await getCalculation(ctx, match[1]!) });
    },
  },

  // --- import -------------------------------------------------------------

  // --- health -------------------------------------------------------------
  {
    method: "GET",
    pattern: /^\/api\/v1\/health$/,
    handler: async ({ res }) => {
      await prisma.$queryRaw`select 1`;
      ok(res, { ok: true, db: "up", time: new Date().toISOString() });
    },
  },
];

export async function handleApiV1(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/")) return false;
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = url.pathname.match(route.pattern);
    if (!match) continue;
    try {
      await route.handler({ req, res, match, url });
    } catch (err) {
      if (err instanceof AppError) {
        fail(res, err.code, err.message, (err as { details?: unknown }).details);
      } else {
        console.error("[api] unhandled:", err);
        fail(res, ERROR_CODES.INTERNAL, "internal error");
      }
    }
    return true;
  }
  fail(res, "NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
  return true;
}

export { randomBytes, createHash };
