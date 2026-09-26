/**
 * The packed tarball, installed and loaded the way a consumer would.
 *
 * Every test imports `src/` directly, so a broken `exports` map, a CommonJS build that
 * throws on load, or a `files` list that leaves something out would leave the whole suite
 * green. This packs the package, installs it into an empty project, and imports *and*
 * requires every entry in `exports`, each in its own process. Adapted from bothandlerjs.
 *
 *   npm run check:package      (builds first)
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; exports: Record<string, Record<string, string> | string> };
const scratch = mkdtempSync(join(tmpdir(), "jql-package-"));

/** What each entry must export, and one thing it must do, so "it loaded" is not the whole test. */
const PROBES: Record<string, string> = {
  ".": "if (m.compile({ a: 1 })({ a: 1 }) !== true) throw new Error('compile does not work'); if (m.fingerprint({ a: 1 }) !== m.fingerprint({ a: { $eq: 1 } })) throw new Error('fingerprint does not work'); if (m.group([{ a: 1 }], 'a')[0].count !== 1) throw new Error('group does not work');",
  "./text": "if (JSON.stringify(m.parseText('a:>1')) !== JSON.stringify({ a: { $gt: 1 } })) throw new Error('parseText does not work');",
  "./global": "if ([{ id: 2 }].jqlSearch({ id: 2 })?.id !== 2) throw new Error('the array methods are missing');",
  "./mongo": "if (JSON.stringify(m.toMongoFilter({ a: { $startsWith: 'x' } })) === undefined) throw new Error('toMongoFilter does not work'); if (!m.MONGO_CAPABILITIES.operators.includes('$eq')) throw new Error('the capabilities are missing');",
  "./cli": "if (typeof m.main !== 'function' || typeof m.run !== 'function') throw new Error('the command is missing');",
};

try {
  // `--ignore-scripts` because `npm run check:package` has already run the build, and each
  // `npm pack` would otherwise run `prepack` — which is that same build again. Three builds
  // to check one tarball is most of this script's runtime and proves nothing the first one
  // did not.
  const tarball = execFileSync("npm", ["pack", "--silent", "--ignore-scripts", "--pack-destination", scratch], { cwd: root, encoding: "utf8" }).trim().split("\n").pop() as string;
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", join(scratch, tarball)], { cwd: scratch, stdio: "inherit" });

  const entries = Object.keys(manifest.exports).filter((entry) => entry !== "./package.json");
  for (const entry of entries) {
    const specifier = entry === "." ? manifest.name : `${manifest.name}/${entry.slice(2)}`;
    const probe = PROBES[entry];
    if (probe === undefined) throw new Error(`${entry} is exported but has no probe here, so nothing checks that it works`);
    execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(specifier)}); ${probe}`], { cwd: scratch, stdio: "inherit" });
    // Only where the entry says it can be required. An entry with no `require` condition is
    // one on purpose — the command is ESM only — and probing it would test the exports map's
    // error message rather than the package.
    const conditions = manifest.exports[entry];
    const requirable = typeof conditions === "object" && conditions !== null && "require" in conditions;
    if (requirable) execFileSync(process.execPath, ["-e", `const m = require(${JSON.stringify(specifier)}); ${probe}`], { cwd: scratch, stdio: "inherit" });
    process.stdout.write(`ok  ${specifier} (${requirable ? "import and require" : "import"})\n`);
  }
  // Every binary, with --help: a `bin` pointing at a file the build stopped emitting leaves
  // the whole suite green.
  const help = execFileSync(process.execPath, [join(scratch, "node_modules", ".bin", "jql"), "--help"], { cwd: scratch, encoding: "utf8" });
  if (!help.includes("jql [options]")) throw new Error("the jql command did not print its usage");
  process.stdout.write("ok  jql --help\n");

  // The declarations, as a consumer's compiler reads them.
  //
  // Everything above checks what the package *does*; nothing checked what it promises. The
  // suite type-checks `src/`, which is not what is published — an emitted `.d.ts` that
  // referred to a type it did not export, or an `exports` map missing a `types` condition,
  // would break every consumer's build with the whole suite green. Resolution is `node16`,
  // the strict one, because that is what a modern consumer uses and it is the setting that
  // reads the `exports` map rather than guessing at file names.
  writeFileSync(
    join(scratch, "consumer.ts"),
    `import "@osqd/jql/global";
import { compile, defineVocabulary, plan, search, type Query } from "@osqd/jql";
import { parseText, toText } from "@osqd/jql/text";
import { MONGO_CAPABILITIES, toMongoFilter } from "@osqd/jql/mongo";
// Not \`@osqd/jql/cli\`: it is ES-module-only on purpose, so a CommonJS consumer is *meant*
// to be refused there, and the runtime probes above already cover it.

interface Order { id: number; status: "open" | "paid"; customer: { country: string }; lines: { sku: string }[] }
const orders: Order[] = [];

// A typed query: paths, values and operators all checked against Order.
const query: Query<Order> = { status: "open", "customer.country": "GB", lines: { $elemMatch: { sku: "pen" } } };
const open: (value: Order) => boolean = compile<Order>(query);
const first: Order | undefined = orders.find(open);

// The array methods, from the global entry, with the element type inferred.
const found: Order | undefined = orders.jqlSearch({ id: 1 });
const partial: Partial<Order>[] = orders.jqlQuery({ omit: ["customer"] });
const projected: Record<string, unknown>[] = search(orders, { where: query, fields: ["id"], sort: { id: -1 } });

// A vocabulary's computed field is a name the query may use.
const vocabulary = defineVocabulary<Order>()({ fields: { country: { path: "customer.country" }, skus: { get: (order) => order.lines.map((line) => line.sku) } } });
const named = compile<Order, { country: string; skus: string[] }>({ country: "GB" }, { vocabulary });

// The text entry, both directions, and the store split with its target.
const typed = parseText("status:open", { vocabulary });
const text: string = toText(typed, { vocabulary }).text;
const split = plan(typed, MONGO_CAPABILITIES);
const filter = split.pushed === undefined ? {} : toMongoFilter(split.pushed);
export { first, found, partial, projected, named, text, filter };
`,
  );
  /**
   * The four ways a consumer's compiler reads a package, because the answer differs in each
   * and the package promises all of them.
   *
   * `node16` is what a modern project uses, and it reads the `exports` map — including,
   * separately, the `import` and `require` conditions, which is how `require("@osqd/jql")`
   * came to work at run time while TypeScript told every CommonJS consumer it could not be
   * required (TS1479). `bundler` is what Vite and Next.js use. `node10` is the legacy mode
   * that ignores `exports` entirely and needs `typesVersions` to find a subpath at all.
   */
  const modes = [
    { name: "an ES module consumer", type: "module", module: "node16", resolution: "node16" },
    { name: "a CommonJS consumer", type: "commonjs", module: "node16", resolution: "node16" },
    { name: "a bundler's resolution", type: "module", module: "preserve", resolution: "bundler" },
    { name: "the legacy node resolution", type: "commonjs", module: "commonjs", resolution: "node10" },
  ] as const;
  const manifestPath = join(scratch, "package.json");
  const consumer = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  for (const mode of modes) {
    writeFileSync(manifestPath, JSON.stringify({ ...consumer, type: mode.type }));
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        // `skipLibCheck` because the point here is whether a consumer can *use* the
        // declarations — one this package could not emit is already a build failure — and
        // checking every library file instead takes over five minutes against these
        // recursive path types.
        compilerOptions: { target: "es2022", module: mode.module, moduleResolution: mode.resolution, strict: true, noEmit: true, skipLibCheck: true, types: [] },
        files: ["consumer.ts"],
      }),
    );
    execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(scratch, "tsconfig.json")], { cwd: scratch, stdio: "inherit" });
    process.stdout.write(`ok  the published declarations type-check for ${mode.name}\n`);
  }
  writeFileSync(manifestPath, JSON.stringify(consumer));

  // The course, run against the package a reader would have installed.
  //
  // Sixteen lessons of "paste this, you will see that" is a large promise, and the only way
  // to keep it is to run them. The checkpoints were produced this way in the first place;
  // this is what stops them drifting the next time an answer changes — two of them did
  // change while the course was being written, and only a run would have caught it.
  const course = join(root, "docs", "course");
  /**
   * Every fenced block of a page, with its language and the prose just above it.
   *
   * One pass that tracks whether it is inside a fence, because a closing ``` is
   * indistinguishable from the opening of an unlabelled block when read line by line — which
   * is exactly the kind of quiet wrongness this file exists to catch elsewhere.
   */
  const fences = (markdown: string): { language: string; body: string; before: string }[] => {
    const lines = markdown.split("\n");
    const out: { language: string; body: string; before: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.startsWith("```")) continue;
      const language = line.slice(3);
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && lines[j] !== "```"; j++) body.push(lines[j] as string);
      out.push({ language, body: body.join("\n"), before: lines.slice(Math.max(0, i - 8), i).join("\n") });
      i = j;
    }
    return out;
  };
  const lessons = readdirSync(course).filter((name) => /^\d\d-/.test(name)).sort();
  /**
   * The modules the examples import, taken from the pages that show them.
   *
   * A page introduces one by naming it in the prose just above the block — "save this as
   * `harbour/vocabulary.mjs`" — so that a reader and this script are going by the same
   * sentence. Any page may add one, which is what lets a lesson keep its examples short
   * rather than repeating fifteen lines of setup in every one of them.
   */
  const written = new Set<string>();
  for (const page of ["index.md", ...lessons]) {
    for (const held of fences(readFileSync(join(course, page), "utf8"))) {
      const named = /`harbour\/([\w-]+\.mjs)`/.exec(held.before);
      if (held.language !== "js" || named === null) continue;
      const file = named[1] as string;
      if (written.has(file)) throw new Error(`${page}: a second block claims to be ${file}, so which one the examples import is a coin toss`);
      written.add(file);
      writeFileSync(join(scratch, file), `${held.body}\n`);
    }
  }
  // Named, so that a page which stops introducing one says so, rather than every lesson
  // failing at once with a stack from Node about a module that is not there.
  for (const wanted of ["orders.mjs", "vocabulary.mjs"]) {
    if (!written.has(wanted)) throw new Error(`the course no longer introduces \`harbour/${wanted}\`, so the examples have nothing to import`);
  }
  execFileSync(process.execPath, ["-e", "import('./orders.mjs').then(({orders}) => require('node:fs').writeFileSync('orders.jsonl', orders.map(o => JSON.stringify(o)).join('\\n') + '\\n'))"], { cwd: scratch });

  /**
   * Every example, not one per page.
   *
   * The rule the course is written to: a fenced `js` block is a whole runnable program, and
   * if it prints anything the fence straight after it is exactly what it printed. That is
   * what lets a lesson be several small examples instead of one long one — each is run and
   * each is compared, so splitting a program up cannot quietly turn four fifths of a page
   * into prose nobody verifies. A block of any other language is not a claim about
   * behaviour: `json` shows a shape, `ts` is source for a compiler rather than for a run,
   * `bash` is a command to type.
   *
   * A block that prints nothing is a module the other examples import, like the order book
   * and the vocabulary. It is still run, because a fixture that throws on load takes the
   * whole page with it, but it claims nothing, so nothing has to follow it.
   */
  let ran = 0;
  let checked = 0;
  for (const lesson of lessons) {
    const markdown = readFileSync(join(course, lesson), "utf8");
    const found = fences(markdown);
    const runnable = found.filter((held) => held.language === "js");
    if (runnable.length === 0 && !/`harbour\/lesson-\d\d\.ts`/.test(markdown)) {
      throw new Error(`${lesson}: no runnable \`js\` example, so nothing here checks it`);
    }
    for (const [at, held] of found.entries()) {
      if (held.language !== "js") continue;
      const file = join(scratch, `${lesson.slice(0, 2)}-${at}.mjs`);
      writeFileSync(file, `${held.body}\n`);
      let output: string;
      try {
        output = execFileSync(process.execPath, [file], { cwd: scratch, encoding: "utf8" });
      } catch (error) {
        throw new Error(`${lesson}: an example threw\n${held.body}\n${String((error as { stderr?: string }).stderr ?? "").split("\n").slice(0, 8).join("\n")}`);
      }
      ran++;
      if (output.trim() === "") continue;
      const printed = found[at + 1];
      if (printed === undefined || printed.language !== "") {
        throw new Error(`${lesson}: an example prints something and is not followed by a block showing what, so nothing checks it:\n${held.body.split("\n")[0]}`);
      }
      if (output.replace(/\s+$/, "") !== printed.body.replace(/\s+$/, "")) {
        throw new Error(`${lesson}: an example does not print what the page says\n--- the code ---\n${held.body}\n--- the page says ---\n${printed.body}\n--- it printed ---\n${output}`);
      }
      checked++;
    }
  }
  process.stdout.write(`ok  the course: ${ran} examples run, ${checked} print what the pages say\n`);

  // `npm pack --json` reports one package two ways depending on the npm running it: an
  // array of one entry up to npm 11, an object keyed by package name from npm 12. Reading
  // only the first shape left `listed` empty on a newer npm, and the check then said
  // "conformance/cases.json is not in the package" about a file that was plainly in it —
  // a true failure for an untrue reason, which is the kind that costs an afternoon.
  const packed: unknown = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }));
  const entry = (Array.isArray(packed) ? packed[0] : Object.values(packed as Record<string, unknown>)[0]) as { files?: { path: string }[] } | undefined;
  if (entry?.files === undefined) {
    throw new Error(`npm pack --json reported a shape this script does not know how to read, so nothing here checked what the tarball holds:\n${JSON.stringify(packed).slice(0, 400)}`);
  }
  const listed = entry.files.map((file) => file.path);
  for (const required of [
    "conformance/cases.json",
    "docs/reference/specification.md",
    "dist/index.d.ts",
    "dist/global.d.ts",
    "dist/text/index.d.ts",
    // The second copy of the declarations, and the file that says what they are: without it
    // the `require` conditions point at nothing and a CommonJS consumer is back to TS1479.
    "dist/cjs/index.d.ts",
    "dist/cjs/package.json",
    "dist/cli.js",
    "bin/jql.mjs",
  ]) {
    if (!listed.includes(required)) throw new Error(`${required} is not in the package`);
  }
  process.stdout.write(`ok  the tarball carries the specification and the conformance suite\n`);

  // No module compiled into two entry points.
  //
  // Each entry used to be built on its own with splitting off, so every one of them inlined
  // whatever it reached: twenty of twenty-seven source modules were in more than one bundle,
  // and an application importing `@osqd/jql` and `@osqd/jql/global` — the documented way to
  // get the array methods — loaded the engine twice. Nothing failed, which is why it lasted:
  // it costs bytes and a second copy of every module-level value, and neither shows up in a
  // test. The source maps say exactly which module went where, so the question is cheap to
  // ask on every build.
  const carries = new Map<string, string[]>();
  for (const name of readdirSync(join(root, "dist")).filter((file) => file.endsWith(".js.map"))) {
    const map = JSON.parse(readFileSync(join(root, "dist", name), "utf8")) as { sources: string[] };
    for (const source of map.sources) {
      const module = source.replace(/^(\.\.\/)+/, "");
      if (!module.startsWith("src/")) continue;
      carries.set(module, [...(carries.get(module) ?? []), name.replace(".js.map", "")]);
    }
  }
  const twice = [...carries].filter(([, outputs]) => outputs.length > 1);
  if (twice.length > 0) {
    const worst = twice.map(([module, outputs]) => `  ${module} -> ${outputs.join(", ")}`).join("\n");
    throw new Error(`${twice.length} source module(s) are compiled into more than one output, so a consumer of two entry points loads two copies:\n${worst}`);
  }
  process.stdout.write(`ok  the entry points share their code: ${carries.size} modules, none compiled twice\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
