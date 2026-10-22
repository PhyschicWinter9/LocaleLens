import type { Evt, Req, Res, SelectionPayload } from "@localelens/core";
import { logEvt, parseRef, VERSION } from "./common.ts";

/** Guard: manifest injection + programmatic injection must not double-register. */
const G = globalThis as any;
if (!G.__localelens_cs__) {
  G.__localelens_cs__ = true;
  main();
}

function main() {
  let inspecting = false;
  let host: HTMLElement | null = null;
  let box: HTMLElement | null = null;
  let label: HTMLElement | null = null;
  let lastTarget: Target | null = null;

  interface Target { owner: Element | null; el: Element; text: string; attr?: string; rect: DOMRect }
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  // ---------------------------------------------------------------- overlay
  function ensureOverlay() {
    if (host?.isConnected) return;
    host = document.createElement("localelens-overlay");
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .box{position:fixed;box-sizing:border-box;border:1.5px solid #1f6feb;background:rgba(31,111,235,.14);border-radius:2px;display:none}
      .box.warn{border-color:#bf8700;background:rgba(191,135,0,.14)}
      .lbl{position:fixed;display:none;max-width:60vw;font:11px/1.35 ui-monospace,Consolas,monospace;color:#fff;background:#1b1f24;padding:3px 6px;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style><div class="box"></div><div class="lbl"></div>`;
    box = root.querySelector(".box");
    label = root.querySelector(".lbl");
    document.documentElement.appendChild(host);
  }
  function hideOverlay() { if (box) box.style.display = "none"; if (label) label.style.display = "none"; }
  function showOverlay(t: Target) {
    ensureOverlay();
    const r = t.rect;
    Object.assign(box!.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    box!.classList.toggle("warn", !t.owner);
    const txt = t.text.length > 40 ? t.text.slice(0, 40) + "…" : t.text;
    label!.textContent = `<${t.el.tagName.toLowerCase()}>${t.attr ? ` [${t.attr}]` : ""} “${txt}”${t.owner ? "" : "  — no source mapping"}`;
    const top = r.top > 24 ? r.top - 22 : r.bottom + 4;
    Object.assign(label!.style, { display: "block", left: Math.max(4, Math.min(r.left, innerWidth - 200)) + "px", top: top + "px" });
  }

  // ---------------------------------------------------------------- hit testing
  function caretNode(x: number, y: number): Text | null {
    const d = document as any;
    let n: Node | null = null;
    if (d.caretPositionFromPoint) n = d.caretPositionFromPoint(x, y)?.offsetNode ?? null;
    else if (d.caretRangeFromPoint) n = d.caretRangeFromPoint(x, y)?.startContainer ?? null;
    return n && n.nodeType === Node.TEXT_NODE ? (n as Text) : null;
  }
  function rangeRect(a: Node, b: Node): DOMRect {
    const r = document.createRange();
    r.setStartBefore(a); r.setEndAfter(b);
    return r.getBoundingClientRect();
  }
  function inRects(node: Node, x: number, y: number) {
    const r = document.createRange();
    r.selectNodeContents(node);
    return [...r.getClientRects()].some((c) => x >= c.left - 2 && x <= c.right + 2 && y >= c.top - 2 && y <= c.bottom + 2);
  }
  /** Contiguous text siblings form one rendered run (React splits `Hello, {name}!`; SSR inserts <!-- --> between them). */
  function runOf(t: Text): { first: Node; last: Node; text: string } {
    const nodes: Node[] = [t];
    for (let p = t.previousSibling; p && (p.nodeType === Node.TEXT_NODE || p.nodeType === Node.COMMENT_NODE); p = p.previousSibling) nodes.unshift(p);
    for (let n = t.nextSibling; n && (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE); n = n.nextSibling) nodes.push(n);
    return { first: nodes[0], last: nodes[nodes.length - 1], text: nodes.filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("") };
  }

  function targetAt(x: number, y: number): Target | null {
    const el = document.elementFromPoint(x, y);
    if (!el || el === host) return null;
    // attribute-backed text (placeholder / alt) when the element itself is the visible text
    const form = el as HTMLInputElement;
    if ((form.tagName === "INPUT" || form.tagName === "TEXTAREA") && form.placeholder && !form.value) {
      const owner = el.closest("[data-ll]");
      return { owner, el, text: norm(form.placeholder), attr: "placeholder", rect: el.getBoundingClientRect() };
    }
    if (el.tagName === "IMG" && el.getAttribute("alt")) return { owner: el.closest("[data-ll]"), el, text: norm(el.getAttribute("alt")!), attr: "alt", rect: el.getBoundingClientRect() };
    const tn = caretNode(x, y);
    if (tn && tn.textContent?.trim() && inRects(tn, x, y)) {
      const run = runOf(tn);
      const parent = tn.parentElement!;
      return { owner: parent.closest("[data-ll]"), el: parent, text: norm(run.text), rect: rangeRect(run.first, run.last) };
    }
    // Pointer is inside the element's box but not on glyphs (e.g. right of a heading): snap to its nearest own text run.
    const own = [...el.childNodes].filter((n): n is Text => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim());
    if (own.length) {
      let best: { t: Text; d: number } | null = null;
      for (const t of own) {
        const r = document.createRange();
        r.selectNodeContents(t);
        for (const c of r.getClientRects()) {
          const dx = Math.max(c.left - x, 0, x - c.right), dy = Math.max(c.top - y, 0, y - c.bottom);
          const d = Math.hypot(dx, dy);
          if (!best || d < best.d) best = { t, d };
        }
      }
      if (best) {
        const run = runOf(best.t);
        return { owner: el.closest("[data-ll]"), el, text: norm(run.text), rect: rangeRect(run.first, run.last) };
      }
    }
    for (const attr of ["aria-label", "title"]) {
      const v = el.getAttribute(attr);
      if (v?.trim() && el.closest("[data-ll]") && !el.textContent?.trim()) return { owner: el.closest("[data-ll]"), el, text: norm(v), attr, rect: el.getBoundingClientRect() };
    }
    return null;
  }

  // ---------------------------------------------------------------- inspect mode
  const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const blockers = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu", "touchstart"];
  function onMove(e: MouseEvent) {
    const t = targetAt(e.clientX, e.clientY);
    lastTarget = t;
    if (t) showOverlay(t); else hideOverlay();
  }
  function onClick(e: MouseEvent) {
    stop(e);
    const t = targetAt(e.clientX, e.clientY);
    if (!t) { logEvt("content", "WARN", "element.no_text_target", { data: { x: e.clientX, y: e.clientY } }); return; }
    const payload: SelectionPayload = {
      ref: t.owner?.getAttribute("data-ll") ?? null, text: t.text, attr: t.attr, tag: t.el.tagName.toLowerCase(),
      rect: { x: t.rect.x, y: t.rect.y, w: t.rect.width, h: t.rect.height },
    };
    logEvt("content", "INFO", "element.selected", { data: { tag: payload.tag, mapped: !!payload.ref, attr: payload.attr } });
    emit("element.selected", payload);
    setInspect(false);
  }
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") { stop(e); setInspect(false); } }
  function setInspect(on: boolean) {
    if (on === inspecting) return;
    inspecting = on;
    const add = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
    add("mousemove", onMove as EventListener, true);
    add("click", onClick as EventListener, true);
    add("keydown", onKey as EventListener, true);
    for (const t of blockers) add(t, stop, true);
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) hideOverlay();
    logEvt("content", "INFO", on ? "inspect.enabled" : "inspect.disabled");
    emit("inspect.changed", { inspecting: on });
  }

  function emit(type: string, payload: unknown) {
    const evt: Evt = { v: 1, kind: "evt", type, payload };
    try { void chrome.runtime.sendMessage(evt).catch(() => {}); } catch { /* context invalidated after extension reload */ }
  }

  // ---------------------------------------------------------------- requests from background
  const status = () => ({
    version: VERSION, url: location.origin + location.pathname, title: document.title,
    instrumented: document.querySelectorAll("[data-ll]").length, inspecting,
  });

  /** Resolve once the DOM visibly changes (HMR applied) or time out. */
  function waitForDomChange(timeoutMs: number): Promise<{ detected: boolean; ms: number }> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const mo = new MutationObserver(() => { cleanup(); resolve({ detected: true, ms: Math.round(performance.now() - t0) }); });
      const timer = setTimeout(() => { cleanup(); resolve({ detected: false, ms: Math.round(performance.now() - t0) }); }, timeoutMs);
      function cleanup() { mo.disconnect(); clearTimeout(timer); }
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-ll"] });
    });
  }

  chrome.runtime.onMessage.addListener((msg: Req, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || msg?.v !== 1 || msg.kind !== "req" || !msg.type.startsWith("content.")) return;
    const reply = (payload: unknown): Res => ({ v: 1, kind: "res", id: msg.id, ok: true, payload });
    const p = (msg.payload ?? {}) as any;
    switch (msg.type) {
      case "content.ping":
      case "content.status":
        sendResponse(reply(status()));
        return;
      case "content.inspect":
        logEvt("content", "INFO", "content_script.acknowledged", { requestId: msg.id, data: { on: !!p.on } });
        setInspect(!!p.on);
        sendResponse(reply({ inspecting }));
        return;
      case "content.sample": {
        const el = document.querySelector("[data-ll]");
        const own = el ? [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) : null;
        sendResponse(reply({ ref: el?.getAttribute("data-ll") ?? null, text: own ? norm(own.textContent!) : el ? norm(el.textContent ?? "").slice(0, 80) : "" }));
        return;
      }
      case "content.watchDom":
        void waitForDomChange(Number(p.timeoutMs) || 8000).then((r) => {
          logEvt("content", r.detected ? "INFO" : "WARN", r.detected ? "hmr.update.detected" : "hmr.update.timeout", { durationMs: r.ms });
          sendResponse(reply(r));
        });
        return true;
      default:
        sendResponse({ v: 1, kind: "res", id: msg.id, ok: false, error: { code: "UNKNOWN_REQUEST", message: msg.type, component: "content" } } satisfies Res);
    }
  });

  logEvt("content", "DEBUG", "content_script.ready", { data: { instrumented: document.querySelectorAll("[data-ll]").length } });
  void parseRef;
}
