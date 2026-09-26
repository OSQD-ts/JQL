import { describe, expect, it } from "vitest";
import { canonical, compile, fingerprint, JqlError, untyped } from "../src/index.js";
import { makeQuery, makeRoot, random } from "./helpers/generate.js";

/**
 * One shape per meaning.
 *
 * The rewriting rules are worth pinning one by one, but the case that matters most is the
 * last: whatever it rewrites, the query must still match exactly what it matched before.
 */

describe("the canonical form", () => {
  it("writes a shorthand as the operator it means, and sorts the keys", () => {
    expect(canonical({ b: 2, a: 1 })).toEqual({ a: { $eq: 1 }, b: { $eq: 2 } });
  });

  it("drops a comment, which decides nothing", () => {
    expect(canonical({ $comment: "why", a: 1 })).toEqual({ a: { $eq: 1 } });
  });

  it("flattens nested $and and lifts the parts that can stand alone", () => {
    // `{ $and: [x, y] }` and `{ …x, …y }` are the same filter, so they get the same form —
    // the everyday case, because the search box writes the first and a person writes the
    // second, and apart they were two saved filters with two names.
    expect(canonical({ $and: [{ $and: [{ b: 2 }] }, { a: 1 }] })).toEqual({ a: { $eq: 1 }, b: { $eq: 2 } });
    expect(fingerprint({ $and: [{ a: 1 }, { b: 2 }] })).toBe(fingerprint({ a: 1, b: 2 }));
  });

  /**
   * Only a part whose keys are free can be lifted. Two conditions on one field cannot become
   * one key, and merging them would be wrong even if JSON allowed it: `$options` reaches
   * every case-aware operator beside it, so folding these together would quietly make the
   * `$contains` ignore case as well.
   */
  it("keeps a part whose field is already spoken for", () => {
    // Which of the two is lifted is settled by the sorted order of the parts, not by the
    // order they were written in — whichever it is, it is the same every time.
    expect(canonical({ $and: [{ a: { $eq: "X", $options: "i" } }, { a: { $contains: "y" } }] })).toEqual({
      a: { $contains: "y" },
      $and: [{ a: { $eq: "X", $options: "i" } }],
    });
    // And the form settles: running it again lifts nothing new.
    const once = canonical({ $and: [{ a: 1 }, { a: 2 }] });
    expect(canonical(untyped(once))).toEqual(once);
  });

  it("unwraps a single part of $and and $or, and keeps $nor whole", () => {
    expect(canonical({ $or: [{ a: 1 }] })).toEqual({ a: { $eq: 1 } });
    expect(canonical({ $nor: [{ a: 1 }] })).toEqual({ $nor: [{ a: { $eq: 1 } }] });
  });

  /**
   * Unwrapping `{ $or: [x] }` to `x` is only sound when the `$or` is the whole query.
   * Done while it had siblings it returned `x` for the entire object and dropped them —
   * a stored filter quietly missing a constraint, and two different queries with one
   * fingerprint. Found by the generated test below, at seed 136.
   */
  it("keeps what stands beside a one-part $or or $and", () => {
    expect(canonical({ a: 1, $or: [{ b: 2 }] })).toEqual({ $or: [{ b: { $eq: 2 } }], a: { $eq: 1 } });
    expect(canonical({ a: 1, $and: [{ b: 2 }] })).toEqual({ a: { $eq: 1 }, b: { $eq: 2 } });
    expect(fingerprint({ a: 1, $or: [{ b: 2 }] })).not.toBe(fingerprint({ $or: [{ b: 2 }] }));
  });

  it("treats the list operators as sets", () => {
    expect(canonical({ a: { $in: [3, 1, 3] } })).toEqual({ a: { $in: [1, 3] } });
    expect(canonical({ a: { $type: ["string", "string"] } })).toEqual({ a: { $type: "string" } });
    expect(canonical({ a: { $regex: "x", $options: "ui" } })).toEqual({ a: { $options: "iu", $regex: "x" } });
  });

  it("writes a text search one way", () => {
    expect(canonical({ $text: "needle" })).toEqual({ $text: { $search: "needle" } });
    expect(canonical({ $text: { $search: "n", $fields: ["b", "a"], $caseSensitive: false } })).toEqual({ $text: { $search: "n", $fields: ["a", "b"] } });
  });

  /**
   * A value is data, not a query. Run through the query rewriter, `{ a: { x: 1 } }` became
   * `{ a: { $eq: { x: { $eq: 1 } } } }` — a filter for a document holding `{ x: { $eq: 1 } }`,
   * which is a different question, and it shared a fingerprint with the query it was not.
   */
  it("does not rewrite a value it is comparing with", () => {
    expect(canonical({ a: { x: 1 } })).toEqual({ a: { $eq: { x: 1 } } });
    expect(canonical({ a: { $in: [{ x: 1 }] } })).toEqual({ a: { $in: [{ x: 1 }] } });
    expect(canonical({ a: { $ne: { x: 1 } } })).toEqual({ a: { $ne: { x: 1 } } });
    expect(canonical({ a: { $all: [{ x: 1 }] } })).toEqual({ a: { $all: [{ x: 1 }] } });
    // Two different questions keep two different names.
    expect(fingerprint({ a: { x: 1 } })).not.toBe(fingerprint({ a: { x: { $eq: 1 } } }));
    // A query operand is still a query.
    expect(canonical({ a: { $elemMatch: { x: 1 } } })).toEqual({ a: { $elemMatch: { x: { $eq: 1 } } } });
  });

  it("sorts the keys inside a value, which equality ignores anyway", () => {
    expect(canonical({ a: { z: 1, b: 2 } })).toEqual({ a: { $eq: { b: 2, z: 1 } } });
    expect(fingerprint({ a: { z: 1, b: 2 } })).toBe(fingerprint({ a: { b: 2, z: 1 } }));
  });

  it("treats a string operator's list as the set it is", () => {
    expect(canonical({ a: { $contains: ["b", "a", "b"] } })).toEqual({ a: { $contains: ["a", "b"] } });
  });

  it("settles even when a comment stands beside a one-part $and", () => {
    const once = canonical({ $and: [{ a: 1 }], $comment: "why" });
    expect(once).toEqual({ a: { $eq: 1 } });
    expect(canonical(once)).toEqual(once);
    expect(fingerprint({ $and: [{ a: 1 }], $comment: "why" })).toBe(fingerprint({ a: 1 }));
  });

  it("leaves a date literal and a field reference as they are", () => {
    expect(canonical({ at: { $gt: { $date: "2026-01-01" } }, a: { $field: "b" } })).toEqual({
      a: { $eq: { $field: "b" } },
      at: { $gt: { $date: "2026-01-01" } },
    });
  });

  it("refuses what is not a query", () => {
    expect(() => canonical({ a: { $gtt: 1 } })).toThrow(JqlError);
    expect(() => canonical(() => true)).toThrow(TypeError);
  });
});

describe("fingerprints", () => {
  it("names the same query the same way, however it was written", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: { $eq: 2 }, $comment: "note", a: { $eq: 1 } }));
    expect(fingerprint({ $or: [{ a: 1 }, { b: 2 }] })).toBe(fingerprint({ $or: [{ b: { $eq: 2 } }, { a: 1 }] }));
  });

  it("names different queries differently", () => {
    const names = [{ a: 1 }, { a: 2 }, { b: 1 }, { a: { $gt: 1 } }, { $not: { a: 1 } }].map((query) => fingerprint(query));
    expect(new Set(names).size).toBe(names.length);
  });

  it("is sixteen stable hex characters", () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
  });

  /**
   * The names, written down.
   *
   * A fingerprint is a cache key and the way a saved filter is recognised as one somebody
   * already has, so it has to mean the same thing in the next version as in this one. Every
   * other test here asks only whether two fingerprints agree *with each other*, which every
   * hash in the world would pass — including one that had quietly started naming the same
   * query something else. A change to the canonical form or to the checksum would then miss
   * every cache and duplicate every stored filter in silence.
   *
   * If one of these fails, the question is not "what is the new value" but whether the change
   * to the canonical form was meant. If it was, these change with it, in the same commit, and
   * the changelog says stored keys are invalidated.
   */
  it("gives these queries these names, in this version and the next", () => {
    const pinned: [string, unknown, string][] = [
      ["a plain equality", { status: "open" }, "d4d13aede48bfdad"],
      // The `$and` form of the two-field filter below, which must share its name.
      ["the same, written as an $and", { $and: [{ status: "open" }, { total: { $gte: 100 } }] }, "03646d4ac8b6def3"],
      ["two fields", { status: "open", total: { $gte: 100 } }, "03646d4ac8b6def3"],
      ["a branch", { $or: [{ a: 1 }, { b: { $in: [2, 3] } }] }, "6975b302754d7c56"],
      ["a negation", { $not: { tags: { $all: ["x", "y"] } } }, "5d0f13bd1b10da5d"],
      ["a path and a flag", { "customer.name": { $contains: "Ada", $options: "i" } }, "4be7ef82ea715c7e"],
      ["a date literal", { at: { $gte: { $date: "2026-01-01" } } }, "99e7e03409eaf779"],
      ["a reference", { paid: { $lt: { $field: "total" } } }, "e0dbe3cfe045ad8e"],
      ["an element match", { lines: { $elemMatch: { sku: "pen", quantity: { $gt: 1 } } } }, "c6fffda9c0d6f850"],
      ["a text search", { $text: { $search: "needle", $fields: ["a", "b"] } }, "20b0f8674e32ce96"],
      ["the empty query", {}, "5465b825b8287d02"],
    ];
    for (const [name, query, expected] of pinned) expect(fingerprint(untyped(query as never)), name).toBe(expected);
  });
});

/**
 * Rewriting a query is only safe if it still asks the same question, so the rules are held
 * to that on a spread of queries rather than trusted one at a time.
 */
describe("what the rewriting may never change", () => {
  const documents: unknown[] = [
    { a: 1, b: 2, tags: ["x", "y"], at: "2026-01-02", user: { name: "Ada" } },
    { a: 2, b: 2, tags: [], at: "2025-06-01", user: { name: "Grace" } },
    { a: 1, tags: ["y"], user: {} },
    { b: 1 },
    {},
  ];
  const queries: unknown[] = [
    { a: 1 },
    { a: { $eq: 1 } },
    { a: 1, b: 2 },
    { $and: [{ a: 1 }, { $and: [{ b: 2 }] }] },
    { $or: [{ a: 2 }, { tags: "x" }] },
    { $nor: [{ a: 1 }] },
    { $not: { a: 1 } },
    { a: { $in: [1, 2, 1] } },
    { a: { $nin: [] } },
    { tags: { $all: ["y", "x"] } },
    { tags: { $size: { $gt: 1 } } },
    { "user.name": { $contains: "a", $options: "i" } },
    { at: { $gte: { $date: "2026-01-01" } } },
    { a: { $field: "b" } },
    { b: { $ne: { $field: "a" } } },
    { $text: "ada" },
    { $text: { $search: "ada", $fields: ["user.name"] } },
    { a: { $exists: true }, tags: { $elemMatch: { $startsWith: "x" } } },
    { a: { $not: { $gt: 1 } } },
    { $comment: "a note", a: { $type: ["number", "number"] } },
  ];

  it("asks the same question of every document", () => {
    for (const query of queries) {
      const before = compile(query as never);
      const after = compile(canonical(query as never));
      for (const document of documents) {
        expect(after(document), `${JSON.stringify(query)} on ${JSON.stringify(document)}`).toBe(before(document));
      }
    }
  });

  it("asks the same question for queries nobody wrote by hand", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const next = random(seed);
      const query = makeQuery(next);
      const before = compile(untyped(query));
      const rewritten = canonical(untyped(query));
      const after = compile(rewritten);
      for (let i = 0; i < 8; i++) {
        const document = makeRoot(next);
        if (after(document) !== before(document)) {
          expect.fail(`seed ${seed}: the rewriting changed the answer\n  query: ${JSON.stringify(query)}\n  form:  ${JSON.stringify(rewritten)}\n  doc:   ${JSON.stringify(document)}`);
        }
      }
      // And it settles: a canonical query rewrites to itself, so a fingerprint is stable.
      expect(canonical(rewritten), `seed ${seed}`).toEqual(rewritten);
    }
  });

  it("is settled: rewriting a canonical query changes nothing", () => {
    for (const query of queries) {
      const once = canonical(query as never);
      expect(canonical(once), JSON.stringify(query)).toEqual(once);
    }
  });
});
