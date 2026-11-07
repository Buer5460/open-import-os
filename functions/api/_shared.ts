/**
 * Shared helpers for Cloudflare Pages Functions.
 *
 * The lead store is a D1 database (free tier). Everything here is
 * dependency-free so the Worker bundle stays small and cold starts fast.
 */

export interface Env {
  DB?: D1Database;
  RESEND_API_KEY?: string;
  LEAD_NOTIFY_EMAIL?: string;
  ALLOWED_ORIGIN?: string;
}

export interface LeadPayload {
  email: string;
  company?: string;
  landed?: string;
  contribution?: string;
  margin?: string;
  status?: string;
  utm?: {
    source?: string;
    medium?: string;
    campaign?: string;
    content?: string;
    ref?: string;
    ts?: string;
  };
  page?: string;
}

/** Consistent JSON response with permissive-but-scoped CORS. */
export function json(data: unknown, status = 200, origin?: string): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin ?? "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v.trim());
}

/** Simple per-IP in-memory throttle (best effort; D1 rate limit is the durable one). */
const hits = new Map<string, number[]>();
export function rateLimited(ip: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}
