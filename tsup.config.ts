import { defineConfig } from "tsup";

/**
 * One build, five entries, shared code in chunks both of them import.
 *
 * Each entry used to be its own tsup config with `splitting: false`, which meant every
 * entry inlined its own copy of whatever it reached: twenty of the twenty-seven source
 * modules were compiled into more than one bundle, and an application that imported
 * `@osqd/jql` and `@osqd/jql/global` — the documented way to use the array methods —
 * loaded the engine twice. Building them together lets esbuild put `core`, `operators`
 * and the rest in one chunk, so the second entry imports it instead of carrying it.
 *
 * The entries themselves stay exactly as they were, because they are the published import
 * paths: `text` is the search-box front end, which a service that only receives JSON
 * queries never needs to load; `global` is the one module with a side effect, kept apart
 * so importing the engine never patches a built-in.
 *
 * The command is ESM only. No shebang: this file is a *module* — it exports `main` and
 * `run` for `@osqd/jql/cli` and never runs anything when it is loaded, which is what lets
 * the tests drive `main` with streams of their own. A shebang said otherwise, and
 * `node dist/cli.js --help` duly printed nothing and exited 0. `bin/jql.mjs` is the
 * executable: it has the shebang, and it imports this and calls `run()`.
 */
const entry = {
  index: "src/index.ts",
  text: "src/text/index.ts",
  global: "src/global.ts",
  mongo: "src/targets/mongo.ts",
};

const shared = {
  dts: false,
  sourcemap: true,
  target: "es2022",
  treeshake: true,
  clean: false,
} as const;

export default defineConfig([
  // LOAD-BEARING ORDERING: `clean: true` on the first config only. tsup runs array configs
  // sequentially, and a second clean would wipe what the first one wrote.
  //
  // The command joins the ES-module build so that it shares the same chunks — it is the
  // entry that reaches the most of the library, and on its own it was the largest file in
  // the package by some way.
  { entry: { ...entry, cli: "src/cli.ts" }, format: ["esm"], splitting: true, ...shared, clean: true },
  { entry, format: ["cjs"], splitting: true, ...shared },
]);
