/**
 * Local mock of the Cloudflare Pages Functions, so the auth + lead flow can
 * be tested end-to-end before deploying. Same routes, same request/response
 * shapes as functions/api/*.ts.
 *
 * Run: node scripts/dev-cloud-mock.mjs [port]
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { InMemoryStore } from "./dev-cloud-store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "public");
const port = Number(process.argv[2] ?? 57999);
const store = new InMemoryStore();

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const ITER = 100_000;

function toHex(buf) { return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return toHex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: ITER, hash: "SHA-256" }, key, 256));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function send(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" });
    return res.end();
  }

  if (path.startsWith("/api/")) {
    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { ok: false, error: "invalid JSON" }); }
    }

    if (path === "/api/register" && req.method === "POST") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return send(res, 400, { ok: false, error: "invalid email" });
      if (password.length < 10) return send(res, 400, { ok: false, error: "password must be at least 10 characters" });
      if (store.getUserByEmail(email)) return send(res, 409, { ok: false, error: "email already registered" });
      const salt = toHex(randomUUID().replace(/-/g, "").match(/../g).map((h) => parseInt(h, 16)));
      const id = randomUUID();
      store.createUser({ id, email, company: body.company ?? null, password_hash: await hashPassword(password, salt), password_salt: salt });
      const sid = randomUUID();
      store.createSession({ id: sid, user_id: id, expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() });
      return send(res, 200, { ok: true, user: { id, email, company: body.company ?? null } },
        { "set-cookie": [`oios_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`, `oios_has_session=1; Path=/; SameSite=Lax; Max-Age=43200`] });
    }

    if (path === "/api/login" && req.method === "POST") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? "");
      const u = store.getUserByEmail(email);
      if (!u) return send(res, 401, { ok: false, error: "email or password is incorrect" });
      const cand = await hashPassword(password, u.password_salt);
      if (!timingSafeEqual(cand, u.password_hash)) return send(res, 401, { ok: false, error: "email or password is incorrect" });
      const sid = randomUUID();
      store.createSession({ id: sid, user_id: u.id, expires_at: new Date(Date.now() + 12 * 3600_000).toISOString() });
      return send(res, 200, { ok: true, user: { id: u.id, email: u.email, company: u.company } },
        { "set-cookie": [`oios_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`, `oios_has_session=1; Path=/; SameSite=Lax; Max-Age=43200`] });
    }

    if (path === "/api/logout" && req.method === "POST") {
      const sid = readCookie(req, "oios_session");
      if (sid) store.deleteSession(sid);
      return send(res, 200, { ok: true }, { "set-cookie": ["oios_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0", "oios_has_session=; Path=/; Max-Age=0"] });
    }

    if (path === "/api/me" && req.method === "GET") {
      const sid = readCookie(req, "oios_session");
      const u = sid ? store.getUserBySession(sid) : null;
      if (!u) return send(res, 401, { ok: false, user: null });
      return send(res, 200, { ok: true, user: { id: u.id, email: u.email, company: u.company } });
    }

    if (path === "/api/leads" && req.method === "POST") {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return send(res, 400, { ok: false, error: "invalid email" });
      store.createLead({ ...body, email, created_at: new Date().toISOString() });
      const emailed = Boolean(process.env.RESEND_API_KEY);
      if (emailed) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({
              from: process.env.LEAD_FROM ?? "Open Import OS <leads@notifications.example.com>",
              to: [process.env.LEAD_NOTIFY_EMAIL],
              subject: `新线索：${email}`,
              text: `邮箱：${email}\n到仓：${body.landed ?? "—"}\n贡献：${body.contribution ?? "—"}\n来源：${body.utm?.source ?? "direct"}/${body.utm?.campaign ?? "—"}`,
            }),
          });
        } catch (e) { console.error("[mock] mail failed:", e.message); }
      }
      return send(res, 200, { ok: true, stored: true, emailed });
    }

    if (path === "/api/leads-list" && req.method === "GET") {
      if (req.headers["x-admin-token"] !== process.env.LEADS_ADMIN_TOKEN) return send(res, 401, { ok: false, error: "unauthorized" });
      const leads = store.listLeads();
      return send(res, 200, { ok: true, count: leads.length, leads });
    }

    return send(res, 404, { ok: false, error: "not found" });
  }

  // static
  const rel = path === "/" ? "/index.html" : path;
  const file = join(publicDir, rel.replace(/^\/+/, ""));
  if (!file.startsWith(publicDir) || !existsSync(file)) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain; charset=utf-8" });
  res.end(readFileSync(file));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-cloud] http://127.0.0.1:${port}  (public=${publicDir})`);
});
