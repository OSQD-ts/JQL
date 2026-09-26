import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"] as const,
  dts: false,
  sourcemap: true,
  target: "es2022",
  splitting: false,
  treeshake: true,
};

// One entry per published import path. `text` is the search-box front end, which a
// service that only receives JSON queries never needs to load; `global` is the one
// module with a side effect, kept apart so importing the engine never patches a
// built-in.
//
// LOAD-BEARING ORDERING: `clean: true` on the first config only. tsup runs array
// configs sequentially, and a second clean would wipe what the first one wrote.
export default defineConfig([
  { entry: ["src/index.ts"], clean: true, ...shared },
  { entry: { text: "src/text/index.ts" }, clean: false, ...shared },
  { entry: { global: "src/global.ts" }, clean: false, ...shared },
  { entry: { mongo: "src/targets/mongo.ts" }, clean: false, ...shared },
  // The command, ESM only. No shebang: this file is a *module* — it exports `main` and `run`
  // for `@osqd/jql/cli` and never runs anything when it is loaded, which is what lets the
  // tests drive `main` with streams of their own. A shebang said otherwise, and
  // `node dist/cli.js --help` duly printed nothing and exited 0. `bin/jql.mjs` is the
  // executable: it has the shebang, and it imports this and calls `run()`.
  { entry: { cli: "src/cli.ts" }, clean: false, ...shared, format: ["esm"] },
]);
