"""R1.2A browser E2E: Chinese coverage must be blocked; EXCLUDED path works."""
from playwright.sync_api import sync_playwright
import json, sys, os

BASE = "http://127.0.0.1:57931"
OUT = "/Users/mac/Downloads/外贸问题平台/open-import-os/handoff/acceptance/20261018-R1_2A/screenshots"
os.makedirs(OUT, exist_ok=True)
results = []
def check(name, cond, detail=""):
    results.append({"name": name, "ok": bool(cond), "detail": str(detail)[:200]})
    print(("  ok  " if cond else "FAIL  ") + name + ("" if cond else f"  [{detail}]"))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(BASE, wait_until="networkidle")

    def fill_common():
        page.fill("#unitPrice", "8")
        page.fill("#quantity", "1000")
        page.fill("#freight", "1200")
        page.fill("#customsClearance", "800")
        page.fill("#inlandFreight", "0")
        page.fill("#otherCost", "0")
        page.fill("#otherTaxes", "2")
        page.fill("#mpf", "0")
        page.fill("#hmf", "0")
        page.check("#na-insurance")
        page.check("#na-portCharges")
        page.check("#na-warehousingCost")
        page.select_option("#taxScopeMode", "MANUAL_TOTAL_SCENARIO")
        page.fill("#taxCoverage", "含基础关税+301条款")
        page.fill("#salesPrice", "19.90")
        page.fill("#platformFeePct", "0")
        page.fill("#paymentFeePct", "0")
        page.fill("#otherVariableFeePct", "0")
        page.fill("#fulfillmentFee", "5.00")
        page.fill("#adSpendPerUnit", "0")
        page.fill("#otherFixedFee", "0")

    # --- R2A-01: Chinese coverage + dutyRatePct -> blocked -------------------
    fill_common()
    page.fill("#dutyRatePct", "25")
    page.select_option("#taxLevel", "PER_UNIT")
    # coversBaseDuty defaults to UNKNOWN via a fresh page; the form needs a
    # selector — check if present (R1.2A adds it), else the UNKNOWN default applies.
    page.click("#go")
    page.wait_for_timeout(700)
    err = page.text_content("#err").strip()
    check("Chinese coverage + rate -> blocked (not 14-complete)", page.is_visible("#err") and err != "", err)
    landed_shown = page.text_content("#v-landed").strip()
    check("no $14.00 displayed as landed", landed_shown != "$14.00", landed_shown)
    page.screenshot(path=f"{OUT}/chinese-coverage-blocked.png", full_page=True)

    # --- coversBaseDuty selector (if the form exposes it) --------------------
    sel = page.locator("#coversBaseDuty")
    if sel.count() > 0:
        sel.select_option("EXCLUDED")
        page.click("#go")
        page.wait_for_timeout(700)
        err_visible2 = page.is_visible("#err")
        landed2 = page.text_content("#v-landed").strip()
        check("EXCLUDED + Chinese text computes itemized (no error, result shown)", (not err_visible2) and landed2 == "$14.00", {"errVisible": err_visible2, "landed": landed2})
        page.screenshot(path=f"{OUT}/excluded-itemized.png", full_page=True)
    else:
        check("form exposes coversBaseDuty selector", False, "selector missing — adapter not wired")

    browser.close()

print(json.dumps({"passed": sum(1 for r in results if r["ok"]), "failed": sum(1 for r in results if not r["ok"])}, ensure_ascii=False))
with open(f"{OUT}/e2e-results.json", "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
sys.exit(0 if all(r["ok"] for r in results) else 1)
