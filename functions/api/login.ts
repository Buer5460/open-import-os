/**
 * POST /api/login — verify credentials and start a session.
 * POST /api/logout — revoke the current session.
 */
import { json, isEmail, rateLimited, type Env } from "./_shared";

const ITERATIONS = 100_000;
const KEY_LEN = 32;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: ITERATIONS, hash: "SHA-256" },
    key,
    KEY_LEN * 8,
  );
  return toHex(bits);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const action = url.pathname.endsWith("/logout") ? "logout" : "login";

  if (action === "logout") {
    const sid = readCookie(request, "oios_session");
    if (sid && env.DB) {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(sid).run().catch(() => undefined);
    }
    const res = json({ ok: true });
    res.headers.append("set-cookie", "oios_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    return res;
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (rateLimited(ip, 10, 60_000)) return json({ ok: false, error: "too many attempts" }, 429);

  let body: { email?: string; password?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!isEmail(email) || !body.password) {
    return json({ ok: false, error: "email or password is incorrect" }, 401);
  }
  if (!env.DB) return json({ ok: false, error: "database not configured" }, 503);

  const user = (await env.DB.prepare(
    "SELECT id, email, company, password_hash, password_salt FROM users WHERE email = ?1",
  )
    .bind(email)
    .first<{ id: string; email: string; company: string | null; password_hash: string; password_salt: string }>());

  if (!user) {
    // Same message as a wrong password: no account enumeration.
    return json({ ok: false, error: "email or password is incorrect" }, 401);
  }
  const candidate = await hashPassword(body.password, user.password_salt);
  if (!timingSafeEqual(candidate, user.password_hash)) {
    return json({ ok: false, error: "email or password is incorrect" }, 401);
  }

  const sessionId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(sessionId, user.id, new Date().toISOString(), new Date(Date.now() + 12 * 3600_000).toISOString())
    .run();

  const res = json({ ok: true, user: { id: user.id, email: user.email, company: user.company } });
  res.headers.append(
    "set-cookie",
    `oios_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Secure`,
  );
  return res;
};

export const onRequestOptions: PagesFunction<Env> = async ({ request }) => {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": request.headers.get("origin") ?? "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
};
