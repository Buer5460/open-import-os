"""R1.2 real-browser E2E: PER_ENTRY amortization + double-count block via the visible form."""
from playwright.sync_api import sync_playwright
import json, sys, os

BASE = "http://127.0.0.1:57931"
OUT = "/Users/mac/Downloads/外贸问题平台/open-import-os/handoff/acceptance/20261018-R1_2/screenshots"
os.makedirs(OUT, exist_ok=True)
results = []
def check(name, cond, detail=""):
    results.append({"name": name, "ok": bool(cond), "detail": str(detail)[:200]})
    print(("  ok  " if cond else "FAIL  ") + name + ("" if cond else f"  [{detail}]"))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(BASE, wait_until="networkidle")

    # --- A: PER_ENTRY 200/1000 -> 10.20 / 10200 -----------------------------
    page.fill("#unitPrice", "8")
    page.fill("#quantity", "1000")
    page.fill("#freight", "1200")
    page.fill("#customsClearance", "800")
    page.fill("#inlandFreight", "0")
    page.fill("#otherCost", "0")
    page.fill("#otherTaxes", "200")
    page.fill("#mpf", "0")
    page.fill("#hmf", "0")
    page.check("#na-insurance")
    page.check("#na-portCharges")
    page.check("#na-warehousingCost")
    page.select_option("#taxScopeMode", "MANUAL_TOTAL_SCENARIO")
    page.fill("#taxCoverage", "base duty + all surcharges, synthetic case")
    page.select_option("#taxLevel", "PER_ENTRY")
    page.click("#go")
    page.wait_for_selector("#out", state="visible", timeout=15000)
    page.wait_for_timeout(400)
    landed = page.text_content("#v-landed").strip()
    total = page.text_content("#v-total").strip()
    check("A: unit $10.20", landed == "$10.20", landed)
    check("A: batch $12,030.00? no — $10,200.00", total == "$10,200.00", total)
    page.screenshot(path=f"{OUT}/per-entry-200.png", full_page=True)

    # --- B: PER_UNIT 2 -> 12.00 / 12000 --------------------------------------
    page.select_option("#taxLevel", "PER_UNIT")
    page.fill("#otherTaxes", "2")
    page.click("#go")
    page.wait_for_timeout(500)
    check("B: unit $12.00", page.text_content("#v-landed").strip() == "$12.00", page.text_content("#v-landed"))
    check("B: batch $12,000.00", page.text_content("#v-total").strip() == "$12,000.00", page.text_content("#v-total"))

    # --- C: manual total + explicit dutyRate 25% -> blocked banner ------------
    page.fill("#dutyRatePct", "25")
    page.click("#go")
    page.wait_for_timeout(500)
    err = page.text_content("#err").strip()
    # R1.2A: the default (UNKNOWN) coverage blocks conservatively; the INCLUDED
    # choice yields the explicit double-count message. Both are hard blocks.
    check("C: double-count blocked with message", "阻断" in err and ("double-count" in err or "coversBaseDuty" in err or "重复" in err), err)
    page.screenshot(path=f"{OUT}/double-count-blocked.png", full_page=True)

    browser.close()

print(json.dumps({"passed": sum(1 for r in results if r["ok"]), "failed": sum(1 for r in results if not r["ok"])}, ensure_ascii=False))
with open(f"{OUT}/e2e-results.json", "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
sys.exit(0 if all(r["ok"] for r in results) else 1)
