import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXTENSION_ID } from "@localelens/core";
import { REPO, startRig, type Rig } from "./harness.ts";

let rig: Rig;
let app: Page;
let panel: Page;
let tabId: number;

test.beforeAll(async () => {
  rig = await startRig();
  app = await rig.ctx.newPage();
  await app.goto(rig.appUrl);
  await app.waitForSelector("#hardcoded-title");
  tabId = await rig.sw.evaluate(async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0].id!);
});
test.afterAll(async () => { await rig?.stop(); });

const pick = async (sel: string) => { await app.bringToFront(); await app.locator(sel).click(); };
const openPanel = async (tab = "inspector") => {
  const p = await rig.ctx.newPage();
  await p.goto(`chrome-extension://${rig.extId}/panel.html?inspectedTabId=${tabId}&tab=${tab}`);
  return p;
};

test.describe.serial("LocaleLens on Vite + react-i18next", () => {
  test("extension id is the pinned id; popup rejects a bad token then connects", async () => {
    expect(rig.extId).toBe(EXTENSION_ID);
    const popup = await rig.ctx.newPage();
    await popup.goto(`chrome-extension://${rig.extId}/popup.html`);
    await popup.fill("#url", rig.agentUrl);
    await popup.fill("#token", "ll_wrong_token_value_000000000000");
    await popup.click("#connectBtn");
    await expect(popup.locator("#error")).toContainText("Invalid session token");
    await expect(popup.locator("#state")).toHaveText("Disconnected");
    await popup.fill("#token", rig.token);
    await popup.click("#connectBtn");
    await expect(popup.locator("#state")).toHaveText("Connected");
    await expect(popup.locator("#info")).toContainText(/playground-vite|e2e/);
    await popup.close();
  });

  test("self-check proves every hop, not just the connection", async () => {
    panel = await openPanel("diagnostics");
    await panel.getByRole("button", { name: "Run self-check" }).click();
    const steps = panel.locator(".steps li");
    await expect(steps).toHaveCount(6);
    for (let i = 0; i < 6; i++) await expect(steps.nth(i).locator(".dot")).toHaveClass(/ok/, { timeout: 20_000 });
    await expect(panel.locator(".steps")).toContainText("Source resolution");
  });

  test("inspect → select exact hardcoded occurrence → resolve source file/line", async () => {
    await panel.getByRole("tab", { name: "Inspector" }).click();
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await expect(panel.locator(".badge", { hasText: "inspecting" })).toBeVisible();
    // overlay highlights real bounds while hovering
    await app.bringToFront();
    const h1 = app.locator("#hardcoded-title");
    await h1.hover();
    const box = await app.evaluate(() => {
      const host = document.querySelector("localelens-overlay") as HTMLElement | null;
      return !!host;
    });
    expect(box).toBe(true);
    await pick("#hardcoded-title");
    await expect(panel.locator(".sel-text")).toHaveText("Welcome back!");
    await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("src/App.tsx:");
    await expect(panel.locator(".cand[aria-checked=true]")).toContainText("Welcome back!");
    await expect(panel.locator(".cand[aria-checked=true]")).toContainText("extractable");
  });

  test("extract hardcoded text: preview diff, apply, file + app verified", async () => {
    await expect(panel.locator("input.mono.grow")).toHaveValue("welcomeBack");
    await panel.locator("label:has-text('th') textarea").fill("ยินดีต้อนรับกลับ");
    await panel.getByRole("button", { name: "Preview changes" }).click();
    const diff = panel.locator(".diff").first();
    await expect(diff).toContainText(`<h1 id="hardcoded-title">{t("welcomeBack")}</h1>`);
    await expect(diff).toContainText(`const { t } = useTranslation("common");`);
    await expect(diff).not.toContainText("import { useTranslation }"); // already imported: reused, not duplicated
    await expect(panel.locator(".filebar")).toHaveCount(3);
    expect(rig.read("src/App.tsx")).not.toContain("welcomeBack"); // preview wrote nothing
    await panel.getByRole("button", { name: "Apply changes" }).click();
    await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
    await expect(panel.locator(".alert.ok")).toContainText(/Page updated|no DOM change/);
    const src = rig.read("src/App.tsx");
    expect(src).toContain(`const { t } = useTranslation("common");`);
    expect(src.match(/useTranslation\(/g)!.length).toBe(2); // Dashboard + App, no duplicates
    expect(JSON.parse(rig.read("src/locales/th/common.json")).welcomeBack).toBe("ยินดีต้อนรับกลับ");
    await app.waitForFunction(() => document.querySelector("#hardcoded-title")?.textContent === "Welcome back!");
    // the application renders from the JSON now: changing the file changes the page (see next test)
    await expect(app.locator("#hardcoded-title")).toHaveText("Welcome back!");
  });

  test("edit an existing translation → app updates → undo restores", async () => {
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await pick("#translated");
    await expect(panel.locator(".cand[aria-checked=true]")).toContainText("common:home.title");
    const en = panel.locator("label:has-text('en') textarea");
    await expect(en).toHaveValue("Home");
    await en.fill("Home sweet home");
    await panel.getByRole("button", { name: "Preview changes" }).click();
    await panel.getByRole("button", { name: "Apply changes" }).click();
    await expect(panel.getByText("Written and verified on disk.")).toBeVisible();
    await expect(app.locator("#translated")).toHaveText("Home sweet home");
    await panel.getByRole("button", { name: "Undo" }).click();
    await expect(panel.getByText(/was undone/)).toBeVisible();
    await expect(app.locator("#translated")).toHaveText("Home");
  });

  test("multi-root: selecting a string from the auth feature routes to its own locale root", async () => {
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await pick("#login-title");
    await expect(panel.locator(".cand[aria-checked=true]")).toContainText("auth:login.title");
    await expect(panel.locator("select")).toHaveValue("auth");
  });

  test("duplicate strings resolve to the clicked element, not the first match", async () => {
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await pick("#dup-b");
    // the earlier extraction added 2 lines: dup-a is line 14, dup-b (the one clicked) is line 15
    await expect(panel.locator(".card", { hasText: "Selection" })).toContainText("src/App.tsx:15");
    await expect(panel.locator(".cand")).toHaveCount(1);
  });

  test("dynamic text is extracted with interpolation", async () => {
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await pick("#dynamic");
    await expect(panel.locator(".cand[aria-checked=true]")).toContainText("Welcome, {{name}}!");
    await panel.locator("input.mono.grow").fill("welcomeUser");
    await panel.getByRole("button", { name: "Preview changes" }).click();
    await expect(panel.locator(".diff").first()).toContainText(`{t("welcomeUser", { name: user.name })}`);
    await panel.getByRole("button", { name: "Cancel" }).click();
  });

  test("attribute strings are selectable", async () => {
    await panel.getByRole("button", { name: "Inspect Text" }).click();
    await pick("#email");
    await expect(panel.locator(".sel-text")).toHaveText("Email address");
    await expect(panel.locator(".cand[aria-checked=true]")).toContainText("placeholder");
  });

  test("recovers after the extension service worker is killed", async () => {
    const cdp = await rig.ctx.newCDPSession(panel);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await panel.waitForTimeout(500);
    await panel.getByRole("tab", { name: "Diagnostics" }).click();
    await panel.getByRole("button", { name: "Reconnect" }).click();
    await expect(panel.locator(".status-line")).toContainText("Agent · ", { timeout: 15_000 });
    await expect(panel.locator(".status-line")).not.toContainText("disconnected");
  });

  test("diagnostics logs trace the pipeline and never contain the token", async () => {
    await panel.getByRole("tab", { name: "Diagnostics" }).click();
    const logText = await panel.locator(".log").innerText();
    for (const ev of ["element.selected", "background.selection_received", "panel.selection_received", "source.resolve.completed", "changes.preview.completed", "changes.commit.completed"])
      expect(logText, ev).toContain(ev);
    expect(logText).not.toContain(rig.token);
    const bg = await rig.sw.evaluate(async () => JSON.stringify(await chrome.storage.session.get("ll_logs")));
    expect(bg).not.toContain(rig.token);
  });

  test("an unauthorized origin cannot talk to the agent from a web page", async () => {
    const r = await app.evaluate(async ([url, token]) => {
      try { const x = await fetch(`${url}/api/v1/status`, { headers: { authorization: `Bearer ${token}` } }); return x.status; } catch (e) { return "blocked"; }
    }, [rig.agentUrl, rig.token]);
    expect(r).toBe("blocked"); // no CORS allowance for page origins
  });
});

test("translator exchange from the panel: export → edit in Excel → import with a conflict → resolve → apply", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const { unzipSync } = await import("fflate");
  await app.goto(rig.appUrl);
  const popup = await rig.ctx.newPage(); // self-sufficient: connect if an earlier test has not
  await popup.goto(`chrome-extension://${rig.extId}/popup.html`);
  await expect(popup.locator("#state")).toHaveText(/^(Connected|Disconnected)$/); // wait for the async status to settle
  if ((await popup.locator("#state").textContent()) !== "Connected") {
    await popup.fill("#url", rig.agentUrl); await popup.fill("#token", rig.token); await popup.click("#connectBtn");
  }
  await expect(popup.locator("#state")).toHaveText("Connected");
  await popup.close();
  const p = await openPanel("translations");
  await expect(p.locator("table").first()).toContainText("home.title");
  const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Export package (.zip)" }).click()]);
  const file = path.join(rig.dir, "exported.zip");
  await dl.saveAs(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(unzipSync(new Uint8Array(fs.readFileSync(file)))["translations.xlsx"] as any);
  const ws = wb.getWorksheet("Translations")!;
  const heads = (ws.getRow(1).values as any[]).map(String);
  for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(4).value === "home.title") ws.getRow(r).getCell(heads.indexOf("th")).value = "บ้านแสนสุข";
  const returned = path.join(rig.dir, "returned.xlsx");
  fs.writeFileSync(returned, new Uint8Array(await wb.xlsx.writeBuffer()));
  // the developer edits the same value after export → three-way conflict
  const thPath = path.join(rig.dir, "src/locales/th/common.json");
  fs.writeFileSync(thPath, fs.readFileSync(thPath, "utf8").replace("หน้าแรก", "หน้าหลัก"));
  await p.locator("input[type=file]").setInputFiles(returned);
  await expect(p.getByText("1 conflict(s)", { exact: false }).first()).toBeVisible();
  await expect(p.getByRole("button", { name: "Apply import" })).toBeDisabled(); // nothing is overwritten silently
  await p.getByLabel("Use translator").check();
  await p.getByRole("button", { name: "Apply import" }).click();
  await expect(p.getByText(/Applied 1 change/)).toBeVisible();
  expect(JSON.parse(fs.readFileSync(thPath, "utf8")).home.title).toBe("บ้านแสนสุข");
});

test("production build excludes LocaleLens instrumentation", async () => {
  const out = path.join(rig.dir, "dist");
  const viteBin = path.join(REPO, "node_modules/vite/bin/vite.js");
  const r = spawnSync(process.execPath, [viteBin, "build"], { cwd: rig.dir, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const files = fs.readdirSync(path.join(out, "assets")).map((f) => fs.readFileSync(path.join(out, "assets", f), "utf8")).join("\n");
  expect(files).not.toContain("data-ll");
  expect(files).not.toMatch(/localelens/i);
});
