import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The examples, run the way somebody following the documentation would run them: as a
 * separate process, importing the package by its published name. Compiling them proves
 * the types; only running them proves the answers the comments promise.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

describe("examples", () => {
  it("basic.ts prints only answers it agrees with", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "examples/basic.ts"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.typecheck.json" },
    });
    const lines = output.trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line, line).toMatch(/ ok$/);
  }, 30_000);
});
