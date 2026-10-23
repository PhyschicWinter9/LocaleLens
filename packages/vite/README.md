# @localelens/vite

Dev-only Vite plugin for [LocaleLens](https://www.npmjs.com/package/localelens). It tags JSX elements that contain text with a `data-ll` source reference so the LocaleLens DevTools panel can find the exact source. Runs only on `vite` (dev server); `vite build` output is untouched.

> **Personal project, provided as-is.** LocaleLens was built to solve a problem in my own development workflow. Expect rough edges and limited testing. It **edits your source and translation files**: commit or back up first and review every diff. No warranty; support and fixes are best-effort.

```ts
// vite.config.ts   (`npx localelens init` can add this for you)
import localelens from "@localelens/vite";
export default defineConfig({ plugins: [localelens(), react()] });
```
Set `LOCALELENS=0` to disable. Needs the `localelens` CLI for the rest of the workflow.

## License

GPL-3.0-only. See the LICENSE file in this package.
