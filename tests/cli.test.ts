import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, type Streams } from "../src/cli.js";

/**
 * The command, tested both ways.
 *
 * In-process, by calling `main` with writers of its own, because which stream each line
 * went to is part of the contract: redirecting stdout has to produce a file worth having,
 * and every note belongs on stderr. And as a real subprocess, because that is how somebody
 * following the documentation will run it.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
let scratch: string;
let orders: string;

const LINES = [
  { id: 1, status: "open", total: 120, customer: { country: "GB", email: "ada@example.com" }, tags: ["a"] },
  { id: 2, status: "paid", total: 40, customer: { country: "US", email: "grace@example.com" }, tags: [] },
  { id: 3, status: "open", total: 15, customer: { country: "GB", email: "alan@example.com" }, tags: ["a", "b"] },
];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "jql-cli-"));
  orders = join(scratch, "orders.jsonl");
  writeFileSync(orders, `${LINES.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n\n`);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], stdin: string[] = []): Promise<Run> {
  let out = "";
  let err = "";
  const io: Streams = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdin: async function* () {
      for (const line of stdin) yield line;
    },
  };
  const code = await main(argv, io);
  return { code, out, err };
}

const rows = (out: string): unknown[] =>
  out
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);

describe("filtering from the command line", () => {
  it("writes the matches to stdout and nothing else", async () => {
    const { code, out, err } = await run(['{"status":"open"}', orders]);
    expect(code).toBe(0);
    expect(rows(out).map((row) => (row as { id: number }).id)).toEqual([1, 3]);
    // The damaged line is a note, and notes are not the artifact.
    expect(err).toContain("not JSON, skipped");
    expect(out).not.toContain("not JSON");
  });

  it("takes the search-box syntax", async () => {
    const { out } = await run(["--text", "status:open total:>100", orders]);
    expect(rows(out).map((row) => (row as { id: number }).id)).toEqual([1]);
  });

  it("sorts, pages and picks fields", async () => {
    const { out } = await run(["--sort", "total:desc", "--limit", "2", "--fields", "id,total", "{}", orders]);
    expect(rows(out)).toEqual([{ id: 1, total: 120 }, { id: 2, total: 40 }]);
  });

  it("drops fields, which is how a value stays out of a file", async () => {
    const { out } = await run(["--omit", "customer.email,tags", "--limit", "1", "{}", orders]);
    expect(out).not.toContain("example.com");
    expect(rows(out)[0]).toEqual({ id: 1, status: "open", total: 120, customer: { country: "GB" } });
  });

  it("counts, and counts by a field", async () => {
    expect((await run(["--count", '{"status":"open"}', orders])).out.trim()).toBe("2");
    const grouped = await run(["--group", "status", "{}", orders]);
    expect(rows(grouped.out)).toEqual([
      { key: "open", count: 2 },
      { key: "paid", count: 1 },
    ]);
  });

  /** A tally of everything, called a tally of the matches, would be a wrong answer in disguise. */
  it("counts by a field only what the query matches", async () => {
    const { out } = await run(["--group", "status", '{"total":{"$gt":50}}', orders]);
    expect(rows(out)).toEqual([{ key: "open", count: 1 }]);
  });

  /**
   * `--limit` was read, kept, and then never looked at on the group path, which builds its
   * own answer from the whole input. The output is groups, so that is what it limits.
   */
  it("limits the number of groups", async () => {
    const { out } = await run(["--group", "status", "--limit", "1", "{}", orders]);
    expect(rows(out)).toEqual([{ key: "open", count: 2 }]);
  });

  /**
   * `jql '{}' file` must reproduce the file. Re-serialising each match instead of writing the
   * line back out changed the data: `1e400` came back as `null`, and a thirty-digit
   * identifier — a shape every trace and snowflake id has — as `1.2345678901234568e+29`.
   * Both are `JSON.parse` and `JSON.stringify` behaving as documented, and both turn "filter
   * these lines" into "rewrite these lines".
   */
  it("writes a matching line back exactly as it arrived", async () => {
    const odd = join(scratch, "odd.jsonl");
    const written = ['{ "b": 2,  "a": 1e400,  "big": 123456789012345678901234567890 }', '{"keep":"spacing  here","z":1,"a":2}'];
    writeFileSync(odd, `${written.join("\n")}\n`);
    const { out, code } = await run(["{}", odd]);
    expect(code).toBe(0);
    expect(out.trimEnd().split("\n")).toEqual(written);
  });

  it("still lays a result out again when asked to reshape it", async () => {
    const odd = join(scratch, "odd2.jsonl");
    writeFileSync(odd, '{ "a": 1,  "b": 2 }\n');
    expect((await run(["--fields", "a", "{}", odd])).out.trim()).toBe('{"a":1}');
    expect((await run(["--pretty", "{}", odd])).out.trim()).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  /**
   * What a Windows editor and a PowerShell redirect put at the front of a UTF-8 file. It is
   * not part of the JSON, and leaving it made the first record of such a file "not JSON,
   * skipped" — a real line reported as damaged data, while every other line came through.
   */
  it("reads a file that begins with a byte-order mark", async () => {
    const marked = join(scratch, "bom.jsonl");
    writeFileSync(marked, `\uFEFF{"id":1}\n{"id":2}\n`);
    const { out, err, code } = await run(["{}", marked]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(rows(out)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reads stdin when given no file", async () => {
    const { out } = await run(['{"id":2}'], LINES.map((line) => JSON.stringify(line)));
    expect(rows(out)).toEqual([LINES[1]]);
  });

  it("explains on stderr while the matches still go to stdout", async () => {
    const { out, err } = await run(["--explain", '{"status":"open","total":{"$gt":500}}', orders]);
    expect(out).toBe("");
    expect(err).toContain("status is");
    expect(err).toContain("total is 120");
  });

  it("prints a canonical query and stops", async () => {
    const { code, out } = await run(["--canonical", '{"b":2,"a":1}']);
    expect(code).toBe(0);
    expect(JSON.parse(out) as unknown).toEqual({ a: { $eq: 1 }, b: { $eq: 2 } });
  });
});

describe("what it refuses", () => {
  it("refuses an invalid query with the reason, and exit code 2", async () => {
    const { code, out, err } = await run(['{"a":{"$gtt":1}}', orders]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain('did you mean "$gt"');
  });

  it("refuses a value it would otherwise have to guess at", async () => {
    // `Number("all")` is NaN, and a limit that stops limiting is silent in both directions.
    const { code, err } = await run(["--limit", "all", "{}", orders]);
    expect(code).toBe(2);
    expect(err).toContain("whole number");
    expect((await run(["--sort", "total:sideways", "{}", orders])).code).toBe(2);
    expect((await run(["--nope", "{}", orders])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  /**
   * Each of these was accepted and then dropped: the group path never reads the request, so
   * `jql --group status --fields id` printed the same groups as `jql --group status` and
   * nothing said the option had gone nowhere. A flag that looks applied and is not is the
   * failure this command's own rules are about.
   */
  it("refuses the options that cannot apply to groups", async () => {
    for (const flag of [
      ["--sort", "total:desc"],
      ["--skip", "1"],
      ["--fields", "id"],
      ["--omit", "id"],
    ]) {
      const { code, err } = await run(["--group", "status", ...flag, "{}", orders]);
      expect(code, flag[0]).toBe(2);
      expect(err, flag[0]).toContain(flag[0] as string);
      expect(err, flag[0]).toContain("prints groups rather than items");
    }
    const both = await run(["--group", "status", "--count", "{}", orders]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("each say what to print");
  });

  it("turns patterns off with --untrusted", async () => {
    const { code, err } = await run(["--untrusted", '{"status":{"$regex":"^o"}}', orders]);
    expect(code).toBe(2);
    expect(err).toContain("patterns are turned off");
  });

  it("fails with code 1 when a file cannot be read", async () => {
    const { code, err } = await run(["{}", join(scratch, "missing.jsonl")]);
    expect(code).toBe(1);
    expect(err).toContain("missing.jsonl");
  });

  it("fails when nothing in the input was JSON at all", async () => {
    const broken = join(scratch, "broken.jsonl");
    writeFileSync(broken, "nope\nstill nope\n");
    const { code, err } = await run(["{}", broken]);
    expect(code).toBe(1);
    expect(err).toContain("2 lines of 2");
  });
});

/**
 * Each case here starts a Node process with a TypeScript loader in front of it. That is
 * about a second warm on a laptop and several cold on a shared runner, so the patience is
 * explicit: vitest's default five seconds is close enough to fail for reasons that have
 * nothing to do with the command, and a suite that fails for unrelated reasons is one
 * people learn to skip.
 */
const COLD_START = 30_000;

describe("as a process", () => {
  const cli = (args: string[], input?: string): { status: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, ["--import", "tsx", "src/cli-run.ts", ...args], {
        cwd: root,
        encoding: "utf8",
        ...(input === undefined ? {} : { input }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { status: failure.status ?? -1, out: failure.stdout ?? "" };
    }
  };

  it("prints its usage and its version", () => {
    const help = cli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.out).toContain("jql [options] <query> [file...]");
    for (const option of ["--text", "--sort", "--group", "--omit", "--untrusted"]) expect(help.out, option).toContain(option);
    expect(cli(["--version"]).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, COLD_START);

  it("filters a real file", () => {
    const { status, out } = cli(['{"status":"open"}', "--fields", "id", orders]);
    expect(status).toBe(0);
    expect(out.trim().split("\n")).toEqual(['{"id":1}', '{"id":3}']);
  }, COLD_START);

  it("filters what it is piped", () => {
    const { out } = cli(["--text", "status:paid", "--fields", "id"], `${LINES.map((line) => JSON.stringify(line)).join("\n")}\n`);
    expect(out.trim()).toBe('{"id":2}');
  }, COLD_START);

  it("exits 2 on a bad query", () => {
    expect(cli(['{"a":{"$gtt":1}}', orders]).status).toBe(2);
  }, COLD_START);
});
