import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO, scratchCopy, startRig, type Rig } from "./harness.ts";

/** HMR can abort an in-flight navigation; retry like a user pressing reload. */
async function go(page: Page, url: string) {
  for (let i = 0; i < 4; i++) { try { await page.goto(url); return; } catch (e) { if (!/ERR_ABORTED|interrupted/.test(String(e)) || i === 3) throw e; await page.waitForTimeout(1000); } }
}

interface Variant { name: string; app: string; args: string[] }
const VARIANTS: Variant[] = [
  { name: "App Router · next-intl · Turbopack (Next 16 default)", app: "playground-next-app", args: [] },
  { name: "Pages Router · react-i18next · Turbopack", app: "playground-next-pages", args: [] },
  { name: "App Router · next-intl · webpack", app: "playground-next-app", args: ["--webpack"] },
];

for (const v of VARIANTS) {
  test.describe.serial(v.name, () => {
    let rig: Rig, app: Page, panel: Page, tabId: number;
    const isApp = v.app.endsWith("app");

    test.beforeAll(async () => {
      rig = await startRig(v.app, { kind: "next", args: v.args });
      app = await rig.ctx.newPage();
      await go(app, rig.appUrl);
      await app.waitForSelector(isApp ? "#srv-hardcoded" : "#pg-hardcoded");
      tabId = await rig.sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0].id!);
      const popup = await rig.ctx.newPage();
      await popup.goto(`chrome-extension://${rig.extId}/popup.html`);
      await popup.fill("#url", rig.agentUrl);
      await popup.fill("#token", rig.token);
      await popup.click("#connectBtn");
      await expect(popup.locator("#state")).toHaveText("Connected");
      await popup.close();
      panel = await rig.ctx.newPage();
      await panel.goto(`chrome-extension://${rig.extId}/panel.html?inspectedTabId=${tabId}&tab=inspector`);
    });
    test.afterAll(async () => { await rig?.stop(); });

    const pick = async (sel: string) => {
      await app.bringToFront();
      await panel.getByRole("button", { name: "Inspect Text" }).click();
      await expect(panel.locator(".badge", { hasText: "inspecting" })).toBeVisible();
      await app.locator(sel).click();
    };

    test("SSR output is instrumented and the self-check proves every hop", async () => {
      expect(await app.locator("[data-ll]").count()).toBeGreaterThan(1);
      await panel.getByRole("tab", { name: "Diagnostics" }).click();
      await panel.getByRole("button", { name: "Run self-check" }).click();
      const steps = panel.locator(".steps li");
      await expect(steps).toHaveCount(6);
      for (let i = 0; i < 6; i++) await expect(steps.nth(i).locator(".dot")).toHaveClass(/ok/, { timeout: 30_000 });
      await panel.getByRole("tab", { name: "Inspector" }).click();
    });

    if (isApp) {
      test("Server Component text: resolves to app/page.tsx and extracts via getTranslations", async () => {
        await pick("#srv-hardcoded");
        await expect(panel.locator(".sel-text")).toHaveText("Server hardcoded text");
        await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("app/page.tsx:");
        await expect(panel.locator(".cand[aria-checked=true]")).toContainText("extractable");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        const diff = panel.locator(".diff").first();
        await expect(diff).toContainText("await getTranslations(");
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
        const src = rig.read("app/page.tsx");
        expect(src).toMatch(/<p id="srv-hardcoded">\{t\w*\("serverHardcodedText"\)\}<\/p>/);
        expect(src.match(/from "next-intl\/server"/g)!.length).toBe(1);
        expect(JSON.parse(rig.read("messages/en.json")).Common.serverHardcodedText).toBe("Server hardcoded text");
        await expect(app.locator("#srv-hardcoded")).toHaveText("Server hardcoded text", { timeout: 30_000 });
      });

      test("Server Component without any i18n gets async + getTranslations", async () => {
        await go(app, rig.appUrl + "/about");
        await app.waitForSelector("#about-title");
        await pick("#about-title");
        await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("app/about/page.tsx:");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
        const src = rig.read("app/about/page.tsx");
        expect(src).toContain("export default async function AboutPage()");
        expect(src).toContain('import { getTranslations } from "next-intl/server";');
        expect(src).toMatch(/const t = await getTranslations\("Common"\);/);
        await expect(app.locator("#about-title")).toHaveText("About us", { timeout: 30_000 });
      });

      test("Client Component: useTranslations hook + import are generated", async () => {
        await go(app, rig.appUrl + "/");
        await app.waitForSelector("#client-hardcoded");
        await pick("#client-hardcoded");
        await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("components/Counter.tsx:");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        await expect(panel.locator(".diff").first()).toContainText('useTranslations("Common")');
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
        const src = rig.read("components/Counter.tsx");
        expect(src.startsWith('"use client";')).toBe(true);
        expect(src).toContain('import { useTranslations } from "next-intl";');
        expect(src).toContain('const t = useTranslations("Common");');
        await expect(app.locator("#client-hardcoded")).toHaveText("Click me", { timeout: 30_000 });
      });

      test("edit an existing server translation → app updates → undo", async () => {
        // Turbopack hot-reloads server-side JSON in both directions. Under `next dev --webpack` Next itself does not reliably
        // watch dynamically-imported server JSON (reproducible with a plain editor save), so a manual reload is the fallback.
        const webpack = v.args.includes("--webpack");
        const settle = async (text: string) => {
          if (!webpack) return expect(app.locator("#srv-title")).toHaveText(text, { timeout: 30_000 });
          try { await expect(app.locator("#srv-title")).toHaveText(text, { timeout: 8_000 }); }
          catch {
            test.info().annotations.push({ type: "known-limitation", description: "Next webpack dev did not hot-reload server JSON; verified after manual reload" });
            await go(app, rig.appUrl + "/");
            await expect(app.locator("#srv-title")).toHaveText(text, { timeout: 15_000 });
          }
        };
        await go(app, rig.appUrl + "/");
        await app.waitForSelector("#srv-title");
        await pick("#srv-title");
        await expect(panel.locator(".cand[aria-checked=true]")).toContainText("Home:title");
        const en = panel.locator("label:has-text('en') textarea");
        await expect(en).toHaveValue("Home");
        await en.fill("Home sweet home");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
        await settle("Home sweet home");
        await panel.getByRole("button", { name: "Undo" }).click();
        await expect(panel.getByText(/was undone/)).toBeVisible();
        await settle("Home");
      });
    } else {
      test("Pages Router: extract text, reuse existing hook + import, attribute", async () => {
        await pick("#pg-hardcoded");
        await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("pages/index.tsx:");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
        let src = rig.read("pages/index.tsx");
        expect(src).toContain('<p id="pg-hardcoded">{t("pagesHardcodedText")}</p>');
        expect(src.match(/useTranslation\(/g)!.length).toBe(1); // reused
        await expect(app.locator("#pg-hardcoded")).toHaveText("Pages hardcoded text", { timeout: 30_000 });

        await pick("#pg-email");
        await expect(panel.locator(".sel-text")).toHaveText("Email address");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
        src = rig.read("pages/index.tsx");
        expect(src).toContain('placeholder={t("emailAddress")}');
      });

      test("edit existing translation → page updates → undo", async () => {
        await go(app, rig.appUrl + "/");
        await app.waitForSelector("#pg-title");
        await pick("#pg-title");
        await expect(panel.locator(".cand[aria-checked=true]")).toContainText("common:home.title");
        await panel.locator("label:has-text('en') textarea").fill("Home sweet home");
        await panel.getByRole("button", { name: "Preview changes" }).click();
        await panel.getByRole("button", { name: "Apply changes" }).click();
        await expect(app.locator("#pg-title")).toHaveText("Home sweet home", { timeout: 30_000 });
        await panel.getByRole("button", { name: "Undo" }).click();
        await expect(app.locator("#pg-title")).toHaveText("Home", { timeout: 30_000 });
      });
    }
  });
}

test("`next build` output contains no LocaleLens instrumentation (Pages + App)", async () => {
  test.setTimeout(300_000);
  for (const appName of ["playground-next-app", "playground-next-pages"]) {
    const dir = scratchCopy(path.join(REPO, "apps", appName));
    try {
      const r = spawnSync(process.execPath, [path.join(REPO, "node_modules/next/dist/bin/next"), "build"], { cwd: dir, encoding: "utf8", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
      expect(r.status, appName + "\n" + r.stdout.slice(-1500) + r.stderr.slice(-1500)).toBe(0);
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { if (e.name !== "cache" && e.name !== "dev" && e.name !== "diagnostics") walk(p); }
          else if (/\.(js|html|rsc|json|txt|map)$/.test(e.name) && fs.statSync(p).size < 5_000_000) { const t = fs.readFileSync(p, "utf8"); if (/data-ll|@localelens|localelens.config|loader.cjs/.test(t)) hits.push(p); }
        }
      };
      walk(path.join(dir, ".next"));
      expect(hits, `${appName} leaked: ${hits.slice(0, 3).join(", ")}`).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test.describe.serial("Hybrid project (pages/ + app/ together) · Turbopack", () => {
  let rig: Rig, app: Page, panel: Page, tabId: number;
  test.beforeAll(async () => {
    // App Router playground + a legacy Pages Router page, present before the dev server starts (Next fixes router dirs at boot)
    const base = JSON.parse(fs.readFileSync(path.join(REPO, "apps/playground-next-app/localelens.config.json"), "utf8"));
    rig = await startRig("playground-next-app", { kind: "next" }, {
      "pages/legacy.tsx": 'export default function Legacy() {\n  return <p id="legacy-text">Legacy pages text</p>;\n}\n',
      "localelens.config.json": JSON.stringify({ ...base, framework: "next-hybrid", sourceRoots: ["app", "components", "pages"] }),
    });
    app = await rig.ctx.newPage();
    await go(app, rig.appUrl + "/legacy");
    await app.waitForSelector("#legacy-text");
    tabId = await rig.sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0].id!);
    const popup = await rig.ctx.newPage();
    await popup.goto(`chrome-extension://${rig.extId}/popup.html`);
    await popup.fill("#url", rig.agentUrl); await popup.fill("#token", rig.token); await popup.click("#connectBtn");
    await expect(popup.locator("#state")).toHaveText("Connected");
    await popup.close();
    panel = await rig.ctx.newPage();
    await panel.goto(`chrome-extension://${rig.extId}/panel.html?inspectedTabId=${tabId}&tab=inspector`);
  });
  test.afterAll(async () => { await rig?.stop(); });

  test("a Pages Router file is mapped inside a project that also has app/", async () => {
    await app.bringToFront();
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await app.locator("#legacy-text").click();
    await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("pages/legacy.tsx:");
    await panel.getByRole("button", { name: "Preview changes" }).click();
    // pages/ is not a Server Component context: client hook, not getTranslations
    await expect(panel.locator(".diff").first()).toContainText('useTranslations("Common")');
    await expect(panel.locator(".diff").first()).not.toContainText("getTranslations");
  });
  test("an app/ file in the same project is still treated as a Server Component", async () => {
    await go(app, rig.appUrl + "/about");
    await app.waitForSelector("#about-title");
    await app.bringToFront();
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await app.locator("#about-title").click();
    await panel.getByRole("button", { name: "Preview changes" }).click();
    await expect(panel.locator(".diff").first()).toContainText("await getTranslations(");
  });
});
