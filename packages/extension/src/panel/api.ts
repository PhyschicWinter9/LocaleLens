import { logEvt, parseRef, rpc, RpcError } from "../common.ts";

export { logEvt, parseRef, rpc, RpcError };

const params = new URLSearchParams(location.search);
/** Inside DevTools we know the inspected tab; as a standalone page (popup shortcut / tests) it comes from the URL. */
export const tabId: number = (typeof chrome !== "undefined" && chrome.devtools?.inspectedWindow?.tabId) || Number(params.get("inspectedTabId")) || -1;
export const initialTab = params.get("tab") ?? "inspector";

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return rpc<T>("bg.agent.call", { method, path, body, timeoutMs });
}
export async function page<T = any>(type: string, payload?: unknown, timeoutMs = 5000): Promise<T> {
  if (tabId < 0) throw new RpcError("NO_TAB", "No inspected tab. Open this panel from DevTools of your app tab.", "panel");
  return rpc<T>("bg.toTab", { tabId, type, payload, timeoutMs }, { timeoutMs: timeoutMs + 3000 });
}
export const plog = (level: "DEBUG" | "INFO" | "WARN" | "ERROR", event: string, extra: Parameters<typeof logEvt>[3] = {}) => logEvt("panel", level, event, extra);

export const REDACT = /(Bearer\s+)[A-Za-z0-9._~+/=-]+|\bll_[A-Za-z0-9_-]{20,}\b/g;
export const sanitizeText = (s: string) => s.replace(REDACT, (_m, p) => (p ? p + "[redacted]" : "[redacted]"));

export function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
