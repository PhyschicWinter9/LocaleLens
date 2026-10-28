// After `changeset version`: make the extension manifest and the VERSION constants match the CLI version.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const version = JSON.parse(read("packages/cli/package.json")).version;
// Private workspace packages keep their own version: changesets/action reads a CHANGELOG.md for every package whose package.json changed.
{
  const p = "packages/extension/manifest.json", j = JSON.parse(read(p));
  j.version = version;
  fs.writeFileSync(path.join(root, p), JSON.stringify(j, null, 2) + "\n");
}
for (const p of ["packages/dev-agent/src/server.ts", "packages/extension/src/common.ts"]) {
  const s = read(p), n = s.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`);
  if (n === s && !s.includes(`"${version}"`)) throw new Error(`VERSION constant not found in ${p}`);
  fs.writeFileSync(path.join(root, p), n);
}
console.log(`synced to ${version}`);
