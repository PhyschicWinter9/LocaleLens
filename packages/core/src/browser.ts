// Browser-safe subset of core (no node:* imports, no zod): used by the extension bundle.
export type { Req, Res, Evt, SelectionPayload } from "./messages.ts";
