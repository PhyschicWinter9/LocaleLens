/** Typed envelope for extension-internal messaging (popup / background / panel / content). */
export interface Req<T = unknown> { v: 1; kind: "req"; id: string; tabId?: number; type: string; payload?: T }
export interface Res<T = unknown> {
  v: 1; kind: "res"; id: string; ok: boolean; payload?: T;
  error?: { code: string; message: string; component: string };
}
export interface Evt<T = unknown> { v: 1; kind: "evt"; type: string; tabId?: number; payload?: T }

export interface SelectionPayload {
  ref: string | null; text: string; attr?: string; tag: string;
  rect: { x: number; y: number; w: number; h: number };
}
