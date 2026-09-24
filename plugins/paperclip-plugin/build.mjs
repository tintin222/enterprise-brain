// Bundles the plugin for Paperclip: node worker + manifest, and a single ESM UI file whose
// react / react-dom / plugin-sdk/ui imports stay bare (the host rewrites them to its own copies).
import { build } from "esbuild";

const common = { bundle: true, format: "esm", sourcemap: false, logLevel: "info" };

await build({ ...common, entryPoints: ["src/worker.ts"], outfile: "dist/worker.js", platform: "node", target: "node22" });
await build({ ...common, entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js", platform: "node", target: "node22" });
await build({
  ...common,
  entryPoints: ["src/ui/index.tsx"],
  outfile: "dist/ui/index.js",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime", "@paperclipai/plugin-sdk/ui"],
});
