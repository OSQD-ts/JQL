/**
 * The declarations again, as a CommonJS consumer's compiler reads them.
 *
 * The package ships a `.cjs` build for every entry that has one, so `require("@osqd/jql")`
 * works — and TypeScript told every CommonJS consumer it did not. Under `node16` resolution
 * a compiler takes the `types` condition, finds `dist/index.d.ts`, sees `"type": "module"`
 * on the package, and concludes the declarations are an ES module that `require` cannot
 * reach: `TS1479`, on an import that runs perfectly. The runtime shipped and the types
 * refused it.
 *
 * The fix is one copy of the declaration tree under a directory that says what it is. The
 * files are identical — declarations do not differ between module formats — and it is
 * `dist/cjs/package.json` saying `"type": "commonjs"` that makes a compiler read them as
 * CommonJS, and makes the relative specifiers *inside* them resolve to their neighbours in
 * the same tree rather than back to the ES module ones.
 */
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const cjs = join(dist, "cjs");

/** Every declaration under `from`, copied to the same place under `to`. Walked rather than
 *  handed to `fs.cp`, which refuses a destination inside its own source. */
async function copyDeclarations(from, to) {
  let copied = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (source === cjs) continue;
    if (entry.isDirectory()) {
      copied += await copyDeclarations(source, join(to, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    await mkdir(to, { recursive: true });
    await copyFile(source, join(to, entry.name));
    copied++;
  }
  return copied;
}

await rm(cjs, { recursive: true, force: true });
await mkdir(cjs, { recursive: true });
const copied = await copyDeclarations(dist, cjs);
await writeFile(join(cjs, "package.json"), `${JSON.stringify({ type: "commonjs" }, undefined, 2)}\n`);
process.stdout.write(`${copied} declarations copied for CommonJS consumers\n`);
