import type { Evt, Req } from "@localelens/core";
import { fail, ok, VERSION, type ExtLog } from "./common.ts";

/**
 * Stateless service worker: everything durable lives in chrome.storage so a worker restart loses nothing.
 *  - storage.session: token (never written to disk), last selection per tab, log ring
 *  - storage.local:   agent URL
 */
const LOG_KEY = "ll_logs";
const MAX_LOGS = 400;
let logQueue: Promise<void> = Promise.resolve();
let lastFlush = 0;

const session = chrome.storage.session;
const local = chrome.storage.local;

function appendLog(e: ExtLog) {
  logQueue = logQueue
    .then(async () => {
      const cur = ((await session.get(LOG_KEY))[LOG_KEY] as ExtLog[] | undefined) ?? [];
      cur.push(e);
      await session.set({ [LOG_KEY]: cur.slice(-MAX_LOGS) });
    })
    .catch(() => {});
  return logQueue;
}
const blog = (level: ExtLog["level"], event: string, extra: Partial<ExtLog> = {}) =>
  appendLog({ ts: new Date().toISOString(), level, component: "background", event, ...extra });

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/;
const PATH_OK = /^\/[a-zA-Z0-9/_-]{1,60}$/;

interface Conn { url: string; token: string }
async function getConn(): Promise<Conn | null> {
  const [{ agentUrl }, { token }] = await Promise.all([local.get("agentUrl"), session.get("token")]);
  return agentUrl && token ? { url: agentUrl as string, token: token as string } : null;
}

class AgentError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); }
}

async function agentFetch(conn: { url: string; token?: string }, method: string, p: string, body: unknown, requestId: string, timeoutMs = 10_000) {
  if (!LOOPBACK.test(conn.url)) throw new AgentError("BAD_URL", "Agent URL must be http://127.0.0.1:<port> or http://localhost:<port>");
  if (!PATH_OK.test(p)) throw new AgentError("BAD_PATH", "Invalid agent path");
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${conn.url}/api/v1${p}`, {
      method,
      headers: { "content-type": "application/json", "x-request-id": requestId, ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (e) {
    const timedOut = (e as Error).name === "TimeoutError";
    void blog("ERROR", "agent.unreachable", { requestId, errorCode: timedOut ? "AGENT_TIMEOUT" : "AGENT_UNREACHABLE", data: { path: p } });
    throw new AgentError(
      timedOut ? "AGENT_TIMEOUT" : "AGENT_UNREACHABLE",
      timedOut ? "Agent did not respond in time" : "Cannot reach the LocaleLens agent. Is `localelens dev` running?",
    );
  }
  const json: any = await res.json().catch(() => ({}));
  void blog(res.ok ? "DEBUG" : "WARN", "agent.response", { requestId, durationMs: Date.now() - t0, errorCode: json?.error?.code, data: { path: p, status: res.status } });
  if (!res.ok) throw new AgentError(json?.error?.code ?? "AGENT_ERROR", json?.error?.message ?? `Agent returned ${res.status}`, res.status);
  return json;
}

async function ensureContent(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { v: 1, kind: "req", id: "probe", type: "content.ping" });
    return;
  } catch { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    void blog("INFO", "content_script.injected", { data: { tabId } });
  } catch (e) {
    void blog("ERROR", "content_script.inject_failed", { errorCode: "CONTENT_SCRIPT_UNAVAILABLE", data: { tabId, message: (e as Error).message } });
    throw new AgentError(
      "CONTENT_SCRIPT_UNAVAILABLE",
      `Cannot run on this page (${(e as Error).message}). Use "Enable on this site" in the popup, or open your dev server on localhost.`,
    );
  }
}

async function toTab(tabId: number, type: string, payload: unknown, timeoutMs: number) {
  await ensureContent(tabId);
  const req: Req = { v: 1, kind: "req", id: crypto.randomUUID().slice(0, 12), type, tabId, payload };
  const res = await Promise.race([
    chrome.tabs.sendMessage(tabId, req),
    new Promise<never>((_, rej) => setTimeout(() => rej(new AgentError("CONTENT_TIMEOUT", `Content script did not answer ${type}`)), timeoutMs)),
  ]);
  if (!res?.ok) throw new AgentError(res?.error?.code ?? "CONTENT_ERROR", res?.error?.message ?? "Content script failed");
  return res.payload;
}

async function handle(req: Req) {
  const p = (req.payload ?? {}) as any;
  switch (req.type) {
    case "bg.ping": return { version: VERSION, at: Date.now() };
    case "bg.agent.connect": {
      const url = String(p.url ?? "").replace(/\/$/, "");
      if (!LOOPBACK.test(url)) throw new AgentError("BAD_URL", "Agent URL must look like http://127.0.0.1:4378");
      const health = await agentFetch({ url }, "GET", "/health", undefined, req.id);
      if (health.product !== "localelens-agent") throw new AgentError("NOT_AGENT", "That address is not a LocaleLens agent");
      const status = await agentFetch({ url, token: String(p.token ?? "") }, "GET", "/status", undefined, req.id);
      await Promise.all([local.set({ agentUrl: url }), session.set({ token: String(p.token) })]);
      void blog("INFO", "agent.connected", { data: { project: status.project } });
      return { connected: true, agentUrl: url, ...status };
    }
    case "bg.agent.disconnect":
      await session.remove("token");
      void blog("INFO", "agent.disconnected");
      return { connected: false };
    case "bg.agent.status": {
      const { agentUrl } = await local.get("agentUrl");
      const conn = await getConn();
      if (!conn) return { connected: false, agentUrl: agentUrl ?? null, reason: agentUrl ? "No session token (cleared when the browser closes)" : "Not configured" };
      try {
        return { connected: true, agentUrl, ...(await agentFetch(conn, "GET", "/status", undefined, req.id, 4000)) };
      } catch (e) {
        const a = e as AgentError;
        return { connected: false, agentUrl, reason: a.message, code: a.code, authFailed: a.code === "UNAUTHORIZED" };
      }
    }
    case "bg.agent.call": {
      const conn = await getConn();
      if (!conn) throw new AgentError("NOT_CONNECTED", "Not connected to the agent. Open the LocaleLens popup and connect.");
      return agentFetch(conn, p.method === "POST" ? "POST" : "GET", String(p.path), p.body, req.id, p.timeoutMs ?? 10_000);
    }
    case "bg.toTab": return toTab(Number(p.tabId), String(p.type), p.payload, p.timeoutMs ?? 5000);
    case "bg.lastSelection": {
      const k = `sel:${p.tabId}`;
      return (await session.get(k))[k] ?? null;
    }
    case "bg.logs": return { logs: ((await session.get(LOG_KEY))[LOG_KEY] as ExtLog[] | undefined) ?? [] };
    case "bg.logs.clear": await session.remove(LOG_KEY); return {};
    case "bg.flushLogs": return flushLogs(true);
    case "bg.siteAccess": return { granted: await chrome.permissions.contains({ origins: [String(p.origin) + "/*"] }) };
    case "bg.injectTab": await ensureContent(Number(p.tabId)); return { injected: true };
    default: throw new AgentError("UNKNOWN_REQUEST", `Unknown request ${req.type}`);
  }
}

async function flushLogs(force = false) {
  if (!force && Date.now() - lastFlush < 3000) return { sent: 0 };
  const conn = await getConn();
  if (!conn) return { sent: 0 };
  lastFlush = Date.now();
  const logs = (((await session.get(LOG_KEY))[LOG_KEY] as ExtLog[] | undefined) ?? []).slice(-100);
  try {
    await agentFetch(conn, "POST", "/diagnostics/log", {
      entries: logs.map(({ ts, level, component, event, requestId, durationMs, errorCode, data }) => ({ ts, level, component, event, requestId, durationMs, errorCode, data })),
    }, "logflush", 4000);
    return { sent: logs.length };
  } catch { return { sent: 0 }; }
}

chrome.runtime.onMessage.addListener((msg: Req | Evt, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || (msg as any).v !== 1) return;
  if (msg.kind === "evt") {
    const evt = msg as Evt<any>;
    const tabId = sender.tab?.id;
    if (evt.type === "log") { void appendLog(evt.payload).then(() => flushLogs()); return; }
    if (evt.type === "element.selected" && tabId !== undefined) {
      void blog("INFO", "background.selection_received", { data: { tabId, hasRef: !!evt.payload?.ref } });
      void session.set({ [`sel:${tabId}`]: { ...evt.payload, tabId, at: Date.now() } });
    }
    return; // other extension pages (panel) receive the same broadcast directly
  }
  const req = msg as Req;
  if (req.kind !== "req" || !req.type.startsWith("bg.")) return;
  handle(req).then(
    (payload) => sendResponse(ok(req, payload)),
    (e: AgentError) => {
      void blog("WARN", "request.failed", { requestId: req.id, errorCode: e.code, data: { type: req.type, message: e.message } });
      sendResponse(fail(req, "background", e.code ?? "ERROR", e.message));
    },
  );
  return true; // keep channel open for the async response
});

chrome.runtime.onInstalled.addListener(() => void blog("INFO", "worker.installed", { data: { version: VERSION } }));
void blog("DEBUG", "worker.started");
