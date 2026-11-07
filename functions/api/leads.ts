/**
 * POST /api/leads — capture a website lead (email + the calculation the
 * visitor just ran) and (optionally) email the PDF report request to the
 * operator.
 *
 * Storage: D1 (free). Mail: Resend (free tier). Both optional: without a
 * key the lead is still stored and the request succeeds — the operator can
 * read leads from the dashboard/API.
 */
import { json, isEmail, rateLimited, type Env, type LeadPayload } from "./_shared";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (rateLimited(ip, 10, 60_000)) {
    return json({ ok: false, error: "too many requests" }, 429);
  }

  let body: LeadPayload;
  try {
    body = (await request.json()) as LeadPayload;
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) {
    return json({ ok: false, error: "invalid email" }, 400);
  }

  const utm = body.utm ?? {};
  const createdAt = new Date().toISOString();

  // --- persist -------------------------------------------------------------
  let stored = false;
  if (env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO leads
           (id, email, company, landed, contribution, margin, calc_status,
            utm_source, utm_medium, utm_campaign, utm_content, referrer,
            page_url, created_at, emailed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
      )
        .bind(
          crypto.randomUUID(),
          email,
          body.company ?? null,
          body.landed ?? null,
          body.contribution ?? null,
          body.margin ?? null,
          body.status ?? null,
          utm.source ?? "direct",
          utm.medium ?? null,
          utm.campaign ?? null,
          utm.content ?? null,
          utm.ref ?? null,
          body.page ?? null,
          createdAt,
        )
        .run();
      stored = true;
    } catch (e) {
      console.error("[leads] D1 insert failed:", (e as Error).message);
    }
  }

  // --- notify by email ----------------------------------------------------
  let emailed = false;
  let mailError: string | null = null;
  if (env.RESEND_API_KEY && env.LEAD_NOTIFY_EMAIL) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: "Open Import OS <leads@notifications.example.com>",
          to: [env.LEAD_NOTIFY_EMAIL],
          subject: `新线索：${email}${body.landed ? `（到仓 ${body.landed}）` : ""}`,
          text: [
            "收到一条网站留资：",
            "",
            `邮箱：${email}`,
            body.company ? `公司：${body.company}` : "",
            "",
            "对方刚做的测算：",
            `  到仓成本：${body.landed ?? "—"}`,
            `  贡献利润：${body.contribution ?? "—"}`,
            `  利润率：${body.margin ?? "—"}`,
            `  状态：${body.status ?? "—"}`,
            "",
            "来源：",
            `  source：${utm.source ?? "direct"}`,
            `  medium：${utm.medium ?? "—"}`,
            `  campaign：${utm.campaign ?? "—"}`,
            `  content：${utm.content ?? "—"}`,
            `  referrer：${utm.ref ?? "—"}`,
            "",
            `页面：${body.page ?? "—"}`,
            `时间：${createdAt}`,
            "",
            "回复该邮件即可开始跟进。",
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      });
      emailed = res.ok;
      if (!res.ok) mailError = (await res.text()).slice(0, 200);
    } catch (e) {
      mailError = (e as Error).message.slice(0, 200);
    }
  }

  return json({ ok: true, stored, emailed, mailError });
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
