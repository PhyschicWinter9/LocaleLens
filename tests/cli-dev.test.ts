import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BIN = path.resolve(import.meta.dirname, "../packages/cli/dist/bin.js");

describe("localelens dev -- <command>", () => {
  it("runs the child with arguments intact (spaces, quotes), exposes the agent URL, then stops the agent and removes the session file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-dev-"));
    fs.mkdirSync(path.join(root, "src/locales/en"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/locales/en/common.json"), "{}");
    fs.writeFileSync(path.join(root, "localelens.config.json"), JSON.stringify({ workspaces: [{ id: "app", root: "src/locales", pattern: "{locale}/{ns}.json" }] }));
    const r = spawnSync(process.execPath, [BIN, "dev", "--port", "0", "--cwd", root, "--", process.execPath, "-e", 'console.log("ARG[" + process.argv.length + "] url=" + process.env.LOCALELENS_AGENT_URL + " msg=" + "two words")'], { encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/ARG\[\d+\] url=http:\/\/127\.0\.0\.1:\d+ msg=two words/);
    expect(fs.existsSync(path.join(root, ".localelens/session.json"))).toBe(false);
  });
});
