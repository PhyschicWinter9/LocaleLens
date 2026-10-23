# Store listing draft (Chrome Web Store / Edge Add-ons)

Not published. This is wording to paste if you decide to. Keep the expectations paragraph; store reviewers and users both benefit from it.

**Name:** LocaleLens

**Short description (≤132 chars):**
Click text in your local dev app to edit its translations. A personal project, provided as-is.

**Detailed description:**

> LocaleLens adds a DevTools tab for developers working on React, Vite or Next.js apps. Click text on your running dev page, see which source file and translation it comes from, edit the translation, and apply the change to your local project files.
>
> **Please set your expectations.** This is a personal project, built to solve a problem in my own development workflow and shared as-is. It is not a commercially supported product. Expect rough edges and missing features. It has been tested on a limited set of setups, and I can't promise support, fixes, or compatibility with future framework or browser versions.
>
> **It edits files on your computer.** It needs a companion command-line tool (`localelens`, installed in your project) running locally. Commit or back up your work first and review every change before applying it.
>
> **Requirements:** the companion CLI and a dev-server plugin installed in your project. Without them the extension does nothing. Works with development builds only.
>
> **Privacy:** everything stays on your machine. The extension talks only to a local agent on 127.0.0.1 and to the page you are inspecting. No analytics, no remote servers, no data collection. The session token is kept in session storage and cleared when the browser closes.
>
> Open source (GPL-3.0). Bug reports and pull requests are welcome; replies may be slow.

**Single purpose statement:** Lets a developer select text on their own locally running web app and edit the matching translation files on their own machine.

**Permission justifications** (reviewers ask for each):
- `storage`: keep the local agent URL and the session token (session-only).
- `scripting`, `activeTab`, `tabs`: inject the inspector into the developer's dev tab and read its URL.
- Host permissions `http://localhost/*`, `127.0.0.1`, `[::1]`: reach the local agent and inspect local dev pages.
- Optional host permissions (`http://*/*`, `https://*/*`): requested per-site only when the user clicks "Enable on this site" for a non-localhost dev domain.

**Before submitting:** you will need a privacy policy URL (state the "no data collection" facts above), screenshots (the panel and the inspect overlay), and the extension signing key backed up (see `docs/DISTRIBUTION.md`).
