/**
 * Shared HTTP plumbing for the REST API.
 *
 * Every error response has the same shape, so a client never has to guess:
 *   { error: { code, message, details? } }
 */
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, ERROR_CODES, type ErrorCode } from "@open-import-os/contracts/errors";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const STATUS: Record<string, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCOPE_MISSING: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  FEATURE_DISABLED: 409,
  PROFESSIONAL_SERVICE_GATED: 409,
  OUTBOUND_DISABLED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function statusForCode(code: string): number {
  return STATUS[code] ?? 400;
}

export function errorResponse(code: ErrorCode | string, message: string, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) } };
  return NextResponse.json(body, { status: statusForCode(code) });
}

export function appErrorResponse(err: AppError) {
  return errorResponse(err.code, err.message, err.details);
}

/**
 * Wrap a route handler. Converts errors into the single error shape and never
 * leaks a stack trace to the client.
 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) return appErrorResponse(err);
    if (err instanceof ZodError) {
      return errorResponse(ERROR_CODES.VALIDATION_FAILED, "request body failed validation", err.issues);
    }
    // Unknown errors: log locally, return a generic message.
    console.error("[api] unhandled error:", err);
    return errorResponse(ERROR_CODES.INTERNAL, "internal error");
  }
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}
