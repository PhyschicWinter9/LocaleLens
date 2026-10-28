import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import {
  API_PREFIX, CONFIG_FILE, EXTENSION_ID, ConfigSchema, STATE_DIR, CommitReq, LlError, LookupReq, Logger, PreviewReq, ResolveReq,
  SuggestReq, UndoReq, randomId, sanitize, type LocaleLensConfig, type LogEntry,
} from "@localelens/core";
import { AgentService } from "./service.ts";
import { Exchange } from "./exchange.ts";

/** Pinned id of the bundled extension (derived from the public key in its manifest). Overridable via config. */
export const BUNDLED_EXTENSION_ID = EXTENSION_ID;
export const VERSION = "0.7.0";

export interface AgentOptions {
  root: string;
  cfg: LocaleLensConfig;
  port?: number;
  token?: string;
  host?: string;
  /** Extension origins allowed in addition to cfg.extensionIds. */
  allowedExtensionIds?: string[];
  /** When true, any chrome-extension:// origin with a valid token is accepted (dev convenience, default false). */
  anyExtension?: boolean;
  log?: Logger;
}

const MAX_BODY = 1_000_000;
const LogIngest = z.object({ entries: z.array(z.object({
  ts: z.string().max(40), level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]), component: z.string().max(40), event: z.string().max(80),
  requestId: z.string().max(60).optional(), correlationId: z.string().max(60).optional(), durationMs: z.number().optional(),
  errorCode: z.string().max(40).optional(), data: z.record(z.string(), z.unknown()).optional(),
})).max(100) });
const Resolution = z.union([z.literal("current"), z.literal("incoming"), z.object({ custom: z.string().max(10000) })]);
const ExportReq = z.object({ workspaceIds: z.array(z.string()).optional(), namespaces: z.array(z.string()).optional(), locales: z.array(z.string()).optional(), format: z.enum(["xlsx", "zip"]).default("zip") });
const ImportPreviewReq = z.object({ dataBase64: z.string().max(36_000_000) });
const ImportCommitReq = z.object({ importId: z.string().max(40), resolutions: z.record(z.string(), Resolution).default({}) });
const EditorReq = z.object({ fileId: z.string().regex(/^[a-f0-9]{8}$/), line: z.number().int().min(1).max(1_000_000) });

export class DevAgent {
  readonly token: string;
  readonly log: Logger;
  readonly service: AgentService;
  readonly exchange: Exchange;
  readonly extLog = new Logger("extension", { max: 500 });
  private server?: http.Server;
  // ponytail: one global failure window (loopback is a single trust domain); per-client buckets if remote access is ever added
  private failures: number[] = [];
  private counters = { requests: 0, errors: 0, authFailures: 0 };
  private startedAt = Date.now();
  port = 0;

  constructor(private opts: AgentOptions) {
    this.token = opts.token ?? "ll_" + randomId(24);
    this.log = opts.log ?? new Logger("agent", { max: 1000 });
    this.service = new AgentService(opts.root, opts.cfg, this.log);
    this.exchange = new Exchange(this.service);
  }

  private allowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true; // absence is allowed ONLY because the token is mandatory (see authenticate)
    if (origin.startsWith("chrome-extension://")) {
      if (this.opts.anyExtension) return true;
      const id = origin.slice("chrome-extension://".length).replace(/\/$/, "");
      return [BUNDLED_EXTENSION_ID, ...this.opts.cfg.extensionIds, ...(this.opts.allowedExtensionIds ?? [])].filter(Boolean).includes(id);
    }
    return false; // web pages never talk to the agent directly
  }

  private hostOk(host: string | undefined) {
    if (!host) return false;
    return /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);
  }

  private authenticate(req: http.IncomingMessage) {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= 20) throw new LlError("RATE_LIMITED", "Too many failed authentications; wait a minute.", undefined, 429);
    const h = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    const given = Buffer.from(m?.[1] ?? "");
    const want = Buffer.from(this.token);
    if (!m || given.length !== want.length || !timingSafeEqual(given, want)) {
      this.failures.push(now);
      this.counters.authFailures++;
      throw new LlError("UNAUTHORIZED", "Missing or invalid session token", undefined, 401);
    }
  }

  private async body(req: http.IncomingMessage, max = MAX_BODY): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw new LlError("BAD_REQUEST", "Request body too large", undefined, 413);
      chunks.push(c as Buffer);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new LlError("BAD_REQUEST", "Body is not valid JSON"); }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestId = (req.headers["x-request-id"] as string | undefined)?.slice(0, 60).replace(/[^\w-]/g, "") || randomId(6);
    const t0 = Date.now();
    const origin = req.headers.origin;
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, payload: unknown) => {
      const b = JSON.stringify(payload);
      res.writeHead(status, {
        "content-type": "application/json", "x-request-id": requestId, "cache-control": "no-store",
        ...(origin && this.allowedOrigin(origin) ? {
          "access-control-allow-origin": origin, "vary": "Origin",
          "access-control-allow-headers": "authorization, content-type, x-request-id",
          "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-expose-headers": "x-request-id",
        } : {}),
      });
      res.end(b);
    };
    this.counters.requests++;
    try {
      if (!this.hostOk(req.headers.host)) throw new LlError("FORBIDDEN_HOST", "Host header not allowed (DNS-rebinding protection)", undefined, 403);
      if (!this.allowedOrigin(origin)) throw new LlError("FORBIDDEN_ORIGIN", "Origin not allowed", { origin }, 403);
      if (req.method === "OPTIONS") { send(204, {}); return; }
      const p = url.pathname;
      if (!p.startsWith(API_PREFIX + "/")) throw new LlError("NOT_FOUND", "Not found", undefined, 404);
      const route = p.slice(API_PREFIX.length);

      if (req.method === "GET" && route === "/health") { send(200, { ok: true, product: "localelens-agent", version: VERSION, authRequired: true }); return; }
      this.authenticate(req);

      const data = await this.dispatch(req.method ?? "GET", route, req, requestId);
      send(200, data);
      this.log.debug("http.request", { requestId, operation: `${req.method} ${route}`, durationMs: Date.now() - t0 });
    } catch (e) {
      this.counters.errors++;
      let err: LlError;
      if (e instanceof LlError) err = e;
      else if (e instanceof ZodError) err = new LlError("BAD_REQUEST", "Invalid request: " + e.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      else err = new LlError("INTERNAL", "Internal error", undefined, 500);
      const level = err.status >= 500 ? "error" : "warn";
      this.log[level]("http.error", { requestId, operation: `${req.method} ${url.pathname}`, errorCode: err.code, durationMs: Date.now() - t0, data: { message: err.message, internal: err.code === "INTERNAL" ? String((e as Error)?.stack ?? e).slice(0, 500) : undefined } });
      send(err.status, { error: { code: err.code, message: err.message, details: sanitize(err.details) }, requestId });
    }
  }

  private async dispatch(method: string, route: string, req: http.IncomingMessage, requestId: string): Promise<unknown> {
    const s = this.service;
    const key = `${method} ${route}`;
    const readBody = () => this.body(req);
    switch (key) {
      case "GET /status":
        return {
          product: "localelens-agent", version: VERSION, project: path.basename(this.opts.root), framework: this.opts.cfg.framework,
          provider: this.opts.cfg.provider, sourceLocale: this.opts.cfg.sourceLocale, defaultNamespace: this.opts.cfg.defaultNamespace,
          devOrigins: this.opts.cfg.devOrigins, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000), indexedFiles: s.indexedFiles,
          workspaces: this.opts.cfg.workspaces.map((w) => ({ id: w.id, root: w.root, writable: w.writable !== false })),
        };
      case "GET /diagnostics":
        return {
          counters: this.counters, indexedFiles: s.indexedFiles, lastWrite: s.lastWrite,
          logs: this.log.entries().slice(-150), extensionLogs: this.extLog.entries().slice(-150),
        };
      case "POST /diagnostics/log": {
        const { entries } = LogIngest.parse(await readBody());
        for (const e of entries) this.extLog.log(e.level, e.event, { ...e });
        return { accepted: entries.length };
      }
      case "POST /diagnostics/clear": this.log.clear(); this.extLog.clear(); return { ok: true };
      case "GET /workspaces": return { workspaces: await s.workspacesInfo() };
      case "GET /locales": {
        const ws = await s.workspacesInfo();
        return { locales: [...new Set(ws.flatMap((w) => w.locales))].sort(), sourceLocale: this.opts.cfg.sourceLocale };
      }
      case "POST /source/resolve": {
        this.log.info("source.resolve.started", { requestId });
        return s.resolve(ResolveReq.parse(await readBody()));
      }
      case "POST /source/editor-url": { const b = EditorReq.parse(await readBody()); return s.editorUrl(b.fileId, b.line); }
      case "GET /translations/list": return s.listTranslations();
      case "GET /scan": return s.scan();
      case "POST /translations/lookup": return s.lookup(LookupReq.parse(await readBody()));
      case "POST /keys/suggest": { const b = SuggestReq.parse(await readBody()); return s.suggest(b.text, b.namespace); }
      case "POST /changes/preview": return s.preview(PreviewReq.parse(await readBody()));
      case "POST /changes/commit": return s.commit(CommitReq.parse(await readBody()).operationId);
      case "POST /changes/undo": return s.undo(UndoReq.parse(await readBody()).transactionId);
      case "POST /translations/export": {
        const r = await this.exchange.export(ExportReq.parse(await readBody()));
        return { fileName: r.fileName, mime: r.mime, count: r.count, dataBase64: Buffer.from(r.data).toString("base64") };
      }
      case "POST /translations/import/preview": {
        const b = ImportPreviewReq.parse(await this.body(req, 40_000_000));
        return this.exchange.importPreview(new Uint8Array(Buffer.from(b.dataBase64, "base64")));
      }
      case "POST /translations/import/commit": { const b = ImportCommitReq.parse(await readBody()); return this.exchange.importCommit(b.importId, b.resolutions); }
      case "GET /changes/history": return { transactions: (await s.writer.list()).slice(0, 20).map((j) => ({ id: j.id, state: j.state, createdAt: j.createdAt, files: j.files.map((f) => f.rel) })) };
      default: throw new LlError("NOT_FOUND", `No route ${key}`, undefined, 404);
    }
  }

  async start(): Promise<{ port: number; token: string }> {
    // File locks are in-process, so exactly one agent may own a project (see docs/ARCHITECTURE.md).
    try {
      const prev = JSON.parse(await fsp.readFile(path.join(this.opts.root, STATE_DIR, "session.json"), "utf8"));
      if (prev.pid && prev.pid !== process.pid) {
        let alive = true;
        try { process.kill(prev.pid, 0); } catch (e: any) { alive = e?.code === "EPERM"; }
        if (alive) throw new LlError("BAD_REQUEST", `Another LocaleLens agent (pid ${prev.pid}, port ${prev.port}) is already running for this project. Stop it first.`);
      }
    } catch (e) {
      if (e instanceof LlError) throw e; // no/unreadable session file: stale, continue
    }
    const recovered = await this.service.writer.recover();
    if (recovered.length) this.log.warn("transactions.recovered", { data: { ids: recovered } });
    await this.service.reindex();
    this.server = http.createServer((q, r) => void this.handle(q, r));
    this.server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port ?? this.opts.cfg.port, this.opts.host ?? "127.0.0.1", resolve);
    });
    this.port = (this.server.address() as { port: number }).port;
    const dir = path.join(this.opts.root, STATE_DIR);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "session.json"), JSON.stringify({ port: this.port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    this.log.info("agent.started", { data: { port: this.port, project: path.basename(this.opts.root) } });
    return { port: this.port, token: this.token };
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
    await fsp.rm(path.join(this.opts.root, STATE_DIR, "session.json"), { force: true });
  }
}

export async function loadConfig(root: string): Promise<LocaleLensConfig> {
  let raw: string;
  try { raw = await fsp.readFile(path.join(root, CONFIG_FILE), "utf8"); }
  catch { throw new LlError("NOT_FOUND", `${CONFIG_FILE} not found in ${root}. Run \`localelens init\`.`); }
  try { return ConfigSchema.parse(JSON.parse(raw)); }
  catch (e) { throw new LlError("BAD_REQUEST", `${CONFIG_FILE} is invalid: ${e instanceof ZodError ? e.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") : (e as Error).message}`); }
}
export type { LogEntry };
