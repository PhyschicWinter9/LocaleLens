import { rpc, RpcError } from "./common.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let activeTab: chrome.tabs.Tab | undefined;

function showError(msg: string | null) {
  const el = $("error");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

async function refresh() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let st: any;
  try { st = await rpc("bg.agent.status", undefined, { timeoutMs: 6000 }); }
  catch (e) { st = { connected: false, reason: (e as RpcError).message }; }

  const pill = $("state");
  pill.textContent = st.connected ? "Connected" : "Disconnected";
  pill.className = "pill " + (st.connected ? "ok" : "err");
  if (st.agentUrl) ($("url") as HTMLInputElement).value = st.agentUrl;
  $("tokenRow").hidden = !!st.connected;
  $("connectBtn").hidden = !!st.connected;
  $("disconnectBtn").hidden = !st.connected;
  $("reconnectBtn").hidden = !st.agentUrl;

  const rows: [string, string][] = [
    ["Project", st.connected ? st.project : "—"],
    ["Framework", st.connected ? `${st.framework} · ${st.provider}` : "—"],
    ["Agent", st.connected ? `v${st.version} · up ${st.uptimeSec}s · ${st.indexedFiles} source files` : st.reason ?? "—"],
    ["Active tab", activeTab?.url ? new URL(activeTab.url).host || activeTab.url : "—"],
  ];
  $("info").innerHTML = rows.map(([k, v]) => `<div><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  if (!st.connected && st.reason && st.agentUrl) showError(st.reason);
  await checkSite();
}

async function checkSite() {
  const row = $("siteRow");
  row.hidden = true;
  if (!activeTab?.url || !activeTab.id) return;
  let u: URL;
  try { u = new URL(activeTab.url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) { row.hidden = false; $("siteMsg").textContent = "LocaleLens cannot run on this kind of page."; $("siteBtn").hidden = true; return; }
  if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost")) return;
  const { granted } = await rpc<{ granted: boolean }>("bg.siteAccess", { origin: u.origin });
  if (!granted) { row.hidden = false; $("siteMsg").textContent = `${u.host} is not a localhost origin.`; $("siteBtn").hidden = false; }
}

async function connect() {
  showError(null);
  $("connectBtn").setAttribute("disabled", "");
  try {
    await rpc("bg.agent.connect", { url: ($("url") as HTMLInputElement).value.trim(), token: ($("token") as HTMLInputElement).value.trim() });
    ($("token") as HTMLInputElement).value = "";
  } catch (e) {
    const err = e as RpcError;
    showError(err.code === "UNAUTHORIZED" ? "Invalid session token. Copy the token printed by `localelens dev`." : `${err.message} (${err.code})`);
  } finally { $("connectBtn").removeAttribute("disabled"); await refresh(); }
}

$("connect").addEventListener("submit", (e) => { e.preventDefault(); void connect(); });
$("disconnectBtn").addEventListener("click", async () => { await rpc("bg.agent.disconnect"); showError(null); await refresh(); });
$("reconnectBtn").addEventListener("click", async () => { showError(null); await refresh(); });
$("siteBtn").addEventListener("click", async () => {
  if (!activeTab?.url || !activeTab.id) return;
  const origin = new URL(activeTab.url).origin;
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (granted) { try { await rpc("bg.injectTab", { tabId: activeTab.id }); } catch (e) { showError((e as Error).message); } }
  await refresh();
});
$("diagBtn").addEventListener("click", () => {
  const q = activeTab?.id ? `?inspectedTabId=${activeTab.id}&tab=diagnostics` : "?tab=diagnostics";
  void chrome.tabs.create({ url: chrome.runtime.getURL("panel.html") + q });
});

void refresh();
