import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, defineVocabulary, untyped } from "../src/index.js";
import { parseText, toText } from "../src/text/index.js";
import { makeQuery, makeRoot, random } from "./helpers/generate.js";

/**
 * A query, written back as something somebody can type.
 *
 * Two promises are tested here. The text is **exact for what it says**: parsed back it
 * matches the same documents as the clauses it carries. And what it cannot say is
 * *reported* rather than dropped quietly — a dashboard that showed only the expressible
 * half would be showing a filter wider than the one running.
 */

const vocabulary = defineVocabulary<{ path: string; actor: string; score: number; at: string; certain: boolean; rule?: string; tags: string[] }>()({
  fields: {
    path: { aliases: ["url"] },
    actor: { kind: "word", aliases: ["ip"] },
    score: { kind: "number" },
    at: { kind: "date" },
    certain: { kind: "boolean" },
    rule: { kind: "exact" },
    tags: {},
  },
  text: ["path", "actor", "rule"],
});

const written = (input: string): string => toText(parseText(input, { vocabulary }), { vocabulary }).text;

describe("writing a query as text", () => {
  it("writes each kind of term the way it is typed", () => {
    expect(written("actor:1.2.3.4")).toBe("actor:1.2.3.4");
    expect(written("path:/api")).toBe("path:/api");
    expect(written("rule:no-scrapers")).toBe("rule:no-scrapers");
    expect(written("score:>70")).toBe("score:>70");
    expect(written("score:10..20")).toBe("score:10..20");
    expect(written("certain:true")).toBe("certain:true");
    expect(written("at:>-1h")).toBe("at:>-1h");
    expect(written("at:-1h..now")).toBe("at:-1h..now");
    expect(written("has:rule")).toBe("has:rule");
    expect(written("-has:rule")).toBe("-has:rule");
  });

  it("writes sets, negation and grouping", () => {
    expect(written("path:$in(/a, /b)")).toBe("path:$in(/a, /b)");
    expect(written("path:$notin(/a, /b)")).toBe("path:$notin(/a, /b)");
    expect(written("-path:/health")).toBe("-path:/health");
    expect(written("(curl $or path:/health) score:<50")).toBe("(curl $or path:/health) score:<50");
    expect(written("$not (curl $or path:/health)")).toBe("$not (curl $or path:/health)");
  });

  it("quotes a value that would not read back whole", () => {
    expect(written('"GET /api/v2"')).toBe('"GET /api/v2"');
    expect(toText(untyped({ path: { $contains: "a b", $options: "i" } }), { vocabulary }).text).toBe('path:"a b"');
    expect(toText(untyped({ path: { $contains: 'say "hi"', $options: "i" } }), { vocabulary }).text).toBe("path:'say \"hi\"'");
    expect(toText(untyped({ path: { $contains: "-dash", $options: "i" } }), { vocabulary }).text).toBe('path:"-dash"');
    expect(toText(untyped({ path: { $contains: ["a,b", "c"], $options: "i" } }), { vocabulary }).text).toBe('path:$in("a,b", c)');
  });

  it("says a value it cannot quote at all", () => {
    // The syntax has no escape inside a quoted run, so a value with both quotes is unsayable.
    const form = toText(untyped({ path: { $contains: `both " and '`, $options: "i" } }), { vocabulary });
    expect(form.complete).toBe(false);
    expect(form.text).toBe("");
  });

  it("drops a comment, which asks nothing", () => {
    const form = toText(untyped({ $comment: "why", path: { $contains: "x", $options: "i" } }), { vocabulary });
    expect(form.text).toBe("path:x");
    expect(form.complete).toBe(true);
  });
});

describe("what the box cannot say", () => {
  const cases: [string, unknown][] = [
    ["$elemMatch", { tags: { $elemMatch: { $startsWith: "a" } } }],
    ["$glob", { path: { $glob: "a*" } }],
    ["$size", { tags: { $size: 2 } }],
    ["$length", { path: { $length: { $gt: 2 } } }],
    ["a reference", { score: { $gt: { $field: "other" } } }],
    ["$ne", { path: { $ne: "x" } }],
    ["case-sensitive text", { path: { $contains: "x" } }],
    ["a field the vocabulary does not have", { nope: { $contains: "x", $options: "i" } }],
    ["an empty set", { path: { $contains: [], $options: "i" } }],
    ["a case-sensitive search", { $text: { $search: "x", $caseSensitive: true } }],
  ];

  for (const [name, query] of cases) {
    it(`reports ${name} rather than writing something narrower`, () => {
      const form = toText(untyped(query as never), { vocabulary });
      expect(form.complete, JSON.stringify(query)).toBe(false);
      expect(form.unexpressed.length).toBeGreaterThan(0);
      expect(form.unexpressed[0]?.why).toBeTypeOf("string");
    });
  }

  /**
   * `{ $or: [] }` matches nothing. Written as `()` it read back as an empty query — which
   * matches everything — and said it was complete while doing it. Found by the generated
   * round-trip below, at the second seed.
   */
  it("refuses to write an $or of nothing, which no term can say", () => {
    const form = toText(untyped({ $or: [] }), { vocabulary });
    expect(form.complete).toBe(false);
    expect(form.text).toBe("");
  });

  /**
   * The same shape as the `$or` of nothing above, on the other side of the language.
   * `$not` of a query that asks nothing matches *nothing*: the empty query matches
   * everything, and negating it leaves no item at all. The writer had nothing to put in the
   * text for it and said so by writing nothing — which reads back as the empty query, the
   * widest there is, with `complete: true` on top. The narrowest question in the language
   * became the widest, and the one field a caller is told to check said it was fine.
   */
  it("refuses to write a $not of a query that asks nothing", () => {
    const cases: unknown[] = [{ $not: {} }, { $not: { $comment: "why" } }, { $and: [{ $not: {} }] }];
    for (const query of cases) {
      const form = toText(untyped(query as never), { vocabulary });
      expect(form.complete, JSON.stringify(query)).toBe(false);
      expect(form.unexpressed[0]?.why, JSON.stringify(query)).toContain("matches nothing");
    }
  });

  /**
   * A `$not` whose contents were themselves unsayable is already reported by that clause,
   * and the negation is left out rather than reported twice.
   */
  it("reports what a negation held, once, when that is what it could not say", () => {
    const form = toText(untyped({ $not: { tags: { $size: 2 } } }), { vocabulary });
    expect(form.complete).toBe(false);
    expect(form.unexpressed).toHaveLength(1);
    expect(form.unexpressed[0]?.at).toBe("$not.tags.$size");
  });

  /**
   * Each of these was written out as text that read back as a *different*, usually wider,
   * question — while reporting `complete: true`. The parser decides what a word is before
   * quoting is considered, and it trims what is left, so quoting cannot rescue any of them.
   */
  it("refuses a value the parser would read as something else", () => {
    const cases: [string, unknown][] = [
      ["only whitespace, which the parser trims away entirely", { path: { $contains: " ", $options: "i" } }],
      ["whitespace at an end, which the parser trims", { path: { $contains: " x ", $options: "i" } }],
      ["a value that opens a set", { path: { $contains: "$in(x)", $options: "i" } }],
      ["a value that opens a negated set", { path: { $contains: "$notin(y)", $options: "i" } }],
      ["a value that reads as a range", { path: { $contains: "1..2", $options: "i" } }],
      ["a value that reads as a comparison", { path: { $contains: ">5", $options: "i" } }],
    ];
    for (const [name, query] of cases) {
      const form = toText(untyped(query as never));
      expect(form.complete, name).toBe(false);
      expect(form.text, name).toBe("");
    }
  });

  it("refuses a field named as the syntax's own existence term", () => {
    const form = toText(untyped({ has: { $contains: "rule", $options: "i" } }));
    expect(form.complete).toBe(false);
    expect(form.unexpressed[0]?.why).toContain("asks whether a field is set");
  });

  /**
   * `$not` over several terms has to bracket all of them. Handed back unbracketed, only the
   * first was negated: `NOT((a ∨ b) ∧ c)` came out as `NOT(a ∨ b) ∧ c`.
   */
  it("brackets everything a negation covers", () => {
    const query = untyped({
      $not: { $and: [{ $or: [{ a: { $contains: "x", $options: "i" } }, { b: { $contains: "y", $options: "i" } }] }, { c: { $contains: "z", $options: "i" } }] },
    });
    const form = toText(query);
    expect(form.complete).toBe(true);
    expect(form.text).toBe("$not ((a:x $or b:y) c:z)");
    const before = compile(query);
    const after = compile(parseText(form.text));
    for (const document of [{}, { a: "x", c: "q" }, { b: "y", c: "q" }, { a: "x", c: "z" }]) {
      expect(after(document), JSON.stringify(document)).toBe(before(document));
    }
  });

  it("writes none of an $or whose branch it cannot say", () => {
    // Writing the sayable branches alone would widen the filter, which is the one direction
    // that must never happen quietly.
    const form = toText(untyped({ $or: [{ path: { $contains: "a", $options: "i" } }, { tags: { $size: 2 } }] }), { vocabulary });
    expect(form.text).toBe("");
    expect(form.complete).toBe(false);
  });

  it("keeps the clauses it could write beside the ones it could not", () => {
    const form = toText(untyped({ path: { $contains: "a", $options: "i" }, tags: { $size: 2 } }), { vocabulary });
    expect(form.text).toBe("path:a");
    expect(form.complete).toBe(false);
    expect(form.unexpressed[0]?.at).toBe("tags.$size");
  });
});

/**
 * The property that matters: when the text says everything, it says exactly the same thing.
 * The corpus is the fuzzer's, so the queries are whatever a search box can produce.
 */
describe("round trips", () => {
  const corpus = readFileSync(new URL("corpus/text-inputs.jsonl", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string);

  const documents: unknown[] = [
    { path: "/api/items", actor: "1.2.3.4", score: 70, at: "2026-09-22T11:00:00Z", certain: true, rule: "r", tags: ["a"] },
    { path: "/health", actor: "203.0.113.9", score: 5, at: "2026-09-01T00:00:00Z", certain: false, tags: [] },
    { path: "", actor: "", score: 0, at: "now", certain: false, rule: "" },
    {},
    { path: ["/a", "/b"], actor: ["1.2.3.4", "9.9.9.9"], score: [1, 99], tags: ["x", "y"] },
  ];
  const now = (): number => Date.parse("2026-09-22T12:00:00Z");

  it("means the same thing after being written and read again", () => {
    for (const input of corpus) {
      const query = parseText(input, { vocabulary });
      const form = toText(query, { vocabulary });
      if (!form.complete) continue;
      const before = compile(query, { vocabulary, now });
      const after = compile(parseText(form.text, { vocabulary }), { vocabulary, now });
      for (const document of documents) {
        expect(after(document), `${JSON.stringify(input)} -> ${JSON.stringify(form.text)} on ${JSON.stringify(document)}`).toBe(before(document));
      }
    }
  });

  it("settles: writing what it wrote gives the same text", () => {
    for (const input of corpus) {
      const form = toText(parseText(input, { vocabulary }), { vocabulary });
      if (!form.complete) continue;
      expect(toText(parseText(form.text, { vocabulary }), { vocabulary }).text, JSON.stringify(input)).toBe(form.text);
    }
  });

  /**
   * The corpus above holds queries the parser produced. These are queries nobody wrote at
   * all, which is where a writer that mirrors a parser by hand goes wrong: a value that
   * needed quoting in a way neither of them thought about, or a field kind one of them
   * infers and the other does not.
   */
  it("says the same thing for queries nobody wrote by hand", () => {
    let complete = 0;
    for (let seed = 1; seed <= 800; seed++) {
      const next = random(seed);
      const query = makeQuery(next);
      const form = toText(untyped(query));
      if (!form.complete) continue;
      complete++;
      const before = compile(untyped(query));
      const after = compile(parseText(form.text));
      for (let i = 0; i < 8; i++) {
        const document = makeRoot(next);
        if (after(document) !== before(document)) {
          expect.fail(
            `seed ${seed}: the text means something else\n  query: ${JSON.stringify(query)}\n  text:  ${JSON.stringify(form.text)}\n  doc:   ${JSON.stringify(document)}`,
          );
        }
      }
    }
    // A run where nothing was expressible would pass while testing nothing.
    expect(complete, "no generated query could be written as text").toBeGreaterThan(20);
  });

  it("works without a vocabulary, where every name is a path", () => {
    for (const input of ["a:b", "a.b:c", "x:>=30", "x:10..20", "has:field", '"a phrase"', "-a:b", "a:$in(x, y)"]) {
      const query = parseText(input);
      const form = toText(query);
      expect(form.complete, input).toBe(true);
      expect(parseText(form.text), input).toEqual(query);
    }
  });
});
