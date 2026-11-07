/** GET /api/me — current session user (or 401). */
import { json, type Env } from "./_shared";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const header = request.headers.get("cookie") ?? "";
  let sid: string | null = null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "oios_session") sid = decodeURIComponent(v.join("="));
  }
  if (!sid || !env.DB) return json({ ok: false, user: null }, 401);

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.company, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?1`,
  )
    .bind(sid)
    .first<{ id: string; email: string; company: string | null; expires_at: string }>();

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    return json({ ok: false, user: null }, 401);
  }
  return json({ ok: true, user: { id: row.id, email: row.email, company: row.company } });
};
