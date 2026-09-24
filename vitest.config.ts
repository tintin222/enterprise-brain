import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packagesDir = fileURLToPath(new URL("./packages", import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages straight to their TypeScript sources.
    alias: [{ find: /^@enterprise-brain\/([a-z-]+)$/, replacement: `${packagesDir}/$1/src/index.ts` }],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "plugins/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
