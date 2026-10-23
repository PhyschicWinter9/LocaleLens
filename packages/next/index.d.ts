export interface LocaleLensNextOptions {
  /** Project root matching the agent root. Default: process.cwd(). */
  root?: string;
  /** Force-disable (also: set LOCALELENS=0). */
  enabled?: boolean;
}

type NextConfigLike = Record<string, any>;
type NextConfigInput = NextConfigLike | ((phase: string, ctx: any) => NextConfigLike | Promise<NextConfigLike>);

/** Wraps next.config. Acts only in the dev-server phase; `next build` / `next start` get your config unchanged. */
export function withLocaleLens(config?: NextConfigInput, options?: LocaleLensNextOptions): (phase: string, ctx: any) => Promise<NextConfigLike>;
export default withLocaleLens;
