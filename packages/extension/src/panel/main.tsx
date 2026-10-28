import { render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Evt, SelectionPayload } from "@localelens/core";
import { api, initialTab, page, parseRef, plog, rpc, tabId } from "./api.ts";
import { Changes, Diagnostics, Diff, Empty, Hardcoded, MissingKeys, Settings, Translations } from "./views.tsx";

const TABS = [
  ["overview", "Overview"], ["inspector", "Inspector"], ["translations", "Translations"], ["hardcoded", "Hardcoded"],
  ["missing", "Missing Keys"], ["changes", "Changes / Diff"], ["diagnostics", "Diagnostics"], ["settings", "Settings"],
] as const;

const errText = (e: unknown) => `${(e as any)?.message ?? e}${(e as any)?.code ? ` (${(e as any).code})` : ""}`;
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

interface Form {
  mode: "edit" | "extract";
  workspaceId: string; namespace: string; key: string; values: Record<string, string>;
  source?: { ref: { fileId: string; n: number; fp: string }; candidateId: string; text: string; attr?: string };
  existing: boolean;
}

function App() {
  const [tab, setTab] = useState<string>(initialTab);
  const [theme, setThemeState] = useState(lsGet("ll.theme", "auto"));
  const [conn, setConn] = useState<any>(null);
  const [pageInfo, setPageInfo] = useState<any>(null);
  const [workspaces, setWorkspaces] = useState<any[]>([]);
  const [sel, setSel] = useState<(SelectionPayload & { tabId?: number }) | null>(null);
  const [res, setRes] = useState<any>(null);
  const [resState, setResState] = useState<string | undefined>();
  const [resErr, setResErr] = useState("");
  const [valueHits, setValueHits] = useState<any[]>([]);
  const [candId, setCandId] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [lastWrite, setLastWrite] = useState<any>(null);
  const [scanCount, setScanCount] = useState<{ h: number; m: number } | null>(null);

  const setTheme = (t: string) => { setThemeState(t); lsSet("ll.theme", t); };
  useEffect(() => {
    const dt = typeof chrome !== "undefined" && chrome.devtools?.panels?.themeName;
    document.documentElement.dataset.theme = theme === "auto" ? (dt === "dark" ? "dark" : dt ? "light" : "") : theme;
    if (theme === "auto" && !dt) delete document.documentElement.dataset.theme;
  }, [theme]);

  // -------------------------------------------------- connection + page polling (self-healing after worker restarts)
  const refresh = useCallback(async () => {
    try { setConn(await rpc("bg.agent.status", undefined, { timeoutMs: 6000 })); }
    catch (e) { setConn({ connected: false, reason: errText(e), code: (e as any).code }); }
    try { setPageInfo({ ok: true, ...(await page("content.ping")) }); }
    catch (e) { setPageInfo({ ok: false, error: errText(e) }); }
  }, []);
  useEffect(() => { void refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);
  useEffect(() => {
    if (!conn?.connected) return;
    api("GET", "/workspaces").then((d) => setWorkspaces(d.workspaces)).catch(() => {});
  }, [conn?.connected, conn?.project]);

  // Unmapped text (props from another file, third-party components): find translations whose value equals it. Candidates only, never auto-applied.
  const valueLookup = async (text: string) => {
    const want = text.replace(/\s+/g, " ").trim();
    if (!want) return;
    try {
      const d = await api("GET", "/translations/list");
      setValueHits((d.entries ?? []).filter((e: any) => Object.values(e.values).some((v) => String(v).replace(/\s+/g, " ").trim() === want)).slice(0, 20));
    } catch { /* lookup is a best-effort hint */ }
  };

  // -------------------------------------------------- selection from the page
  const resolve = useCallback(async (refStr: string | null, text: string, attr?: string, preferCand?: string, forced?: Form["mode"]) => {
    setErr(""); setResErr(""); setValueHits([]); setRes(null); setForm(null); setPreview(null); setResult(null); setCandId("");
    const ref = parseRef(refStr);
    if (!ref) { setResState("fail"); setResErr("This text has no source mapping (not compiled by the LocaleLens plugin: production build, third-party component, or the page needs a reload after starting `localelens dev`)."); void valueLookup(text); return; }
    setResState("resolving");
    plog("INFO", "source.resolve.started", { data: { n: ref.n } });
    try {
      const r = await api("POST", "/source/resolve", { ref, text, attr });
      setRes(r); setResState("ok");
      plog("INFO", "source.resolve.completed", { data: { candidates: r.candidates.length, ambiguous: r.ambiguous } });
      const pick = r.candidates.find((c: any) => c.id === preferCand) ?? r.candidates.find((c: any) => c.confidence !== "low") ?? (r.candidates.filter((c: any) => c.translation?.canEditTranslation).length === 1 ? r.candidates.find((c: any) => c.translation?.canEditTranslation) : null) ?? null;
      if (pick) await choose(r, pick, ref, text, attr, forced);
    } catch (e) {
      setResState("fail"); setResErr(errText(e));
      plog("ERROR", "source.resolve.failed", { errorCode: (e as any).code });
    }
  }, [conn?.sourceLocale, workspaces]);

  const choose = async (r: any, c: any, ref: any, text: string, attr?: string, forced?: Form["mode"]) => {
    setCandId(c.id); setPreview(null); setResult(null); setErr("");
    const sourceLocale = conn?.sourceLocale ?? "en";
    if (c.kind === "i18n-call" && c.key) {
      // translation-only edit: needs a verified owning file entry, never a source rewrite
      const hits = c.translation?.hits ?? [];
      if (hits.length === 1) {
        const h = hits[0];
        plog("INFO", "translation.loaded", { data: { key: h.key, namespace: h.namespace, code: c.translation?.code } });
        setForm({ mode: "edit", workspaceId: h.workspaceId, namespace: h.namespace, key: h.key, values: h.values, existing: true });
      } else {
        plog("WARN", "translation.edit_unavailable", { errorCode: c.translation?.code, data: { key: c.key, hits: hits.length } });
        setForm(null);
      }
    } else if (c.canExtract) {
      setForm({
        mode: "extract", workspaceId: r.suggestedWorkspaceId ?? workspaces[0]?.id ?? "", namespace: r.suggestedNamespace ?? "common",
        key: r.suggestedKey ?? "", values: { [sourceLocale]: c.template ?? c.text }, existing: false,
        source: { ref, candidateId: c.id, text, attr },
      });
    } else setForm(null);
    void forced;
  };

  const onSelected = useCallback((p: SelectionPayload & { tabId?: number }) => {
    plog("INFO", "panel.selection_received", { data: { mapped: !!p.ref } });
    setSel(p); setTab("inspector"); setInspecting(false);
    void resolve(p.ref, p.text, p.attr);
  }, [resolve]);

  const [inspecting, setInspecting] = useState(false);
  const selRef = useRef(onSelected); selRef.current = onSelected;
  useEffect(() => {
    const h = (msg: Evt<any>, sender: chrome.runtime.MessageSender) => {
      if (msg?.v !== 1 || msg.kind !== "evt" || sender.tab?.id !== tabId) return;
      if (msg.type === "element.selected") selRef.current(msg.payload);
      if (msg.type === "inspect.changed") setInspecting(!!msg.payload?.inspecting);
    };
    chrome.runtime.onMessage.addListener(h as any);
    // panel reload recovery: the worker persisted the last selection
    rpc<any>("bg.lastSelection", { tabId }).then((s) => { if (s && Date.now() - s.at < 5 * 60_000) { setSel(s); void resolve(s.ref, s.text, s.attr); } }).catch(() => {});
    return () => chrome.runtime.onMessage.removeListener(h as any);
  }, []);

  const toggleInspect = async () => {
    setErr("");
    try {
      plog("INFO", "inspect.started");
      const r = await page("content.inspect", { on: !inspecting });
      setInspecting(r.inspecting);
      if (r.inspecting && !pageInfo?.instrumented) setErr("Inspecting, but this page has 0 instrumented elements; clicks will show “no source mapping”. Run Diagnostics → self-check.");
    } catch (e) { setErr(errText(e)); plog("ERROR", "inspect.failed", { errorCode: (e as any).code }); }
  };

  // -------------------------------------------------- edit/extract flow
  const doPreview = async () => {
    if (!form) return;
    setBusy("preview"); setErr(""); setResult(null);
    plog("INFO", "changes.preview.started");
    try {
      const values = Object.fromEntries(Object.entries(form.values).filter(([, v]) => v.trim() !== ""));
      const p = await api("POST", "/changes/preview", { mode: form.mode, workspaceId: form.workspaceId, namespace: form.namespace, key: form.key, values, source: form.source });
      setPreview(p);
      plog("INFO", "changes.preview.completed", { data: { files: p.changes.length } });
    } catch (e) { setErr(errText(e)); setPreview(null); plog("WARN", "changes.preview.failed", { errorCode: (e as any).code }); }
    finally { setBusy(""); }
  };
  const doCommit = async () => {
    if (!preview) return;
    setBusy("commit"); setErr("");
    plog("INFO", "changes.commit.started");
    try {
      const watch = page("content.watchDom", { timeoutMs: 8000 }, 9000).catch(() => null);
      const r = await api("POST", "/changes/commit", { operationId: preview.operationId });
      plog("INFO", "changes.commit.completed", { data: { transactionId: r.transactionId } });
      setLastWrite({ at: new Date().toLocaleTimeString(), ok: r.verified, transactionId: r.transactionId });
      setResult({ ...r, hmr: "waiting" }); setPreview(null);
      const w = await watch;
      setResult((x: any) => ({ ...x, hmr: w?.detected ? `Page updated (DOM change observed after ${w.ms} ms)` : "Files written, but no DOM change was observed within 8 s. Your dev server may need a manual reload." }));
    } catch (e) {
      setErr(errText(e)); setLastWrite({ at: new Date().toLocaleTimeString(), ok: false, error: errText(e) });
      plog("ERROR", "changes.commit.failed", { errorCode: (e as any).code });
    } finally { setBusy(""); }
  };
  const doUndo = async (id: string) => {
    setBusy("undo"); setErr("");
    try { await api("POST", "/changes/undo", { transactionId: id }); setResult({ undone: id }); }
    catch (e) { setErr(errText(e)); } finally { setBusy(""); }
  };
  const openEditor = async () => {
    if (!res || !sel) return;
    const ref = parseRef(sel.ref); const c = res.candidates.find((x: any) => x.id === candId);
    if (!ref) return;
    try { const u = await api("POST", "/source/editor-url", { fileId: ref.fileId, line: c?.line ?? 1 }); window.open(u.url); }
    catch (e) { setErr(errText(e)); }
  };

  const loadFromTranslation = (e: any) => {
    setSel(null); setRes(null); setPreview(null); setResult(null); setErr("");
    const ws = workspaces.find((w) => w.id === e.workspaceId)?.id ?? workspaces[0]?.id ?? "";
    setForm({ mode: "edit", workspaceId: ws, namespace: e.namespace, key: e.key, values: e.values, existing: Object.keys(e.values).length > 0 });
    setTab("inspector");
  };
  const loadFromHardcoded = (h: any) => {
    setSel({ ref: `${h.ref.fileId}:${h.ref.n}:${h.ref.fp}`, text: h.text, attr: h.attr, tag: "source", rect: { x: 0, y: 0, w: 0, h: 0 } });
    setTab("inspector");
    void resolve(`${h.ref.fileId}:${h.ref.n}:${h.ref.fp}`, h.text, h.attr, h.candidateId);
  };

  const connected = !!conn?.connected;
  const cand = res?.candidates?.find((c: any) => c.id === candId);
  const locales: string[] = (() => {
    const ws = workspaces.find((w) => w.id === form?.workspaceId);
    const s = new Set<string>([conn?.sourceLocale ?? "en", ...(ws?.locales ?? []), ...Object.keys(form?.values ?? {})]);
    return [...s];
  })();
  const nsLocked = (() => { const w = workspaces.find((x) => x.id === form?.workspaceId); return w && w.pattern && !w.pattern.includes("{ns}") ? w.namespaces?.[0] ?? null : null; })();

  const status = (
    <div class="status-line" role="status">
      <span><span class={"dot " + (connected ? "ok" : "err")} /> Agent {connected ? `· ${conn.project}` : "disconnected"}</span>
      <span><span class={"dot " + (pageInfo?.ok ? (pageInfo.instrumented ? "ok" : "warn") : "err")} /> {pageInfo?.ok ? `${pageInfo.instrumented} mapped text nodes` : "page not reachable"}</span>
      {inspecting && <span class="badge warn">inspecting…</span>}
    </div>
  );

  return (
    <>
      <div class="tabs" role="tablist" aria-label="LocaleLens">
        {TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {status}
      <main>
        {tab === "overview" && <Overview conn={conn} pageInfo={pageInfo} go={setTab} scan={scanCount} setScan={setScanCount} />}
        {tab === "inspector" && (
          <div class="cols two">
            <div class="stack" style="align-content:start">
              <div class="row">
                <button class={inspecting ? "" : "primary"} onClick={toggleInspect} disabled={!connected && !pageInfo?.ok}>{inspecting ? "Stop inspecting (Esc)" : "Inspect Text"}</button>
                {!connected && <span class="badge err">Connect the agent in the popup</span>}
              </div>
              {err && <div class="alert err" role="alert">{err}</div>}
              <div class="card"><h3>Selection</h3><div class="body">
                {!sel ? <span class="muted">Click <b>Inspect Text</b>, hover the page, click a piece of text.</span> : <>
                  <div class="sel-text">{sel.text || "(no text)"}</div>
                  <div class="row muted"><span class="mono">&lt;{sel.tag}&gt;</span>{sel.attr && <span class="badge">{sel.attr}</span>}
                    {res && <span class="mono">{res.file}{cand ? `:${cand.line}` : ""}</span>}
                    {resState === "resolving" && <span>resolving…</span>}</div>
                  {resErr && <div class="alert err" role="alert">{resErr}</div>}
                  {valueHits.length > 0 && <div class="alert warn">Translations with this exact text (not verified to be the one on screen):
                    {valueHits.map((e) => <div key={e.workspaceId + e.namespace + e.key}><button onClick={() => loadFromTranslation(e)}><span class="mono">{e.namespace}:{e.key}</span></button></div>)}</div>}
                  {res?.extractBlocked && <div class="alert warn">{res.extractBlocked}</div>}
                  {res?.ambiguous && <div class="alert warn">Several occurrences in this element match. Pick the right one; LocaleLens will not guess.</div>}
                  {res && <TranslationDetails cand={res.candidates.find((c: any) => c.id === candId)} />}
                  {res && <div class="stack" role="radiogroup" aria-label="Source occurrences">{res.candidates.map((c: any) => (
                    <div key={c.id} class="cand" role="radio" tabIndex={0} aria-checked={c.id === candId}
                      onClick={() => choose(res, c, parseRef(sel.ref), sel.text, sel.attr)} onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && choose(res, c, parseRef(sel.ref), sel.text, sel.attr)}>
                      <span class={"badge " + (c.confidence === "exact" ? "ok" : c.confidence === "pattern" ? "" : "warn")}>{c.confidence}</span>
                      <div><div>{c.kind === "i18n-call" ? <><span class="mono">{c.namespace}:{c.key ?? "?"}</span> <span class="muted">→ {c.text || (c.translation?.code ?? "no value")}</span></> : (c.template ?? c.text)}</div>
                        <div class="why">{c.kind}{c.attr ? ` · ${c.attr}` : ""} · {c.file ? `${c.file}:` : "line "}{c.line}{c.kind === "i18n-call" ? (c.translation?.canEditTranslation ? " · translation editable" : " · translation not editable") : c.canExtract ? " · extractable" : ""}{c.reason ? ` · ${c.reason}` : ""}</div></div>
                    </div>))}</div>}
                  <div class="row"><button onClick={openEditor} disabled={!res}>Open source in editor</button></div>
                </>}
              </div></div>
            </div>
            <div class="stack" style="align-content:start">
              {form ? <FormCard form={form} setForm={(f: Form) => { setForm(f); setPreview(null); }} workspaces={workspaces} locales={locales} nsLocked={nsLocked}
                busy={busy} onPreview={doPreview} onSuggest={async () => {
                  const t = form.values[conn?.sourceLocale ?? "en"] ?? ""; try { const s = await api("POST", "/keys/suggest", { text: t, namespace: form.namespace }); setForm({ ...form, key: s.key }); } catch (e) { setErr(errText(e)); }
                }} /> : <Empty>{sel && !resErr && resState !== "resolving" ? (cand?.translation?.code ? `TRANSLATION_EDIT_UNAVAILABLE: ${cand.translation.code}. ${cand.translation.message ?? ""}` : "This occurrence cannot be edited automatically. See the reason on the left; edit the source manually.") : "Select text to edit its translation."}</Empty>}
              {preview && <PreviewCard preview={preview} busy={busy} onCommit={doCommit} onCancel={() => setPreview(null)} />}
              {result && !result.undone && (
                <div class={"alert " + (result.verified ? "ok" : "err")} role="status">
                  <b>{result.verified ? "Written and verified on disk." : "Written, but verification failed."}</b> {result.files.length} file(s) · transaction <span class="mono">{result.transactionId}</span>
                  <div>{result.hmr === "waiting" ? "Waiting for the app to hot-reload…" : result.hmr}</div>
                  <button onClick={() => doUndo(result.transactionId)} disabled={busy === "undo"}>Undo</button>
                </div>)}
              {result?.undone && <div class="alert ok" role="status">Transaction {result.undone} was undone.</div>}
            </div>
          </div>)}
        {tab === "translations" && <Translations connected={connected} onEdit={loadFromTranslation} />}
        {tab === "hardcoded" && <Hardcoded connected={connected} onPick={loadFromHardcoded} />}
        {tab === "missing" && <MissingKeys connected={connected} onEdit={loadFromTranslation} />}
        {tab === "changes" && <Changes preview={preview} result={result} onUndo={doUndo} connected={connected} />}
        {tab === "diagnostics" && <Diagnostics conn={conn} pageInfo={pageInfo} selection={sel} resolveState={resState} lastWrite={lastWrite} onReconnect={refresh} />}
        {tab === "settings" && <Settings theme={theme} setTheme={setTheme} conn={conn} />}
      </main>
    </>
  );
}

function Overview({ conn, pageInfo, go, scan, setScan }: any) {
  useEffect(() => {
    if (!conn?.connected) return;
    api("GET", "/scan", undefined, 60000).then((s) => setScan({ h: s.hardcoded.length, m: s.missingKeys.length })).catch(() => {});
  }, [conn?.connected]);
  const item = (ok: boolean | null, title: string, detail: string) => (
    <li><span class={"dot " + (ok === null ? "" : ok ? "ok" : "err")} /><b>{title}</b><span class="muted">{detail}</span></li>);
  return (
    <div class="cols two">
      <div class="card"><h3>Pipeline</h3><div class="body"><ol class="steps">
        {item(conn?.connected ?? false, "Local agent", conn?.connected ? `${conn.project} · ${conn.framework} · ${conn.provider}` : conn?.reason ?? "not connected")}
        {item(pageInfo?.ok ?? false, "Content script", pageInfo?.ok ? pageInfo.url : pageInfo?.error ?? "—")}
        {item(pageInfo?.ok ? pageInfo.instrumented > 0 : null, "Instrumentation", pageInfo?.ok ? `${pageInfo.instrumented} mapped text nodes` : "—")}
        {item(conn?.connected ? conn.workspaces.length > 0 : null, "Workspaces", conn?.connected ? conn.workspaces.map((w: any) => w.id).join(", ") : "—")}
      </ol><span class="muted">A green “connected” dot only proves the token. Run the end-to-end self-check in Diagnostics.</span>
      <div class="row"><button class="primary" onClick={() => go("diagnostics")}>Open diagnostics</button><button onClick={() => go("inspector")}>Go to Inspector</button></div></div></div>
      <div class="card"><h3>Project health</h3><div class="body">
        <div class="row"><b>{scan?.h ?? "—"}</b> hardcoded strings <button class="link" onClick={() => go("hardcoded")}>review</button></div>
        <div class="row"><b>{scan?.m ?? "—"}</b> keys used but undefined <button class="link" onClick={() => go("missing")}>review</button></div>
      </div></div>
    </div>
  );
}

function FormCard({ form, setForm, workspaces, locales, nsLocked, busy, onPreview, onSuggest }: any) {
  const set = (p: Partial<Form>) => setForm({ ...form, ...p });
  const ws = workspaces.find((w: any) => w.id === form.workspaceId);
  const keyOk = /^[\w$-]+(\.[\w$-]+)*$/.test(form.key);
  return (
    <div class="card"><h3>{form.mode === "edit" ? "Edit translation" : "Extract hardcoded text"}</h3><div class="body">
      <div class="row">
        <label class="grow">Workspace<select value={form.workspaceId} onChange={(e) => set({ workspaceId: (e.target as HTMLSelectElement).value })}>
          {workspaces.map((w: any) => <option key={w.id} value={w.id} disabled={!w.writable}>{w.id} — {w.root}{w.writable ? "" : " (read-only)"}</option>)}</select></label>
        <label style="width:130px">Namespace<datalist id="ll-ns">{(ws?.namespaces ?? []).map((n: string) => <option key={n} value={n} />)}</datalist><input list="ll-ns" class="mono" value={nsLocked ?? form.namespace} disabled={!!nsLocked} onInput={(e) => set({ namespace: (e.target as HTMLInputElement).value })} /></label>
      </div>
      <label>Key<div class="row"><input class="mono grow" value={form.key} aria-invalid={!keyOk} onInput={(e) => set({ key: (e.target as HTMLInputElement).value })} readOnly={form.mode === "edit" && form.existing} />
        {form.mode === "extract" && <button type="button" onClick={onSuggest}>Suggest</button>}</div></label>
      {ws && <div class="muted">Files: <span class="mono">{ws.root}/{ws.pattern}</span></div>}
      {locales.map((l: string) => (
        <label key={l}>{l}{form.values[l] === undefined && form.mode === "edit" ? <span class="badge warn" style="margin-left:6px">missing</span> : null}
          <textarea rows={2} value={form.values[l] ?? ""} onInput={(e) => set({ values: { ...form.values, [l]: (e.target as HTMLTextAreaElement).value } })} />
        </label>))}
      <div class="row"><button class="primary" onClick={onPreview} disabled={!keyOk || !form.workspaceId || busy === "preview"}>{busy === "preview" ? "Previewing…" : "Preview changes"}</button>
        <span class="muted">Nothing is written until you apply.</span></div>
    </div></div>
  );
}

function PreviewCard({ preview, busy, onCommit, onCancel }: any) {
  return (
    <div class="card"><h3>Preview · {preview.changes.length} file(s)</h3><div class="body">
      {preview.diagnostics.map((d: any, i: number) => <div key={i} class={"alert " + (d.level === "warn" ? "warn" : "info")}>{d.message}</div>)}
      {preview.changes.map((c: any) => (
        <div key={c.file}><div class="filebar"><span class="badge">{c.kind}</span>{c.file}{c.created && <span class="badge ok">new file</span>}</div><Diff text={c.diff} /></div>))}
      <div class="row"><button class="primary" onClick={onCommit} disabled={busy === "commit"}>{busy === "commit" ? "Applying…" : "Apply changes"}</button><button onClick={onCancel}>Cancel</button></div>
    </div></div>
  );
}

render(<App />, document.getElementById("app")!);

/** Why a reference resolved (or not): provider, logical path, each owning file and per-locale status. */
function TranslationDetails({ cand }: { cand?: any }) {
  const tr = cand?.translation;
  if (!tr) return null;
  return (
    <div class="alert" aria-label="Translation resolution">
      <div><b>{tr.provider}</b> · lookup <b>{tr.lookup}</b> · on-screen <b>{tr.runtimeMatch}</b> · source <b>{cand.confidence}</b>{tr.code && <> · <span class="mono">{tr.code}</span></>}</div>
      {tr.logicalPath && <div class="muted">path <span class="mono">{tr.logicalPath}</span> · edit {tr.canEditTranslation ? "available" : "unavailable"}</div>}
      {tr.message && <div class="muted">{tr.message}</div>}
      {tr.hits.map((h: any) => (
        <div key={h.workspaceId + h.namespace + h.key} class="muted"><span class="mono">{h.workspaceId}:{h.namespace} → {h.jsonPath}</span>
          {h.locales.map((l: any) => <div key={l.locale}><span class="mono">{l.locale}</span> {l.status}{l.file ? ` · ${l.file}` : ""}</div>)}</div>
      ))}
    </div>
  );
}
