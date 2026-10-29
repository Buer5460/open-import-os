"""
R1.1-03 real-browser E2E: fill ONLY visible fields + checkboxes, click, read
the rendered values. No JSON/JS injection. Uses the system Chrome (Playwright
does not ship a chromium for mac13).
"""
from playwright.sync_api import sync_playwright
import json, sys

BASE = "http://127.0.0.1:57931"
OUT = "/Users/mac/Downloads/外贸问题平台/open-import-os/handoff/acceptance/20261018-R1_1/screenshots"

results = []
def check(name, cond, detail=""):
    results.append({"name": name, "ok": bool(cond), "detail": str(detail)[:200]})
    print(("  ok  " if cond else "FAIL  ") + name + ("" if cond else f"  [{detail}]"))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(BASE, wait_until="networkidle")

    # --- golden scenario via visible fields only ---------------------------
    page.fill("#unitPrice", "8.00")
    page.fill("#quantity", "1000")
    page.fill("#freight", "1200")
    page.fill("#customsClearance", "800")
    page.fill("#inlandFreight", "0")
    page.fill("#otherCost", "0")
    page.fill("#otherTaxes", "2.00")
    page.fill("#mpf", "0")
    page.fill("#hmf", "0")
    page.check("#na-insurance")
    page.check("#na-portCharges")
    page.check("#na-warehousingCost")
    page.select_option("#taxScopeMode", "MANUAL_TOTAL_SCENARIO")
    page.fill("#taxCoverage", "含基础关税+全部附加税（合成样例）")
    page.fill("#salesPrice", "19.90")
    page.fill("#platformFeePct", "0")
    page.fill("#paymentFeePct", "0")
    page.fill("#otherVariableFeePct", "0")
    page.fill("#fulfillmentFee", "5.00")
    page.fill("#adSpendPerUnit", "0")
    page.fill("#otherFixedFee", "0")

    page.click("#go")
    page.wait_for_selector("#out", state="visible", timeout=15000)
    page.wait_for_timeout(400)

    landed = page.text_content("#v-landed").strip()
    label = page.text_content("#v-landed-label").strip()
    contrib = page.text_content("#v-contrib").strip()
    margin = page.text_content("#v-margin").strip()
    clabel = page.text_content("#v-contrib-label").strip()
    note_visible = page.is_visible("#status-note")

    check("landed shows $12.00", landed == "$12.00", landed)
    check("label is 单件到仓成本 (complete)", label == "单件到仓成本", label)
    check("contribution shows $2.90", contrib == "$2.90", contrib)
    check("margin shows 14.57% (ratio fixed)", margin == "14.57%", margin)
    check("profit label is 单件贡献利润", clabel == "单件贡献利润", clabel)
    check("no incompleteness banner when complete", not note_visible)
    page.screenshot(path=f"{OUT}/golden-complete.png", full_page=True)

    # --- variant: tax 2.80 ---------------------------------------------------
    page.fill("#otherTaxes", "2.80")
    page.click("#go")
    page.wait_for_timeout(600)
    landed2 = page.text_content("#v-landed").strip()
    contrib2 = page.text_content("#v-contrib").strip()
    margin2 = page.text_content("#v-margin").strip()
    check("variant 2.80: $12.80", landed2 == "$12.80", landed2)
    check("variant 2.80: $2.10", contrib2 == "$2.10", contrib2)
    check("variant 2.80: 10.55%", margin2 == "10.55%", margin2)

    # --- variant: price 9.00 (back to tax 2.00) ------------------------------
    page.fill("#otherTaxes", "2.00")
    page.fill("#unitPrice", "9.00")
    page.click("#go")
    page.wait_for_timeout(600)
    check("variant 9.00: $13.00", page.text_content("#v-landed").strip() == "$13.00", page.text_content("#v-landed"))
    check("variant 9.00: $1.90", page.text_content("#v-contrib").strip() == "$1.90", page.text_content("#v-contrib"))
    page.screenshot(path=f"{OUT}/variant-9.png", full_page=True)

    # --- blank tax → incomplete labels + banner ------------------------------
    page.fill("#unitPrice", "8.00")
    page.fill("#otherTaxes", "")
    page.select_option("#taxScopeMode", "ITEMIZED")
    page.click("#go")
    page.wait_for_timeout(600)
    label3 = page.text_content("#v-landed-label").strip()
    note3 = page.is_visible("#status-note")
    contrib3_label = page.text_content("#v-contrib-label").strip()
    check("incomplete cost label uses 已知费用小计", "不完整" in label3, label3)
    check("banner visible with missing fields", note3)
    check("profit label marked 假设利润", "假设利润" in contrib3_label, contrib3_label)
    page.screenshot(path=f"{OUT}/incomplete-state.png", full_page=True)

    # --- entry fee 30 over 1000: batch 12030 ---------------------------------
    page.fill("#otherTaxes", "2.00")
    page.select_option("#taxScopeMode", "MANUAL_TOTAL_SCENARIO")
    page.fill("#taxCoverage", "含基础关税+全部附加税（合成样例）")
    page.fill("#mpf", "30")
    page.click("#go")
    page.wait_for_timeout(600)
    total = page.text_content("#v-total").strip()
    check("entry fee 30 → batch $12,030.00", total == "$12,030.00", total)
    page.screenshot(path=f"{OUT}/entry-fee.png", full_page=True)

    browser.close()

print(json.dumps({"passed": sum(1 for r in results if r["ok"]), "failed": sum(1 for r in results if not r["ok"])}, ensure_ascii=False))
with open(f"{OUT}/e2e-results.json", "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
sys.exit(0 if all(r["ok"] for r in results) else 1)
