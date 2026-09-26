import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, FIELD_OPERATORS, QUERY_OPERATORS, UNTRUSTED_LIMITS } from "../src/index.js";
import { MAX_PATH_SEGMENTS } from "../src/internal/path.js";
import { MAX_TEXT_CHARS, MAX_TEXT_DEPTH, TEXT_OPERATORS } from "../src/text/index.js";

/**
 * The documentation, checked against the code it describes.
 *
 * Adapted from bothandlerjs. The specification is the standard, so an operator the engine
 * accepts and the specification never mentions is an operator other implementations cannot
 * know about — and one the specification names that the engine does not accept is a
 * promise nobody keeps. Numbers the prose states as fact are derived here rather than
 * trusted.
 */

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const specification = read("docs/reference/specification.md");
const suite = JSON.parse(read("conformance/cases.json")) as { version: string; cases: { query: unknown }[]; requests: unknown[] };

describe("the specification", () => {
  it("defines every operator the engine accepts", () => {
    for (const name of [...FIELD_OPERATORS, ...QUERY_OPERATORS]) expect(specification, name).toContain(`\`${name}\``);
  });

  it("names no operator the engine does not accept", () => {
    const named = new Set([...specification.matchAll(/`\{?\s*"?(\$[a-zA-Z]+)/g)].map((match) => match[1] as string));
    // Names the specification writes that are not operators: the literal forms, the parts
    // of a text search, an added operator's example name, and the things it names only to
    // say they are somebody else's.
    const disclaimed = new Set([
      "$where",
      "$expr",
      "$jsonSchema",
      "$strLenCP",
      "$date",
      "$field",
      "$ago",
      "$ahead",
      "$search",
      "$fields",
      "$caseSensitive",
      "$xCidr",
      "$x",
    ]);
    for (const name of named) {
      if (disclaimed.has(name)) continue;
      expect([...FIELD_OPERATORS, ...QUERY_OPERATORS], name).toContain(name);
    }
  });

  it("carries the version the conformance suite tests", () => {
    expect(specification).toContain(`version ${suite.version}`);
  });

  it("is exercised by the conformance suite for every operator", () => {
    const text = JSON.stringify(suite.cases.map((item) => item.query));
    for (const name of [...FIELD_OPERATORS, ...QUERY_OPERATORS]) expect(text, `no conformance case uses ${name}`).toContain(`"${name}"`);
  });
});

describe("numbers the prose states", () => {
  it("counts the conformance cases correctly in the changelog", () => {
    expect(read("CHANGELOG.md")).toContain(`${suite.cases.length} matching cases and ${suite.requests.length} request`);
  });

  it("lists the text operators the parser understands", () => {
    const syntax = read("docs/reference/text-syntax.md");
    for (const name of TEXT_OPERATORS) expect(syntax, name).toContain(name);
  });

  /**
   * The reference table is what somebody reads before putting this behind an endpoint, and
   * nothing derived it: `maxGlobLength` was added to the code and to `SECURITY.md` and never
   * reached the table, so the page listing "the limits" quietly listed all but one of them.
   */
  /**
   * Both numbers had drifted: the parser's bracket depth was tightened to match the limit the
   * engine compiles under, and two pages went on saying 32.
   */
  it("states the text parser's caps as the parser sets them", () => {
    const flowed = (path: string): string => read(path).replace(/\s+/g, " ");
    for (const page of ["docs/reference/text-syntax.md", "docs/guides/untrusted-input.md"]) {
      expect(flowed(page), page).toContain(`${MAX_TEXT_CHARS / 1024} KB`);
      expect(flowed(page), page).toContain(`${MAX_TEXT_DEPTH} levels`);
    }
  });

  it("gives every limit a row, with the values the code sets", () => {
    const rows = read("docs/reference/api.md").split("\n");
    for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
      const row = rows.find((line) => line.startsWith(`| \`${name}\``));
      expect(row, `no row for ${name} in the limits table`).toBeDefined();
      expect(row, name).toContain(written(fallback));
      expect(row, name).toContain(written((UNTRUSTED_LIMITS as Record<string, unknown>)[name]));
    }
  });

  it("states the caps in the specification as the code sets them", () => {
    // As one line: the prose wraps, and a sentence's meaning does not depend on where.
    const flowed = specification.replace(/\s+/g, " ");
    expect(flowed).toContain(`a depth of ${DEFAULT_LIMITS.maxDepth}`);
    expect(flowed).toContain(`${spaced(DEFAULT_LIMITS.maxNodes)} fields and operators`);
    expect(flowed).toContain(`${spaced(DEFAULT_LIMITS.maxPatternLength)} characters per pattern`);
    expect(flowed).toContain(`${MAX_PATH_SEGMENTS} segments per path`);
  });
});

/** A number as the documentation writes one: a space every three digits. */
function spaced(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** One limit's value, as a table cell writes it. */
function written(value: unknown): string {
  if (typeof value === "number") return spaced(value);
  if (typeof value === "boolean") return `\`${value}\``;
  return `\`"${String(value)}"\``;
}
