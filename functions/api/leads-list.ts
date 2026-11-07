/**
 * GET /api/leads-list — operator-only lead list.
 *
 * Requires a shared secret header (LEADS_ADMIN_TOKEN). Without the token
 * configured the endpoint is disabled entirely rather than open.
 */
import { json, type Env } from "./_shared";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const expected = env.LEADS_ADMIN_TOKEN;
  if (!expected) return json({ ok: false, error: "disabled" }, 403);
  const provided = request.headers.get("x-admin-token") ?? "";
  if (provided !== expected) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "database not configured" }, 503);

  const rows = await env.DB.prepare(
    `SELECT email, company, landed, contribution, margin, calc_status,
            utm_source, utm_medium, utm_campaign, referrer, page_url, created_at
       FROM leads ORDER BY created_at DESC LIMIT 200`,
  ).all<Record<string, unknown>>();

  return json({ ok: true, count: rows.results?.length ?? 0, leads: rows.results ?? [] });
};
