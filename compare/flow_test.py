"""Drive the replica end-to-end in a real browser (no backend)."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    pg.goto("http://127.0.0.1:5173/sign-in", wait_until="networkidle")
    assert pg.title().startswith("Apple Account"), pg.title()
    pg.fill("#account_name_text_field", "person@example.com")
    assert pg.is_enabled("button[type=submit]")
    pg.click("button[type=submit]")
    pg.wait_for_selector("#password_text_field")
    pg.fill("#password_text_field", "hunter2")
    pg.get_by_role("button", name="Sign In").click()
    pg.wait_for_url("**/loading")
    assert pg.locator(".tk-load").count() == 1
    pg.wait_for_url("**/verify", timeout=8000)
    for i, d in enumerate("123456"):
        pg.locator("input[type=tel]").nth(i).fill(d)
    pg.get_by_role("button", name="Continue").click()
    pg.wait_for_url("**/terms")
    pg.get_by_role("button", name="Agree and Update").click()
    pg.wait_for_url("**/done", timeout=5000)
    assert pg.get_by_role("heading", name="Update Complete").count() == 1
    pg.screenshot(path="compare/shots/flow-done.png")
    print("flow ok:", pg.url)
    b.close()
