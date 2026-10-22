# LocaleLens — contributor notes
- Package manager: **bun** (`bun install`, `bun run test`, `bun run build`). Node >=22.18 for runtime.
- Packages import each other as `@localelens/<name>` (tsconfig paths + vitest alias → `src/index.ts`).
- Never accept filesystem paths from the browser. Files are addressed by opaque ids (`fileId`, `workspaceId`).
- Source edits: magic-string on Babel node ranges (no regex, no regenerate).
- Status truth lives in docs/STATUS.md. Do not claim a feature there unless a test exercises it.
