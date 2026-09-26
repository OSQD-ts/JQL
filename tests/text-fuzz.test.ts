import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, defineVocabulary, untyped, validate } from "../src/index.js";
import { MAX_TEXT_CHARS, parseText, suggest } from "../src/text/index.js";

/**
 * The text parser against input nobody would write on purpose.
 *
 * The house rule for a parser that reads what people type is that every input either parses
 * or fails with the project's own error type. This parser's promise is stronger — it never
 * fails at all — so the properties worth fuzzing are what it *produces*: a query the engine
 * accepts, that is JSON, and that says the same thing twice.
 *
 * The corpus is checked in (`tests/corpus/text-inputs.jsonl`) and the generator is seeded, so
 * a failure here is a failure anybody can reproduce. A fuzzer that finds something new on a
 * random CI run is a flaky test, and a test that cries wolf gets muted.
 */

const corpus = readFileSync(new URL("corpus/text-inputs.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as string);

const vocabulary = defineVocabulary<{ path: string; actor: string; score: number; at: string; certain: boolean; rule?: string }>()({
  fields: {
    path: { aliases: ["url"] },
    actor: { kind: "word", aliases: ["ip"] },
    score: { kind: "number" },
    at: { kind: "date" },
    certain: { kind: "boolean", values: ["true", "false"] },
    rule: {},
  },
  text: ["path", "actor", "rule"],
});

const documents: unknown[] = [
  { path: "/api", actor: "1.2.3.4", score: 70, at: "2026-09-22T00:00:00Z", certain: true, rule: "r" },
  { path: "", actor: "", score: 0, at: "", certain: false },
  {},
  { path: ["/a", "/b"], actor: null, score: Number.NaN, nested: { deep: { deeper: "x" } } },
  [1, 2, 3],
  "a string",
];

/** xorshift32: small, seeded, and the same on every machine. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

const PIECES = [
  "a",
  "path:",
  "actor:",
  "score:",
  "at:",
  "certain:",
  "has:",
  "rule:",
  "$or",
  "$and",
  "$not",
  "$in(",
  "$notin(",
  ")",
  "(",
  '"',
  "'",
  "“",
  "’",
  "-",
  "!",
  ":",
  ",",
  " ",
  "\t",
  ">",
  "<",
  ">=",
  "..",
  "*",
  "?",
  "\\",
  "1",
  "42",
  "-1h",
  "+30m",
  "now",
  "/api",
  "1.2.3.4",
  "😀",
  "\u0000",
  "__proto__",
  "$",
  "x".repeat(40),
];

function assemble(next: () => number): string {
  const count = Math.floor(next() * 12);
  let out = "";
  for (let i = 0; i < count; i++) out += PIECES[Math.floor(next() * PIECES.length)] as string;
  return out;
}

function mutate(text: string, next: () => number): string {
  if (text === "") return assemble(next);
  const at = Math.floor(next() * text.length);
  const pick = next();
  if (pick < 0.3) return text.slice(0, at) + text.slice(at + 1);
  if (pick < 0.6) return text.slice(0, at) + (PIECES[Math.floor(next() * PIECES.length)] as string) + text.slice(at);
  if (pick < 0.8) return text.slice(at) + text.slice(0, at);
  return text + text.slice(0, Math.min(20, text.length));
}

function inputs(total: number): string[] {
  const next = random(20260925);
  const out = [...corpus];
  for (let i = 0; i < total; i++) {
    const pick = next();
    if (pick < 0.5) out.push(assemble(next));
    else out.push(mutate(corpus[Math.floor(next() * corpus.length)] as string, next));
  }
  return out;
}

const ALL = inputs(4000);

/**
 * Generous, and deliberately so: the slowest case here takes about a second on a laptop, and
 * vitest's default five seconds is close enough to that on a CI runner half as fast to fail
 * for reasons that have nothing to do with the parser. A suite that cries wolf gets muted.
 */
const PATIENCE = 60_000;

describe("whatever is typed into the box", () => {
  it("parses, every time, in both readings of a field name", () => {
    for (const input of ALL) {
      expect(() => parseText(input), JSON.stringify(input)).not.toThrow();
      expect(() => parseText(input, { vocabulary }), JSON.stringify(input)).not.toThrow();
      expect(() => parseText(input, { fields: "any" }), JSON.stringify(input)).not.toThrow();
    }
  }, PATIENCE);

  it("produces a query the engine accepts", () => {
    for (const input of ALL) {
      for (const parsed of [parseText(input), parseText(input, { vocabulary })]) {
        const verdict = validate(parsed, { vocabulary });
        if (!verdict.valid) {
          expect.fail(`${JSON.stringify(input)} parsed to a query the engine refuses: ${verdict.error.message}\n  ${JSON.stringify(parsed)}`);
        }
      }
    }
  }, PATIENCE);

  it("produces a query that is JSON", () => {
    for (const input of ALL) {
      const parsed = parseText(input, { vocabulary });
      const written = JSON.stringify(parsed);
      expect(written, JSON.stringify(input)).toBeTypeOf("string");
      expect(JSON.parse(written as string), JSON.stringify(input)).toEqual(parsed);
    }
  }, PATIENCE);

  it("says the same thing twice", () => {
    for (const input of ALL) expect(parseText(input, { vocabulary }), JSON.stringify(input)).toEqual(parseText(input, { vocabulary }));
  }, PATIENCE);

  it("answers every document without throwing", () => {
    for (const input of ALL) {
      const test = compile(untyped(parseText(input, { vocabulary })), { vocabulary });
      for (const document of documents) expect(() => test(document), JSON.stringify(input)).not.toThrow();
    }
  }, PATIENCE);

  it("completes without throwing at any caret", () => {
    for (const input of ALL.slice(0, 500)) {
      for (const caret of [0, 1, Math.floor(input.length / 2), input.length]) {
        expect(() => suggest(input, caret, vocabulary), `${JSON.stringify(input)} @ ${caret}`).not.toThrow();
      }
    }
  }, PATIENCE);

  /** Input past the cap is cut rather than refused, and what is cut still has to parse. */
  it("takes input far past the cap", () => {
    for (const input of ["a ".repeat(MAX_TEXT_CHARS), "(".repeat(50_000), "path:$in(" + "x,".repeat(20_000), "-".repeat(MAX_TEXT_CHARS * 2)]) {
      const parsed = parseText(input, { vocabulary });
      expect(validate(parsed, { vocabulary }).valid, input.slice(0, 20)).toBe(true);
    }
  });

  it("never parses to something the engine reads as an operator", () => {
    // A field name that began with `$` would put an operator key in the query.
    for (const input of ALL) {
      const parsed = parseText(input, { fields: "any" }) as unknown as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        if (!key.startsWith("$")) continue;
        expect(["$and", "$or", "$not", "$text", "$nor"], `${JSON.stringify(input)} produced ${key}`).toContain(key);
      }
    }
  }, PATIENCE);
});

describe("the corpus", () => {
  it("is every line a string", () => {
    expect(corpus.length).toBeGreaterThan(50);
    for (const line of corpus) expect(typeof line).toBe("string");
  });

  it("holds the inputs that once went wrong", () => {
    // Each of these is a case from the suite that a change here must not quietly break.
    for (const input of ['actor:$in("a,b", c)', "don't", "path:$in()", "has:rule", "at:>-1h"]) {
      expect(corpus, input).toContain(input);
    }
  });
});
