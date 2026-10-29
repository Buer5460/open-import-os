#!/usr/bin/env node
/**
 * Free single-product landed-cost + profit calculator.
 *
 * The page is a thin shell: every number it shows comes from the SAME
 * deterministic engine in packages/core (calculateLandedCost /
 * calculateProfit / verifyTargetPrice). No formula is re-implemented in the
 * browser — a second implementation would silently disagree with the API and
 * destroy the product's credibility.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
// packages/core has no src/index.ts barrel yet (its package.json "main" points
// at a file that does not exist), so import the engine modules directly. This
// is the ONLY engine implementation — nothing is recomputed in the browser.
import {
  calculateLandedCost,
  ENGINE_VERSION as COST_ENGINE_VERSION,
} from "../../packages/core/src/cost.ts";
import {
  calculateProfit,
  verifyTargetPrice,
  roundPriceUp,
} from "../../packages/core/src/profit.ts";
const ENGINE_VERSION = `web:${COST_ENGINE_VERSION}`;
import Decimal from "decimal.js";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 57831);
const publicBase = process.env.APP_BASE_URL ?? `http://127.0.0.1:${port}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Parse a money-ish string into a decimal string, or null when unusable. */
function money(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  try {
    const d = new Decimal(s);
    if (d.isNaN() || !d.isFinite()) return null;
    if (d.isNegative()) return null; // negative fees/prices are not meaningful
    return d.toString();
  } catch {
    return null;
  }
}

function pct(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  try {
    const d = new Decimal(s);
    if (d.isNaN() || !d.isFinite()) return null;
    return d.toString();
  } catch {
    return null;
  }
}

function int(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return String(Math.floor(n));
}

/**
 * Run the real engine. Returns a result object shaped for the page:
 * values are engine output, never local arithmetic.
 */
function compute(body) {
  const currency = "USD";
  const qty = int(body.quantity);
  const unitPrice = money(body.unitPrice);
  const freight = money(body.freight);
  const insurance = money(body.insurance);
  const customsClearance = money(body.customsClearance);
  const inlandFreight = money(body.inlandFreight);
  const otherCost = money(body.otherCost);
  const dutyRatePct = pct(body.dutyRatePct);
  const mpf = money(body.mpf);
  const hmf = money(body.hmf);

  const salesPrice = money(body.salesPrice);
  const platformFeePct = pct(body.platformFeePct);
  const paymentFeePct = pct(body.paymentFeePct);
  const otherVariableFeePct = pct(body.otherVariableFeePct);
  const fulfillmentFee = money(body.fulfillmentFee);
  const adSpendPerUnit = money(body.adSpendPerUnit);
  const otherFixedFee = money(body.otherFixedFee);
  const targetMarginPct = pct(body.targetMarginPct);
  const htsCode = typeof body.htsCode === "string" ? body.htsCode.trim() : "";
  const originCountry =
    typeof body.originCountry === "string" && body.originCountry.trim()
      ? body.originCountry.trim()
      : "";

  // --- Missing-field bookkeeping: unknown is null, never zero. -------------
  const missing = [];
  if (!unitPrice) missing.push("采购单价");
  if (!freight) missing.push("运费");
  if (!originCountry) missing.push("原产国");

  const unconfirmed = [];
  if (htsCode) {
    unconfirmed.push({
      item: "HTS 归类",
      note: `你填写了 ${htsCode}。归类须由持牌报关人复核，本工具不确认其准确性。`,
    });
  } else {
    unconfirmed.push({
      item: "HTS 归类",
      note: "未提供编码，归类风险未评估。",
    });
  }
  if (!dutyRatePct) {
    unconfirmed.push({
      item: "关税税率",
      note: "未提供税率，以下结果不含关税。",
    });
  }
  if (!mpf) unconfirmed.push({ item: "MPF 商品处理费", note: "未计入" });
  if (!hmf) unconfirmed.push({ item: "HMF 港口维护费", note: "未计入" });

  // Refuse rather than compute garbage.
  if (!unitPrice) {
    return { ok: false, error: "请填写采购单价。", missing, unconfirmed };
  }
  if (qty === null) {
    return { ok: false, error: "数量必须为正整数。", missing, unconfirmed };
  }

  // --- Engine call: landed cost -------------------------------------------
  // The engine's contract takes PER-UNIT logistics values with its own field
  // names, and requires an explicit customsValue (it refuses to assume FOB).
  const perUnit = (batchValue) => {
    if (batchValue === null || batchValue === undefined) return null;
    try {
      return new Decimal(batchValue).div(qty).toString();
    } catch {
      return null;
    }
  };

  // Customs value: engine will not treat total cost as customs value.
  // Default to the purchase amount when the user did not enter one, and record
  // it as an assumption (never a silent default).
  // Customs value is the total declared customs value for the shipment; the
  // engine refuses to derive it from total cost. Default to purchase amount
  // and mark it as an assumption rather than a silent default.
  let usedCustomsValueAssumption = false;
  let customsValue = money(body.customsValue);
  if (!customsValue) {
    // Engine applies dutyRatePct to a PER-UNIT customs value, same base as
    // unitPrice. Using the batch amount would multiply duty by quantity.
    customsValue = unitPrice;
    usedCustomsValueAssumption = true;
  }

  let landed;
  try {
    // Explicit otherTaxes from the form is a PER-UNIT value the user typed;
    // it must reach the engine (I24) or changing it would have no effect.
    const otherTaxesInput = money(body.otherTaxes);

    // MPF/HMF entered on this page are ENTRY-LEVEL (per shipment) amounts,
    // charged once per customs entry. They go to the engine as entry amounts
    // (the engine divides by quantity), NOT as per-unit values - passing them
    // as per-unit multiplied the entry fee by the quantity (I23).
    const mpfEntry = money(body.mpf) ?? money(body.mpfEntryAmount);
    const hmfEntry = money(body.hmf) ?? money(body.hmfEntryAmount);
    // The advanced fields are also honored (blank = unknown, per I21).
    const portCharges = money(body.portCharges);
    const warehousingCost = money(body.warehousingCost);

    // A field the user left blank is UNKNOWN, not "confirmed zero" (I21).
    // Only the form's explicit checkbox ("本项确认为0") turns a blank into a
    // confirmed zero; the adapter never guesses on the user's behalf.
    const confirmedZero = [];
    if (body.naInsurance === true) confirmedZero.push("insuranceCost");
    if (body.naPortCharges === true) confirmedZero.push("portCharges");
    if (body.naWarehousingCost === true) confirmedZero.push("warehousingCost");

    // R1.1-02: tax-scope mode comes from the user's explicit choice. The
    // MANUAL_TOTAL_SCENARIO option requires a coverage description, which
    // becomes the engine's recorded confirmation.
    const taxScopeMode = body.taxScopeMode === "MANUAL_TOTAL_SCENARIO" ? "MANUAL_TOTAL_SCENARIO" : "ITEMIZED";
    let manualTotalConfirmation = null;
    if (taxScopeMode === "MANUAL_TOTAL_SCENARIO") {
      const coverage = typeof body.taxCoverage === "string" ? body.taxCoverage.trim() : "";
      if (coverage) {
        // The计量层级 now comes from the form: PER_UNIT or PER_ENTRY.
        manualTotalConfirmation = {
          coverage,
          level: body.taxLevel === "PER_ENTRY" ? "PER_ENTRY" : "PER_UNIT",
          confirmedBy: "free-calculator-user",
          coversBaseDuty: body.coversBaseDuty === "INCLUDED" || body.coversBaseDuty === "EXCLUDED" ? body.coversBaseDuty : "UNKNOWN",
        };
      }
    }

    landed = calculateLandedCost({
      currency,
      quantity: Number(qty),
      unitPrice,
      freightCost: perUnit(freight),
      insuranceCost: perUnit(insurance),
      customsClearanceCost: perUnit(customsClearance),
      inlandDeliveryCost: perUnit(inlandFreight),
      otherLandedFees: perUnit(otherCost),
      portCharges: perUnit(portCharges),
      warehousingCost: perUnit(warehousingCost),
      customsValue,
      dutyRatePct,
      mpfEntryAmount: mpfEntry,
      hmfEntryAmount: hmfEntry,
      otherTaxes: otherTaxesInput,
      taxScopeMode,
      manualTotalConfirmation,
      shipmentMode: "OCEAN",
      incoterm: "FOB",
      additionalDutyLayers: [],
      notApplicableFields: confirmedZero,
    });
  } catch (err) {
    return {
      ok: false,
      error: `成本引擎拒绝计算：${err?.message ?? String(err)}`,
      missing,
      unconfirmed,
    };
  }

  // R1.2-02: a BLOCKED verdict is a hard stop, not a warning. The page shows
  // the reason and no "complete" numbers, so a double-count can never be
  // presented as a usable quote.
  if (landed.status === "BLOCKED") {
    return {
      ok: false,
      error: `计算被阻断：${(landed.unsupportedComponents ?? []).join("；") || "输入存在无法解决的冲突"}`,
      missing,
      unconfirmed,
      blocked: true,
      unsupportedComponents: landed.unsupportedComponents ?? [],
    };
  }

  // Engine contract exposes batchLandedCost (not totalLandedCost).
  const totalLanded = landed.batchLandedCost ?? null;
  // Per-unit landed cost derived from the batch total, so the page never
  // depends on the engine's ambiguous per-unit field.
  let L = null;
  if (totalLanded !== null && totalLanded !== undefined) {
    try {
      L = new Decimal(String(totalLanded)).div(new Decimal(qty)).toString();
    } catch (e) {
      L = null;
    }
  }
  // Fall back to the engine's own per-unit figure if the batch one is absent.
  if (L === null && landed.unitLandedCost !== null && landed.unitLandedCost !== undefined) {
    L = String(landed.unitLandedCost);
  }

  // FOB baseline for the "how much did you miss" comparison.
  const fobTotal = new Decimal(unitPrice).times(qty);
  let gapPct = null;
  if (totalLanded !== null && totalLanded !== undefined && fobTotal.gt(0)) {
    try {
      gapPct = new Decimal(totalLanded).minus(fobTotal).div(fobTotal).times(100);
    } catch {
      gapPct = null;
    }
  }

  // --- Engine call: profit -------------------------------------------------
  let profit = null;
  let targetPrice = null;
  let breakeven = null;
  let verified = null;

  if (salesPrice) {
    try {
      profit = calculateProfit({
        currency,
        salesPrice,
        landedCost: L,
        // Blank fee boxes are UNKNOWN unless the user checked "本项确认为0".
        platformFeePct: platformFeePct ?? null,
        paymentFeePct: paymentFeePct ?? null,
        otherVariableFeePct: otherVariableFeePct ?? null,
        fulfillmentFee: fulfillmentFee ?? null,
        adSpendPerUnit: adSpendPerUnit ?? null,
        otherFixedFee: otherFixedFee ?? null,
        ratioFeesSameBase: true,
        targetMarginPct,
      });
      // I22/I26: the profit inherits the cost stage's incompleteness. A cost
      // that was not COMPLETE cannot yield a "complete" profit - downgrade
      // the profit status so the page never presents a partial figure as
      // final.
      if (profit && landed.status !== "COMPLETE_WITHIN_SCOPE" && profit.status === "COMPLETE_WITHIN_SCOPE") {
        profit = {
          ...profit,
          status: "INCOMPLETE",
          assumptions: [
            ...(profit.assumptions ?? []),
            `upstream landed cost is ${landed.status}; this profit covers known items only`,
          ],
        };
      }
      breakeven = profit.breakevenPrice ?? null;
      targetPrice = profit.targetPrice ?? null;

      // Verify the rounded-up target price really meets the margin goal.
      if (targetPrice && targetMarginPct) {
        try {
          const v = verifyTargetPrice(
            new Decimal(targetPrice),
            new Decimal(L),
            new Decimal(
              new Decimal(fulfillmentFee ?? 0)
                .plus(adSpendPerUnit ?? 0)
                .plus(otherFixedFee ?? 0),
            ),
            new Decimal(
              new Decimal(platformFeePct ?? 0)
                .plus(paymentFeePct ?? 0)
                .plus(otherVariableFeePct ?? 0),
            ),
            new Decimal(targetMarginPct),
          );
          verified = typeof v === "boolean" ? v : (v?.ok ?? v?.meets ?? null);
        } catch {
          verified = null;
        }
      }
    } catch (err) {
      profit = { error: err?.message ?? String(err) };
    }
  }

  return {
    ok: true,
    engineVersion: ENGINE_VERSION,
    missing,
    unconfirmed,
    landed: {
      unitLandedCost: L,
      totalLandedCost: totalLanded === null ? null : String(totalLanded),
      fobTotal: fobTotal.toString(),
      gapPct: gapPct === null ? null : gapPct.toFixed(2),
      status: landed.status,
      missingFields: landed.missingFields ?? [],
      assumptions: [
        ...(landed.assumptions ?? []),
        ...(usedCustomsValueAssumption
          ? ["海关计税价值默认取采购金额（未单独填写），可在进阶选项中修改"]
          : []),
      ],
      components: (landed.components ?? []).map((c) => ({
        label: c.label ?? c.name ?? "",
        amount: c.amount ?? null,
      })),
    },
    profit: profit
      ? {
          contribution: profit.contributionProfit ?? null,
          margin: profit.contributionMargin ?? null,
          breakevenPrice: breakeven,
          targetPrice: targetPrice,
          targetVerified: verified,
          status: profit.status,
          error: profit.error ?? null,
        }
      : null,
    // Compliance: never claim completeness or tax accuracy.
    disclaimer:
      "本结果基于你输入的费率计算，不构成报关或法律意见。HTS 归类须由持牌报关人确认。" +
      (unconfirmed.length
        ? " 以下成本项未确认，未计入总额：见「未确认项」。"
        : ""),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, publicBase);

  // --- API: the engine is the single source of truth -----------------------
  if (url.pathname === "/api/calculate" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 100_000) req.destroy();
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "请求体不是合法 JSON" }));
        return;
      }
      const result = compute(body);
      res.writeHead(result.ok === false ? 400 : 200, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, engine: ENGINE_VERSION }));
    return;
  }

  // --- SaaS REST API (/api/v1/*) ------------------------------------------
  // The server is started via tsx, so the TypeScript router can be imported
  // directly; tenancy and scope checks live inside the core services.
  if (url.pathname.startsWith("/api/v1/")) {
    try {
      const { handleApiV1 } = await import("./src/lib/api.ts");
      const handled = await handleApiV1(req, res, url);
      if (handled) return;
    } catch (err) {
      console.error("[api] router failure:", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INTERNAL", message: "internal error" } }));
      return;
    }
  }

  // --- Static shell --------------------------------------------------------
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(root, "pages", rel.replace(/^\/+/, ""));
  if (!file.startsWith(join(root, "pages")) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "text/plain" });
  res.end(readFileSync(file));
});

// R1.1-05: bind the loopback interface explicitly. The previous no-host call
// listened on every interface (the OS default), which the ENTRY notes claimed
// was 127.0.0.1-only. Only localhost may reach this app.
server.listen(port, "127.0.0.1", () => {
  console.log(`[web] 免费测算器 running at ${publicBase}`);
  console.log(`[web] engine: ${ENGINE_VERSION}`);
});
