# @localelens/next

Dev-only Next.js integration for [LocaleLens](https://www.npmjs.com/package/localelens). Works with the default Turbopack dev server and with `next dev --webpack`. Acts only in the dev-server phase: `next build` / `next start` are untouched.

> **Personal project, provided as-is.** LocaleLens was built to solve a problem in my own development workflow. Expect rough edges and limited testing. It **edits your source and translation files**: commit or back up first and review every diff. No warranty; support and fixes are best-effort.

```js
// next.config.mjs   (`npx localelens init` can add this for you)
import { withLocaleLens } from "@localelens/next";
export default withLocaleLens({ /* your config */ });
```
Set `LOCALELENS=0` to disable. Needs the `localelens` CLI for the rest of the workflow.

## License

GPL-3.0-only. See the LICENSE file in this package.
