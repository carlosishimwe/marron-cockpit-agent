import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const MOCK_DATA = JSON.parse(
  readFileSync(new URL("./fixtures/agent-data.json", import.meta.url), "utf8")
);

const PAGES = [
  { nav: "accueil", title: "État de la maison", key: "#kpiProjets" },
  { nav: "roadmap", title: "Roadmap", key: ".gantt" },
  { nav: "projets", title: "Projets", key: "table.proj" },
  { nav: "taches", title: "Tâches", key: "#tachesBody" },
  { nav: "equipe", title: "Équipe", key: "#page-equipe .cgrid" },
  { nav: "chantiers", title: "Chantiers", key: "#page-chantiers .csection" },
];

function attachConsoleGuard(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

async function mockAgentApi(page) {
  await page.route("**/api/agent", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_DATA),
    });
  });
}

async function openPage(page, nav) {
  await page.locator(`.snav a[data-nav="${nav}"]`).click();
  await expect(page.locator(`#page-${nav}`)).toHaveClass(/on/);
}

async function assertNoHorizontalOverflow(page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
  expect(overflow).toBe(false);
}

test.beforeEach(async ({ page }) => {
  await mockAgentApi(page);
});

for (const view of PAGES) {
  test(`loads ${view.nav} with key elements`, async ({ page }) => {
    const consoleErrors = attachConsoleGuard(page);
    await page.goto("/");
    await openPage(page, view.nav);

    await expect(page.locator("#barTitle")).toHaveText(view.title);
    await expect(page.locator(`#page-${view.nav} h1`)).toHaveText(view.title);
    await expect(page.locator(view.key).first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
}

test("home loads with brand and entity filters", async ({ page }) => {
  const consoleErrors = attachConsoleGuard(page);
  await page.goto("/");

  await expect(page).toHaveTitle(/MARRON/);
  await expect(page.locator(".brand .nm")).toContainText("MARRON");
  await expect(page.locator('.chip[data-chip="Tous"]')).toBeVisible();
  await expect(page.locator("#fabChat")).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("chat panel opens without console errors", async ({ page }) => {
  const consoleErrors = attachConsoleGuard(page);
  await page.goto("/");

  await page.locator("#fabChat").click();
  await expect(page.locator("#chatPanel")).toHaveClass(/on/);
  await expect(page.locator("#chatInput")).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test("mobile viewport (~380px) has no horizontal overflow on all pages", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto("/");

  for (const view of PAGES) {
    await page.locator(`.tab a[data-nav="${view.nav}"]`).click();
    await expect(page.locator(`#page-${view.nav}`)).toHaveClass(/on/);
    await assertNoHorizontalOverflow(page);
  }
});
