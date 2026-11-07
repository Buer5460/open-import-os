/**
 * POST /api/register — create a demo account.
 *
 * Passwords are hashed with PBKDF2-SHA256 (Web Crypto, no native deps) using a
 * per-user random salt. No plaintext password is ever stored or logged.
 */
import { json, isEmail, rateLimited, type Env } from "./_shared";

const ITERATIONS = 100_000;
const KEY_LEN = 32;

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
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

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (rateLimited(ip, 5, 60_000)) {
    return json({ ok: false, error: "too many attempts" }, 429);
  }

  let body: { email?: string; password?: string; company?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) return json({ ok: false, error: "invalid email" }, 400);
  if (!body.password || body.password.length < 10) {
    return json({ ok: false, error: "password must be at least 10 characters" }, 400);
  }
  if (body.password.length > 200) {
    return json({ ok: false, error: "password too long" }, 400);
  }

  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hash = await hashPassword(body.password, salt);

  if (!env.DB) {
    return json({ ok: false, error: "database not configured" }, 503);
  }

  try {
    const dup = await env.DB.prepare("SELECT id FROM users WHERE email = ?1").bind(email).first();
    if (dup) return json({ ok: false, error: "email already registered" }, 409);

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, company, password_hash, password_salt, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(id, email, body.company ?? null, hash, salt, new Date().toISOString())
      .run();

    // Set an httpOnly session cookie (opaque id stored in D1).
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(sessionId, id, new Date().toISOString(), new Date(Date.now() + 12 * 3600_000).toISOString())
      .run();

    const res = json({ ok: true, user: { id, email, company: body.company ?? null } });
    res.headers.append(
      "set-cookie",
      `oios_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}; Secure`,
    );
    // A JS-readable hint so the client knows a session exists without
    // touching the HttpOnly cookie itself.
    res.headers.append("set-cookie", `oios_has_session=1; Path=/; SameSite=Lax; Max-Age=${12 * 3600}`);
    return res;
  } catch (e) {
    console.error("[register] failed:", (e as Error).message);
    return json({ ok: false, error: "registration failed" }, 500);
  }
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
