import { useEffect, useState } from "preact/hooks";
import { api, download, page, plog, rpc, sanitizeText, tabId } from "./api.ts";

export const Diff = ({ text }: { text: string }) => (
  <div class="diff" role="region" aria-label="diff">
    {text.split("\n").map((l, i) => <div key={i} class={l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : l.startsWith("@@") ? "h" : ""}>{l || " "}</div>)}
  </div>
);
export const Empty = ({ children }: { children: any }) => <div class="empty">{children}</div>;

const errText = (e: unknown) => `${(e as any)?.message ?? e}${(e as any)?.code ? ` (${(e as any).code})` : ""}`;

// ------------------------------------------------------------------ Translations / Missing / Hardcoded
function b64ToBlob(b64: string, mime: string) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime }); }
async function fileToB64(file: File) { const buf = new Uint8Array(await file.arrayBuffer()); let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(bin); }

function Exchange({ onDone }: { onDone: () => void }) {
  const [pv, setPv] = useState<any>(null);
  const [res, setRes] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const doExport = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api("POST", "/translations/export", { format: "zip" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(b64ToBlob(r.dataBase64, r.mime)); a.download = r.fileName; a.click();
      setMsg({ kind: "ok", text: `Exported ${r.count} keys to ${r.fileName}. Send it to translators; they only need Excel.` });
    } catch (e) { setMsg({ kind: "err", text: errText(e) }); } finally { setBusy(false); }
  };
  const doPreview = async (file: File) => {
    setBusy(true); setMsg(null); setPv(null); setRes({});
    try { setPv(await api("POST", "/translations/import/preview", { dataBase64: await fileToB64(file) }, 60000)); plog("INFO", "import.preview.completed"); }
    catch (e) { setMsg({ kind: "err", text: errText(e) }); } finally { setBusy(false); }
  };
  const doCommit = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api("POST", "/translations/import/commit", { importId: pv.importId, resolutions: res }); setMsg({ kind: "ok", text: `Applied ${r.applied} change(s) (transaction ${r.transactionId ?? "none"}). Undo from Changes / Diff.` }); setPv(null); onDone(); }
    catch (e) { setMsg({ kind: "err", text: errText(e) }); } finally { setBusy(false); }
  };
  const unresolved = pv ? pv.report.conflicts.filter((c: any) => !res[c.conflictId]) : [];
  return (
    <div class="card"><h3>Translator exchange</h3><div class="body">
      <div class="row"><button onClick={doExport} disabled={busy}>Export package (.zip)</button>
        <label class="row" style="display:inline-flex"><span class="muted">Import returned file</span><input type="file" accept=".xlsx,.zip" style="width:auto" onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void doPreview(f); }} /></label></div>
      {msg && <div class={"alert " + (msg.kind === "ok" ? "ok" : "err")} role="status">{msg.text}</div>}
      {pv && <>
        <div class="muted">{pv.report.changes.length} change(s) · {pv.report.conflicts.length} conflict(s) · {pv.report.invalid.length} invalid · {pv.report.unchanged + pv.report.alreadyApplied} unchanged{pv.hasBase ? "" : " · no base snapshot in file"}</div>
        {pv.warnings.map((w: string, i: number) => <div key={i} class="alert warn">{w}</div>)}
        {pv.report.invalid.map((i: any, k: number) => <div key={k} class="alert err"><b class="mono">{i.key}</b> [{i.locale}] {i.message}</div>)}
        {pv.report.conflicts.map((c: any) => (
          <div key={c.conflictId} class="card"><div class="filebar"><span class="badge warn">{c.reason}</span>{c.key} [{c.locale}]</div><div class="body">
            <table><tbody><tr><td class="muted">at export</td><td>{c.base ?? "—"}</td></tr><tr><td class="muted">project now</td><td>{c.current ?? "(deleted)"}</td></tr><tr><td class="muted">translator</td><td>{c.incoming}</td></tr></tbody></table>
            <div class="row" role="radiogroup" aria-label={"Resolve " + c.key}>
              {(["current", "incoming"] as const).map((v) => <label key={v} class="row" style="display:inline-flex"><input type="radio" style="width:auto" name={c.conflictId} checked={res[c.conflictId] === v} onChange={() => setRes({ ...res, [c.conflictId]: v })} />{v === "current" ? "Keep project" : "Use translator"}</label>)}
            </div></div></div>))}
        {pv.changes.map((c: any) => <div key={c.file}><div class="filebar">{c.file}{c.created && <span class="badge ok">new</span>}</div><Diff text={c.diff} /></div>)}
        <div class="row"><button class="primary" onClick={doCommit} disabled={busy || unresolved.length > 0 || (!pv.report.changes.length && !Object.keys(res).length)}>Apply import</button>
          <button onClick={() => setPv(null)}>Cancel</button>{unresolved.length > 0 && <span class="muted">Resolve {unresolved.length} conflict(s) first. Nothing is overwritten silently.</span>}</div>
      </>}
    </div></div>
  );
}

export function Translations({ connected, onEdit }: { connected: boolean; onEdit: (e: any) => void }) {
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const load = () => api("GET", "/translations/list").then((d) => { setData(d); setErr(""); }).catch((e) => setErr(errText(e)));
  useEffect(() => { if (connected) void load(); }, [connected]);
  if (!connected) return <Empty>Connect to the agent first.</Empty>;
  const rows = (data?.entries ?? []).filter((e: any) => !q || (e.key + e.namespace + Object.values(e.values).join(" ")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="stack">
      <Exchange onDone={load} />
      <div class="row"><input aria-label="Filter translations" placeholder="Filter by key or text" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style="max-width:320px" />
        <button onClick={load}>Refresh</button><span class="muted">{rows.length} entries</span></div>
      {err && <div class="alert err">{err}</div>}
      <table><thead><tr><th>Key</th><th>NS</th><th>WS</th>{(data?.locales ?? []).map((l: string) => <th key={l}>{l}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 500).map((e: any) => (
          <tr key={e.workspaceId + e.namespace + e.key} class="click" tabIndex={0} onClick={() => onEdit(e)} onKeyDown={(k) => k.key === "Enter" && onEdit(e)}>
            <td class="mono">{e.key}</td><td>{e.namespace}</td><td>{e.workspaceId}</td>
            {(data?.locales ?? []).map((l: string) => <td key={l}>{e.values[l] ?? <span class="badge warn">missing</span>}</td>)}
          </tr>))}</tbody></table>
    </div>
  );
}

export function MissingKeys({ connected, onEdit }: { connected: boolean; onEdit: (e: any) => void }) {
  const [t, setT] = useState<any>(null);
  const [scan, setScan] = useState<any>(null);
  const [err, setErr] = useState("");
  const load = () => Promise.all([api("GET", "/translations/list"), api("GET", "/scan", undefined, 60000)]).then(([a, b]) => { setT(a); setScan(b); setErr(""); }).catch((e) => setErr(errText(e)));
  useEffect(() => { if (connected) void load(); }, [connected]);
  if (!connected) return <Empty>Connect to the agent first.</Empty>;
  const partial = (t?.entries ?? []).filter((e: any) => e.missing.length);
  return (
    <div class="stack">
      <div class="row"><button onClick={load}>Rescan</button>{err && <span class="badge err">{err}</span>}</div>
      <div class="card"><h3>Keys used in code but defined nowhere ({scan?.missingKeys?.length ?? 0})</h3>
        <table><tbody>{(scan?.missingKeys ?? []).map((m: any, i: number) => (
          <tr key={i} class="click" tabIndex={0} onClick={() => onEdit({ namespace: m.namespace, key: m.key, values: {}, workspaceId: "" })}>
            <td class="mono">{m.namespace}:{m.key}</td><td class="muted">{m.file}:{m.line}</td></tr>))}</tbody></table></div>
      <div class="card"><h3>Keys missing in some locales ({partial.length})</h3>
        <table><tbody>{partial.slice(0, 300).map((e: any) => (
          <tr key={e.workspaceId + e.namespace + e.key} class="click" tabIndex={0} onClick={() => onEdit(e)}>
            <td class="mono">{e.key}</td><td>{e.namespace}</td><td>{e.missing.map((l: string) => <span class="badge warn" key={l}>{l}</span>)}</td></tr>))}</tbody></table></div>
    </div>
  );
}

export function Hardcoded({ connected, onPick }: { connected: boolean; onPick: (h: any) => void }) {
  const [scan, setScan] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = () => { setBusy(true); return api("GET", "/scan", undefined, 60000).then((d) => { setScan(d); setErr(""); }).catch((e) => setErr(errText(e))).finally(() => setBusy(false)); };
  useEffect(() => { if (connected) void load(); }, [connected]);
  if (!connected) return <Empty>Connect to the agent first.</Empty>;
  return (
    <div class="stack">
      <div class="row"><button onClick={load} disabled={busy}>{busy ? "Scanning…" : "Rescan"}</button>
        <span class="muted">{scan?.hardcoded?.length ?? 0} hardcoded strings{scan?.truncated ? " (truncated)" : ""}</span>
        {scan?.parseErrors?.length ? <span class="badge warn">{scan.parseErrors.length} files skipped (parse errors)</span> : null}
        {err && <span class="badge err">{err}</span>}</div>
      <table><thead><tr><th>Text</th><th>Kind</th><th>Location</th><th /></tr></thead>
        <tbody>{(scan?.hardcoded ?? []).map((h: any, i: number) => (
          <tr key={i} class="click" tabIndex={0} onClick={() => h.canExtract && onPick(h)}>
            <td>{h.text}</td><td><span class="badge">{h.attr ? `${h.kind}:${h.attr}` : h.kind}</span></td>
            <td class="muted mono">{h.file}:{h.line}</td><td>{h.canExtract ? "" : <span class="badge warn" title="Not auto-extractable">manual</span>}</td></tr>))}</tbody></table>
    </div>
  );
}

// ------------------------------------------------------------------ Changes
export function Changes({ preview, result, onUndo, connected }: { preview: any; result: any; onUndo: (id: string) => void; connected: boolean }) {
  const [hist, setHist] = useState<any[]>([]);
  const load = () => api("GET", "/changes/history").then((d) => setHist(d.transactions)).catch(() => {});
  useEffect(() => { if (connected) void load(); }, [connected, result]);
  return (
    <div class="stack">
      {preview ? preview.changes.map((c: any) => (
        <div class="card" key={c.file}><div class="filebar"><span class="badge">{c.kind}</span>{c.file}{c.created && <span class="badge ok">new</span>}</div><Diff text={c.diff} /></div>
      )) : <Empty>No pending preview. Select text in the Inspector and choose “Preview changes”.</Empty>}
      <div class="card"><h3>Recent transactions</h3><div class="body">
        {!hist.length && <span class="muted">None yet.</span>}
        {hist.map((h) => (
          <div class="row" key={h.id}><span class="mono">{h.id}</span>
            <span class={"badge " + (h.state === "committed" ? "ok" : h.state === "undone" ? "" : "warn")}>{h.state}</span>
            <span class="muted grow">{h.files.join(", ")}</span>
            {h.state === "committed" && <button onClick={() => onUndo(h.id)}>Undo</button>}</div>))}
      </div></div>
    </div>
  );
}

// ------------------------------------------------------------------ Diagnostics
interface Step { id: string; label: string; state: "pending" | "ok" | "fail" | "skip"; detail: string }

export function Diagnostics({ conn, pageInfo, selection, resolveState, lastWrite, onReconnect }: any) {
  const [logs, setLogs] = useState<any>({ bg: [], agent: [], agentExt: [], counters: null });
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [bg, ag] = await Promise.allSettled([rpc<any>("bg.logs"), api("GET", "/diagnostics")]);
    setLogs({
      bg: bg.status === "fulfilled" ? bg.value.logs : [{ ts: new Date().toISOString(), level: "ERROR", component: "panel", event: "bg.logs.failed", data: { message: String((bg as any).reason?.message) } }],
      agent: ag.status === "fulfilled" ? ag.value.logs : [], agentExt: ag.status === "fulfilled" ? ag.value.extensionLogs : [],
      counters: ag.status === "fulfilled" ? ag.value.counters : null, agentErr: ag.status === "rejected" ? errText(ag.reason) : "",
    });
  };
  useEffect(() => { void refresh(); const t = setInterval(refresh, 4000); return () => clearInterval(t); }, []);

  const selfCheck = async () => {
    setBusy(true);
    const out: Step[] = [];
    const push = (s: Step) => { out.push(s); setSteps([...out]); };
    const run = async (id: string, label: string, fn: () => Promise<string>, skipIf = false) => {
      if (skipIf) { push({ id, label, state: "skip", detail: "skipped (previous step failed)" }); return false; }
      try { push({ id, label, state: "ok", detail: await fn() }); return true; }
      catch (e) { push({ id, label, state: "fail", detail: errText(e) }); return false; }
    };
    plog("INFO", "selfcheck.started");
    let ok = await run("bg", "Extension background", async () => `worker v${(await rpc<any>("bg.ping")).version}`);
    ok = await run("health", "Agent reachable", async () => { const s = await rpc<any>("bg.agent.status"); if (!s.agentUrl) throw new Error("Agent URL not configured"); if (!s.connected && !s.authFailed) throw new Error(s.reason); return s.agentUrl; }, !ok) && ok;
    ok = await run("auth", "Authenticated", async () => { const s = await rpc<any>("bg.agent.status"); if (!s.connected) throw new Error(s.reason ?? "Not connected"); return `project “${s.project}” · ${s.framework}/${s.provider}`; }, !ok) && ok;
    const ws = { n: 0 };
    ok = await run("ws", "Translation workspaces", async () => {
      const w = await api("GET", "/workspaces"); const files = w.workspaces.reduce((a: number, x: any) => a + x.files.length, 0); ws.n = files;
      if (!files) throw new Error("No locale files found. Check workspaces in localelens.config.json");
      return `${w.workspaces.length} workspace(s), ${files} locale file(s)`;
    }, !ok) && ok;
    const okAgent = ok;
    const cs = await run("cs", "Content script", async () => { const p = await page("content.ping"); return `${p.url}`; });
    let sample: any = null;
    const inst = await run("inst", "Runtime instrumentation", async () => {
      const p = await page("content.ping");
      if (!p.instrumented) throw new Error("0 instrumented text nodes. Is the Vite/Next plugin enabled (dev mode only) and the page reloaded after `localelens dev`?");
      sample = await page("content.sample");
      return `${p.instrumented} instrumented element(s)`;
    }, !cs);
    await run("resolve", "Source resolution (round trip)", async () => {
      const m = /^([a-f0-9]{8}):(\d+):([a-f0-9]{8})$/.exec(sample?.ref ?? "");
      if (!m) throw new Error("No sample element");
      const r = await api("POST", "/source/resolve", { ref: { fileId: m[1], n: +m[2], fp: m[3] }, text: sample.text });
      return `${r.file}:${r.candidates[0]?.line ?? "?"} · ${r.candidates.length} candidate(s)`;
    }, !(inst && okAgent));
    plog("INFO", "selfcheck.completed", { data: { failed: out.filter((s) => s.state === "fail").length } });
    setBusy(false);
    void refresh();
  };

  const all = [...logs.bg, ...logs.agent, ...logs.agentExt].sort((a: any, b: any) => a.ts.localeCompare(b.ts)).slice(-300);
  const dot = (ok: boolean | null) => <span class={"dot " + (ok === null ? "" : ok ? "ok" : "err")} />;
  const rows: [string, boolean | null, string][] = [
    ["Agent connectivity", conn?.connected ?? false, conn?.connected ? conn.agentUrl : conn?.reason ?? "—"],
    ["Authentication", conn?.connected ? true : conn?.authFailed ? false : null, conn?.connected ? "token accepted" : conn?.authFailed ? "token rejected" : "—"],
    ["Active tab", tabId >= 0, tabId >= 0 ? `#${tabId}` : "not set"],
    ["Content script", pageInfo?.ok ?? null, pageInfo?.ok ? `v${pageInfo.version}` : pageInfo?.error ?? "—"],
    ["Instrumented text nodes", pageInfo?.ok ? pageInfo.instrumented > 0 : null, pageInfo?.ok ? String(pageInfo.instrumented) : "—"],
    ["Inspect mode", null, pageInfo?.inspecting ? "on" : "off"],
    ["Last selected node", selection ? !!selection.ref : null, selection ? `${selection.tag} “${selection.text.slice(0, 30)}” ${selection.ref ? "(mapped)" : "(no source mapping)"}` : "—"],
    ["Source resolution", resolveState === "ok" ? true : resolveState === "fail" ? false : null, resolveState ?? "—"],
    ["Last file write", lastWrite ? lastWrite.ok : null, lastWrite ? `${lastWrite.at}${lastWrite.error ? " · " + lastWrite.error : ""}` : "—"],
  ];

  const bundle = () => ({
    generatedAt: new Date().toISOString(), extension: chrome.runtime.getManifest().version, userAgent: navigator.userAgent,
    connection: { connected: conn?.connected, agentUrl: conn?.agentUrl, project: conn?.project, framework: conn?.framework, reason: conn?.reason },
    page: pageInfo, selfCheck: steps, counters: logs.counters, logs: all,
  });
  const text = () => sanitizeText(JSON.stringify(bundle(), null, 2));

  return (
    <div class="stack">
      <div class="row">
        <button class="primary" onClick={selfCheck} disabled={busy}>{busy ? "Running…" : "Run self-check"}</button>
        <button onClick={refresh}>Refresh diagnostics</button>
        <button onClick={onReconnect}>Reconnect</button>
        <button onClick={() => navigator.clipboard.writeText(sanitizeText(all.map((l: any) => `${l.ts} ${l.level} ${l.component} ${l.event} ${l.errorCode ?? ""} ${l.data ? JSON.stringify(l.data) : ""}`).join("\n")))}>Copy sanitized logs</button>
        <button onClick={() => download(`localelens-diagnostics-${Date.now()}.json`, text())}>Export bundle</button>
        <button onClick={async () => { await rpc("bg.logs.clear"); await api("POST", "/diagnostics/clear", {}).catch(() => {}); void refresh(); }}>Clear logs</button>
      </div>
      <div class="cols two">
        <div class="card"><h3>Status</h3><table><tbody>{rows.map(([k, ok, d]) => <tr key={k}><td>{dot(ok)} {k}</td><td class="muted">{d}</td></tr>)}</tbody></table></div>
        <div class="card"><h3>Self-check {steps.length ? "" : "(not run)"}</h3><div class="body">
          <ol class="steps">{steps.map((s) => <li key={s.id}><span class={"dot " + (s.state === "ok" ? "ok" : s.state === "fail" ? "err" : "")} /><b>{s.label}</b><span class={s.state === "fail" ? "badge err" : "muted"}>{s.detail}</span></li>)}</ol>
          {steps.some((s) => s.state === "fail") && <div class="alert info">First failing step is the component to fix. Troubleshooting: docs/TROUBLESHOOTING.md</div>}
          {!steps.length && <span class="muted">Proves each hop: worker → agent → auth → content script → compiler instrumentation → source resolution. “Connected” alone proves only the token.</span>}
        </div></div>
      </div>
      <div class="card"><h3>Recent events {logs.agentErr && <span class="badge err">agent logs unavailable: {logs.agentErr}</span>}</h3>
        <div class="body log" style="max-height:300px;overflow:auto">{all.slice().reverse().map((l: any, i: number) => (
          <div key={i} class={l.level[0]}>{l.ts.slice(11, 23)} {l.level.padEnd(5)} [{l.component}] {l.event}{l.errorCode ? ` ${l.errorCode}` : ""}{l.durationMs ? ` ${l.durationMs}ms` : ""}{l.data ? " " + sanitizeText(JSON.stringify(l.data)).slice(0, 160) : ""}</div>))}
        </div></div>
    </div>
  );
}

export function Settings({ theme, setTheme, conn }: { theme: string; setTheme: (t: string) => void; conn: any }) {
  return (
    <div class="stack" style="max-width:420px">
      <label>Theme<select value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value)}>
        <option value="auto">Match DevTools / system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <div class="kv"><div><span class="muted">Agent</span><span class="mono">{conn?.agentUrl ?? "—"}</span></div>
        <div><span class="muted">Source locale</span><span>{conn?.sourceLocale ?? "—"}</span></div>
        <div><span class="muted">Writable roots</span><span>{(conn?.workspaces ?? []).map((w: any) => w.id + (w.writable ? "" : " (read-only)")).join(", ") || "—"}</span></div></div>
      <div class="alert info">Session token lives in extension session storage only: cleared when the browser closes. Never logged or exported.</div>
    </div>
  );
}
void page;
