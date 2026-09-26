import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { canonical, explain, type Explanation, group, JqlError, searchAsync, UNTRUSTED_LIMITS, untyped } from "./index.js";
import { parseText } from "./text/index.js";
import type { Request, SortDirection, UntypedQuery } from "./types.js";

/**
 * `jql` — filtering JSON lines from a shell.
 *
 * A log file, a `kubectl` dump, a store's export: the shape this library is for arrives as
 * one JSON value per line more often than it arrives as an array in a program. This is the
 * same engine over a stream, and it is also the package demonstrating itself — everything
 * here is a public export, used the way the documentation says to use it.
 *
 * Two rules from the house style decide its shape. **stdout is the artifact**: matching
 * lines and nothing else, so redirecting it into a file produces a file worth having, and
 * every note, count and warning goes to stderr. And **a value is validated, never
 * coerced**: `--limit all` is an error rather than a limit that quietly stops limiting.
 */

/**
 * The line an item arrived on, kept beside it.
 *
 * A matching line is written back out as it came in, because re-serialising it changes the
 * data: `1e400` became `null` and a thirty-digit identifier came back as
 * `1.2345678901234568e+29`. Both are `JSON.parse` and `JSON.stringify` doing what they
 * document, and both turn "filter these lines" into "rewrite these lines" — under a command
 * whose whole rule is that stdout is the artifact.
 *
 * A symbol, so it is invisible: JQL reads string keys, `JSON.stringify` skips symbols, and a
 * projection builds a new object that simply does not carry one — which is exactly right,
 * since a projected item is no longer the line that arrived.
 */
const LINE: unique symbol = Symbol("jql.line");

export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Where a `-` argument, or no file at all, reads from. */
  readonly stdin: () => AsyncIterable<string>;
}

const USAGE = `jql — filter JSON lines with a JQL query

  jql [options] <query> [file...]

  <query>   a JQL query, as JSON: '{"status":"open"}'
            with --text, the search-box syntax: 'status:open score:>70'
  file...   files holding one JSON value per line; without any, or with -, stdin

Options:
  --text                read the query as search-box text rather than JSON
  --sort <field:order>  order by a field, asc or desc; repeatable, first key wins ties
  --skip <n>            pass over the first n matches
  --limit <n>           stop after n matches
  --fields <a,b>        keep only these paths in each result
  --omit <a,b>          drop these paths from each result
  --count               print how many matched instead of the matches
  --group <field>       print how many matched by that field, largest first; --limit
                        then says how many groups, and the other shaping options do not apply
  --explain             say on stderr why the first line did or did not match
  --canonical           print the query in its canonical form and stop
  --untrusted           compile with the untrusted limits ($regex off, tighter caps)
  --pretty              print each result over several lines
  -h, --help            this
  -v, --version         the version

Exit codes: 0 ran, 1 a file or a line could not be read, 2 bad arguments or an invalid query.`;

/** Runs the command. Returns the exit code rather than calling `process.exit`, so it can be tested in-process. */
export async function main(argv: readonly string[], io: Streams): Promise<number> {
  let options: Options;
  try {
    options = read(argv);
  } catch (error) {
    io.err(`jql: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (options.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    io.out(`${await version()}\n`);
    return 0;
  }
  if (options.query === undefined) {
    io.err("jql: a query is the first argument; jql --help says how\n");
    return 2;
  }

  let query: UntypedQuery;
  try {
    query = options.text ? parseText(options.query) : untyped(JSON.parse(options.query));
  } catch (error) {
    io.err(`jql: the query is not JSON: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const limits = options.untrusted ? UNTRUSTED_LIMITS : undefined;
  const compileOptions = limits === undefined ? {} : { limits };
  if (options.canonical) {
    try {
      io.out(`${JSON.stringify(canonical(query, compileOptions), null, options.pretty ? 2 : 0)}\n`);
      return 0;
    } catch (error) {
      return refuse(error, io);
    }
  }

  const request: Request = {
    where: query,
    ...(options.sort === undefined ? {} : { sort: options.sort }),
    ...(options.skip === undefined ? {} : { skip: options.skip }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.omit === undefined ? {} : { omit: options.omit }),
  };

  // Whether the command's output is the lines themselves.
  const echo = !options.count && !options.pretty && options.group === undefined;
  const samples: string[] = [];
  let damaged = 0;
  let read_ = 0;
  let explained = false;
  const items = async function* (): AsyncGenerator<unknown> {
    for await (const line of lines(options.files, io)) {
      if (line.trim() === "") continue;
      read_++;
      let value: unknown;
      try {
        value = JSON.parse(line);
        // Only when a line is what will be printed: `--count` and `--group` print neither,
        // and `--pretty` lays the value out again — and `--group` holds every matching item
        // at once, so keeping each one's text alive there would be memory spent on output
        // nobody asked for. Only an object can carry it; a scalar is written back by value.
        if (echo && value !== null && typeof value === "object") Object.defineProperty(value, LINE, { value: line });
      } catch {
        // Never silently show a hole: a line that is not JSON is reported, and the ones
        // around it are still answered. The samples are capped; the count is not, or the
        // eleventh bad line made "nothing here was JSON" look like a partial success.
        damaged++;
        if (samples.length < 10) samples.push(line.length > 60 ? `${line.slice(0, 60)}…` : line);
        continue;
      }
      if (options.explain && !explained) {
        explained = true;
        try {
          io.err(`${draw(explain(query, value, compileOptions), 0)}\n`);
        } catch (error) {
          return refuseInStream(error);
        }
      }
      yield value;
    }
  };

  try {
    if (options.group !== undefined) {
      // The query decides what is counted: grouping everything and calling it a filtered
      // tally would be a wrong answer with no sign of it.
      const counted = group(await collect(items()), options.group, {
        ...compileOptions,
        where: query,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      for (const held of counted) io.out(`${write({ key: held.key, count: held.count }, options.pretty)}\n`);
    } else if (options.count) {
      let total = 0;
      for await (const _item of streamOf(request, items(), compileOptions)) total++;
      io.out(`${total}\n`);
    } else {
      for await (const item of streamOf(request, items(), compileOptions)) io.out(`${write(item, options.pretty)}\n`);
    }
  } catch (error) {
    if (error instanceof ReadFailure) {
      io.err(`jql: ${error.message}\n`);
      return 1;
    }
    return refuse(error, io);
  }

  if (damaged > 0) {
    for (const line of samples) io.err(`jql: not JSON, skipped: ${line}\n`);
    io.err(`jql: ${damaged} line${damaged === 1 ? "" : "s"} of ${read_} could not be read\n`);
    if (damaged === read_) return 1;
  }
  return 0;
}

function refuse(error: unknown, io: Streams): number {
  if (error instanceof JqlError) {
    io.err(`jql: ${error.message}\n`);
    return 2;
  }
  throw error;
}

function refuseInStream(error: unknown): never {
  throw error;
}

/** Runs the request over the stream. Split out so `--count` and the default share one path. */
async function* streamOf(request: Request, items: AsyncGenerator<unknown>, compileOptions: { limits?: typeof UNTRUSTED_LIMITS }): AsyncGenerator<unknown> {
  const found = await searchAsync(items, request as never, compileOptions);
  for (const item of found) yield item;
}

async function collect(items: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const item of items) out.push(item);
  return out;
}

function write(value: unknown, pretty: boolean): string {
  // `--pretty` asks for the value to be laid out again, so it is the one case that does not
  // hand back the line as it arrived.
  if (!pretty && value !== null && typeof value === "object") {
    const line = (value as Record<symbol, unknown>)[LINE];
    if (typeof line === "string") return line;
  }
  return JSON.stringify(value, undefined, pretty ? 2 : undefined) ?? "null";
}

/** An explanation, as an indented tree on stderr. */
function draw(node: Explanation, depth: number): string {
  const head = `${" ".repeat(depth)}${node.matched ? "✓" : "✗"} ${node.at === "" ? "the query" : node.at} — ${node.because}`;
  return [head, ...(node.parts ?? []).map((part) => draw(part, depth + 2))].join("\n");
}

class ReadFailure extends Error {}

/**
 * Every line of every file, or of stdin.
 *
 * A leading byte-order mark is dropped. It is what a Windows editor and a PowerShell
 * redirect put at the front of a UTF-8 file, it is not part of the JSON, and leaving it made
 * the first record of such a file "not JSON, skipped" — a real line reported as damaged data.
 */
async function* lines(files: readonly string[], io: Streams): AsyncGenerator<string> {
  if (files.length === 0) {
    yield* unmarked(io.stdin());
    return;
  }
  for (const file of files) {
    if (file === "-") {
      yield* unmarked(io.stdin());
      continue;
    }
    let stream: Readable;
    try {
      stream = createReadStream(file, "utf8");
    } catch (error) {
      throw new ReadFailure(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      yield* unmarked(reader);
    } catch (error) {
      throw new ReadFailure(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      reader.close();
      stream.destroy();
    }
  }
}

/** The same lines, without a byte-order mark on the first one. */
async function* unmarked(source: AsyncIterable<string>): AsyncGenerator<string> {
  let first = true;
  for await (const line of source) {
    yield first && line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
    first = false;
  }
}

interface Options {
  query: string | undefined;
  files: string[];
  text: boolean;
  count: boolean;
  pretty: boolean;
  untrusted: boolean;
  explain: boolean;
  canonical: boolean;
  help: boolean;
  version: boolean;
  group?: string;
  skip?: number;
  limit?: number;
  fields?: string[];
  omit?: string[];
  sort?: Record<string, SortDirection>;
}

/** Reads the arguments, refusing anything it does not know rather than guessing. */
function read(argv: readonly string[]): Options {
  const options: Options = {
    query: undefined,
    files: [],
    text: false,
    count: false,
    pretty: false,
    untrusted: false,
    explain: false,
    canonical: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i] as string;
    if (!argument.startsWith("--") && argument !== "-h" && argument !== "-v") {
      if (options.query === undefined) options.query = argument;
      else options.files.push(argument);
      continue;
    }
    const split = argument.indexOf("=");
    const name = split === -1 ? argument : argument.slice(0, split);
    const inline = split === -1 ? undefined : argument.slice(split + 1);
    const value = (): string => {
      const given = inline ?? argv[++i];
      if (given === undefined) throw new Error(`${name} needs a value`);
      return given;
    };
    switch (name) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "--text":
        options.text = true;
        break;
      case "--count":
        options.count = true;
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--untrusted":
        options.untrusted = true;
        break;
      case "--explain":
        options.explain = true;
        break;
      case "--canonical":
        options.canonical = true;
        break;
      case "--group":
        options.group = value();
        break;
      case "--skip":
        options.skip = whole(name, value());
        break;
      case "--limit":
        options.limit = whole(name, value());
        break;
      case "--fields":
        options.fields = paths(name, value());
        break;
      case "--omit":
        options.omit = paths(name, value());
        break;
      case "--sort":
        options.sort = { ...options.sort, ...order(value()) };
        break;
      default:
        throw new Error(`${name} is not an option; jql --help lists them`);
    }
  }
  // Every option here was read and then quietly dropped when `--group` was given: the group
  // path builds its own answer and never looks at the request. An option accepted and
  // ignored is the failure this command's own rule is about — a flag that looks applied and
  // is not — so the combinations that cannot mean anything are refused by name. `--limit`
  // is the exception and means what it looks like: how many groups to print.
  if (options.group !== undefined) {
    const shaping = ([["--sort", options.sort], ["--skip", options.skip], ["--fields", options.fields], ["--omit", options.omit]] as const)
      .filter(([, given]) => given !== undefined)
      .map(([name]) => name);
    if (shaping.length > 0) {
      throw new Error(`--group prints groups rather than items, so ${list(shaping)} cannot apply; --limit says how many groups to print`);
    }
    if (options.count) throw new Error("--count and --group each say what to print; use one of them");
  }
  return options;
}

/** `"a"`, `"a and b"`, `"a, b and c"` — for an error that names more than one thing. */
function list(names: readonly string[]): string {
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string}`;
}

function whole(name: string, given: string): number {
  // `Number("all")` is NaN, every comparison against it is false, and the failure is silent
  // in both directions: the limit stops limiting and nothing says so.
  if (!/^\d+$/.test(given)) throw new Error(`${name} takes a whole number of items, not ${JSON.stringify(given)}`);
  return Number(given);
}

function paths(name: string, given: string): string[] {
  const out = given
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (out.length === 0) throw new Error(`${name} takes one or more field names, separated by commas`);
  return out;
}

function order(given: string): Record<string, SortDirection> {
  const at = given.lastIndexOf(":");
  const field = at === -1 ? given : given.slice(0, at);
  const direction = at === -1 ? "asc" : given.slice(at + 1);
  if (field === "") throw new Error("--sort takes a field name, then :asc or :desc");
  if (direction !== "asc" && direction !== "desc") throw new Error(`--sort takes :asc or :desc, not ${JSON.stringify(direction)}`);
  return { [field]: direction };
}

/**
 * The command as a process: reads stdin, writes the streams, sets the exit code.
 *
 * Kept apart from `main` so the tests can call `main` with writers of their own and assert
 * which stream each line went to — part of the contract, not an implementation detail.
 */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const code = await main(argv, {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    stdin: () => createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }),
  });
  process.exitCode = code;
}

async function version(): Promise<string> {
  try {
    const manifest = await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? "unknown";
  } catch {
    // A version nobody can read is not worth failing over: the command still works.
    return "unknown";
  }
}
