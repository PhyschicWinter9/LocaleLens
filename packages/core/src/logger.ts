export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";
export interface LogEntry {
  ts: string; level: Level; component: string; event: string;
  requestId?: string; correlationId?: string; session?: string; operation?: string;
  durationMs?: number; errorCode?: string; data?: Record<string, unknown>;
}
type Extra = Partial<Omit<LogEntry, "ts" | "level" | "event" | "component">>;

const SECRET_KEY = /token|authorization|cookie|secret|password/i;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const LL_TOKEN = /\bll_[A-Za-z0-9_-]{20,}\b/g;

/** Redacts secrets and truncates long strings (never log whole source files). */
export function sanitize(v: unknown, depth = 0): unknown {
  if (typeof v === "string") {
    const s = v.replace(BEARER, "$1[redacted]").replace(LL_TOKEN, "[redacted]");
    return s.length > 300 ? s.slice(0, 300) + `…(+${s.length - 300})` : s;
  }
  if (v == null || typeof v !== "object") return v;
  if (depth > 4) return "[depth]";
  if (v instanceof Error) return { name: v.name, message: sanitize(v.message) };
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitize(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitize(x, depth + 1);
  return out;
}

export class Logger {
  private buf: LogEntry[] = [];
  constructor(private component: string, private opts: { max?: number; sink?: (e: LogEntry) => void; session?: string } = {}) {}
  log(level: Level, event: string, extra: Extra = {}) {
    const e: LogEntry = { ts: new Date().toISOString(), level, component: this.component, event, session: this.opts.session, ...extra };
    if (e.data) e.data = sanitize(e.data) as Record<string, unknown>;
    this.buf.push(e);
    if (this.buf.length > (this.opts.max ?? 500)) this.buf.shift();
    this.opts.sink?.(e);
    return e;
  }
  debug = (ev: string, x?: Extra) => this.log("DEBUG", ev, x);
  info = (ev: string, x?: Extra) => this.log("INFO", ev, x);
  warn = (ev: string, x?: Extra) => this.log("WARN", ev, x);
  error = (ev: string, x?: Extra) => this.log("ERROR", ev, x);
  entries(): LogEntry[] { return [...this.buf]; }
  clear() { this.buf = []; }
}
