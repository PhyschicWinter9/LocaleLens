import { createHash, randomBytes } from "node:crypto";

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const shortHash = (s: string, n = 8) => sha256(s).slice(0, n);
export const randomId = (bytes = 16) => randomBytes(bytes).toString("base64url");
