import type { Evt, Req, Res } from "@localelens/core";

export const VERSION = "0.5.0";
export class RpcError extends Error {
  constructor(public code: string, message: string, public component = "unknown") { super(message); }
}

const uid = () => crypto.randomUUID().slice(0, 12);

/** Send a typed request to another extension context with timeout + acknowledgement + error propagation. */
export async function rpc<T = unknown>(type: string, payload?: unknown, opts: { tabId?: number; timeoutMs?: number } = {}): Promise<T> {
  const req: Req = { v: 1, kind: "req", id: uid(), type, tabId: opts.tabId, payload };
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new RpcError("TIMEOUT", `No response to ${type} within ${timeoutMs}ms`, "messaging")), timeoutMs);
  });
  try {
    const res = (await Promise.race([chrome.runtime.sendMessage(req), timeout])) as Res<T> | undefined;
    if (!res) throw new RpcError("NO_RECEIVER", `Nobody answered ${type} (background worker not reachable)`, "messaging");
    if (!res.ok) throw new RpcError(res.error?.code ?? "ERROR", res.error?.message ?? "Request failed", res.error?.component ?? "unknown");
    return res.payload as T;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError("NO_RECEIVER", (e as Error).message || "Messaging failed", "messaging");
  } finally {
    clearTimeout(timer!);
  }
}

export const ok = <T>(req: Req, payload?: T): Res<T> => ({ v: 1, kind: "res", id: req.id, ok: true, payload });
export const fail = (req: Req, component: string, code: string, message: string): Res => ({
  v: 1, kind: "res", id: req.id, ok: false, error: { code, message, component },
});

export interface ExtLog {
  ts: string; level: "DEBUG" | "INFO" | "WARN" | "ERROR"; component: string; event: string;
  requestId?: string; durationMs?: number; errorCode?: string; data?: Record<string, unknown>;
}

/** Fire-and-forget log shipping to the background worker, which owns the persisted ring buffer. */
export function logEvt(component: string, level: ExtLog["level"], event: string, extra: Partial<ExtLog> = {}) {
  const entry: ExtLog = { ts: new Date().toISOString(), level, component, event, ...extra };
  const evt: Evt<ExtLog> = { v: 1, kind: "evt", type: "log", payload: entry };
  try { void chrome.runtime.sendMessage(evt).catch(() => {}); } catch { /* extension context invalidated */ }
}

export function parseRef(s: string | null | undefined): { fileId: string; n: number; fp: string } | null {
  const m = /^([a-f0-9]{8}):(\d+):([a-f0-9]{8})$/.exec(s ?? "");
  return m ? { fileId: m[1], n: Number(m[2]), fp: m[3] } : null;
}
