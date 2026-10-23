import type { Plugin } from "vite";

export interface LocaleLensViteOptions {
  /** Force-disable (also: set LOCALELENS=0). */
  enabled?: boolean;
  /** Project root that matches the agent's root. Defaults to Vite's root. */
  root?: string;
}

/** Dev-server only (`apply: "serve"`): `vite build` output is untouched. */
export function localelens(options?: LocaleLensViteOptions): Plugin;
export default localelens;
