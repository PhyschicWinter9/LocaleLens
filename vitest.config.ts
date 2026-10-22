import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const alias = Object.fromEntries(
  readdirSync("packages").map((p) => [`@localelens/${p}`, fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))]),
);

export default defineConfig({
  resolve: { alias },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, pool: "forks" },
});
