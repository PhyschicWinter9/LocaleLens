# Plan & acceptance criteria

Milestones: 1 core contracts → 2 agent/auth/diagnostics → 3 extension → 4 instrument+resolve → 5 AST extract + registry →
6 preview/commit/undo → 7 Vite E2E → 8 Next → 9 Turbopack → 10 Excel/3-way → 11 CLI → 12 audit/docs.

Acceptance for each milestone = automated tests executed and recorded in docs/STATUS.md.

Source identity: the compiler adds `data-ll="<fileId>:<n>:<fp>"` to host JSX elements. The agent re-parses the file,
locates the n-th element, verifies fingerprint `fp`, and enumerates text candidates. Ambiguity => explicit candidate
choice; stale fingerprint => error. Never a guess.
