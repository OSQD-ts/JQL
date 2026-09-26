import { describe, expect, it } from "vitest";
import { type Capabilities, compile, defineVocabulary, FIELD_OPERATORS, JqlError, plan, QUERY_OPERATORS, untyped } from "../src/index.js";
import { MONGO_CAPABILITIES, toMongoFilter } from "../src/targets/mongo.js";
import { makeQuery, makeRoot, PATHS, random } from "./helpers/generate.js";
import { matchesFilter } from "./helpers/mongo.js";

/**
 * Splitting a query between a store and this engine.
 *
 * One property carries the whole feature: whatever is pushed and whatever stays, the two
 * together must be exactly the query that was asked. Everything else here is about *why* a
 * clause stayed, which is what a caller reads when a store is answering less than it could.
 */

const keyValue: Capabilities = { fields: ["status", "customer.country"], operators: ["$eq", "$in"] };

describe("what a store can answer", () => {
  it("pushes what it can and keeps the rest", () => {
    const split = plan(untyped({ status: "open", total: { $gt: 100 } }), keyValue);
    expect(split.pushed).toEqual({ status: "open" });
    expect(split.remaining).toEqual({ total: { $gt: 100 } });
    expect(split.complete).toBe(false);
    expect(split.kept[0]?.why).toContain('cannot filter on "total"');
  });

  it("says so when the store answers everything", () => {
    const split = plan(untyped({ status: { $in: ["open", "paid"] } }), keyValue);
    expect(split.complete).toBe(true);
    expect(split.remaining).toBeUndefined();
  });

  it("flattens an $and before splitting it", () => {
    const split = plan(untyped({ $and: [{ status: "open" }, { $and: [{ total: { $gt: 1 } }] }] }), keyValue);
    expect(split.pushed).toEqual({ status: "open" });
    expect(split.remaining).toEqual({ total: { $gt: 1 } });
  });

  /** Half an `$or` is not an `$or`: pushing the branches it can would widen the question. */
  it("keeps a whole $or when the store cannot answer one branch", () => {
    const able: Capabilities = { ...keyValue, or: true };
    expect(plan(untyped({ $or: [{ status: "open" }, { status: "paid" }] }), able).complete).toBe(true);
    const split = plan(untyped({ $or: [{ status: "open" }, { total: 1 }] }), able);
    expect(split.pushed).toBeUndefined();
    expect(split.remaining).toEqual({ $or: [{ status: "open" }, { total: 1 }] });
  });

  it("keeps a negation from a store that cannot negate", () => {
    for (const query of [{ status: { $ne: "open" } }, { $not: { status: "open" } }, { status: { $exists: false } }, { $nor: [{ status: "open" }] }]) {
      const split = plan(untyped(query as never), { ...keyValue, operators: "all", or: true });
      expect(split.pushed, JSON.stringify(query)).toBeUndefined();
      expect(split.kept[0]?.why).toContain("negation");
    }
  });

  it("never pushes a field this engine computes", () => {
    const vocabulary = defineVocabulary<{ status: string; total: number }>()({
      fields: { status: {}, band: { get: (row) => (row.total > 50 ? "high" : "low") } },
    });
    const split = plan(untyped({ band: "high" }), { fields: "all", operators: "all" }, { vocabulary });
    expect(split.pushed).toBeUndefined();
    expect(split.kept[0]?.why).toContain("computed here");
  });

  /**
   * The capability check asks whether the store can filter on `customer.country`; pushing
   * `{ cc: "GB" }` afterwards would ask it about a field only this process has a name for.
   * It answers nothing, and `complete` says no second pass is needed — a filter that looks
   * answered and returns an empty page.
   */
  it("pushes a vocabulary field under the name the store knows, not the one we call it", () => {
    const vocabulary = defineVocabulary<{ customer: { country: string; region: string } }>()({
      fields: { country: { path: "customer.country", aliases: ["cc"] } },
    });
    for (const name of ["country", "cc", "COUNTRY"]) {
      const split = plan(untyped({ [name]: "GB" }), keyValue, { vocabulary });
      expect(split.complete, name).toBe(true);
      expect(split.pushed, name).toEqual({ "customer.country": "GB" });
    }
    // A path that continues from a vocabulary field keeps the rest of the walk.
    const deeper = plan(untyped({ "country.region": "north" }), { fields: "all", operators: "all" }, { vocabulary });
    expect(deeper.pushed).toEqual({ "customer.country.region": "north" });
  });

  it("leaves the names alone in what stays here, where they are understood", () => {
    const vocabulary = defineVocabulary<{ customer: { country: string }; total: number }>()({
      fields: { country: { path: "customer.country" }, total: {} },
    });
    const split = plan(untyped({ country: "GB", total: { $gt: 100 } }), keyValue, { vocabulary });
    expect(split.pushed).toEqual({ "customer.country": "GB" });
    expect(split.remaining).toEqual({ total: { $gt: 100 } });
  });

  /**
   * The three ways a vocabulary name used to reach a store that had never heard of it — each
   * pushed whole, each answering nothing, each with `complete: true` saying no second pass
   * was needed.
   */
  it("resolves a name wherever one stands, and nowhere else", () => {
    const vocabulary = defineVocabulary<Record<string, unknown>>()({ fields: { city: { path: "address.city" }, name: {} } });
    const able: Capabilities = { fields: "all", operators: "all", or: true, not: true };
    const at = (query: unknown): unknown => plan(untyped(query as never), able, { vocabulary }).pushed;

    // A value being compared with is data: its keys are not field names.
    expect(at({ name: { $eq: { city: "Paris" } } })).toEqual({ name: { $eq: { city: "Paris" } } });
    expect(at({ name: { $in: [{ city: "Paris" }] } })).toEqual({ name: { $in: [{ city: "Paris" }] } });
    // A reference names a field, so it is resolved like one.
    expect(at({ name: { $eq: { $field: "city" } } })).toEqual({ name: { $eq: { $field: "address.city" } } });
    // So do the fields a text search names.
    expect(at({ $text: { $search: "paris", $fields: ["city"] } })).toEqual({ $text: { $search: "paris", $fields: ["address.city"] } });
    // And a query inside $elemMatch is a query.
    expect(at({ lines: { $elemMatch: { city: "Paris" } } })).toEqual({ lines: { $elemMatch: { "address.city": "Paris" } } });
  });

  it("checks a dotted name against the capabilities under the name it will push", () => {
    const vocabulary = defineVocabulary<Record<string, unknown>>()({ fields: { city: { path: "address.city" } } });
    // The store declared the resolved path, which is what it will be asked about.
    expect(plan(untyped({ "city.zone": "north" }), { fields: ["address.city.zone"], operators: "all" }, { vocabulary }).pushed).toEqual({ "address.city.zone": "north" });
    // And a store that declared only the name this process uses is not asked at all.
    expect(plan(untyped({ "city.zone": "north" }), { fields: ["city.zone"], operators: "all" }, { vocabulary }).pushed).toBeUndefined();
  });

  it("resolves a relative date before the store sees it", () => {
    const now = (): number => Date.parse("2026-09-25T12:00:00Z");
    const split = plan(untyped({ status: "open", at: { $gte: { $date: { $ago: "1h" } } } }), { fields: "all", operators: "all" }, { now });
    // Only the date is rewritten; every other clause reaches the store as it was written.
    expect(split.pushed).toEqual({
      $and: [{ status: "open" }, { at: { $gte: { $date: Date.parse("2026-09-25T11:00:00Z") } } }],
    });
  });

  it("refuses a query that is not one, rather than handing half of it to a store", () => {
    expect(() => plan(untyped({ a: { $gtt: 1 } }), keyValue)).toThrow(JqlError);
    expect(() => plan(() => true, keyValue)).toThrow(TypeError);
  });
});

/**
 * The contract, on data. A store answering `pushed` and this engine filtering the result
 * with `remaining` has to produce exactly what the whole query produces — for every
 * capability set, not only the generous ones.
 */
describe("pushed and remaining are the query", () => {
  const documents: unknown[] = [
    { status: "open", total: 120, customer: { country: "GB" }, tags: ["a", "b"], at: "2026-09-25T11:30:00Z" },
    { status: "paid", total: 40, customer: { country: "US" }, tags: [], at: "2026-09-01T00:00:00Z" },
    { status: "refunded", total: 15, customer: { country: "GB" }, tags: ["b"] },
    { total: 0, customer: {} },
    {},
  ];
  const queries: unknown[] = [
    { status: "open" },
    { status: "open", total: { $gt: 100 } },
    { status: { $in: ["open", "paid"] }, "customer.country": "GB" },
    { $or: [{ status: "open" }, { total: { $lt: 20 } }] },
    { $and: [{ status: "open" }, { $or: [{ total: 120 }, { tags: "b" }] }] },
    { status: { $ne: "open" }, tags: { $size: 1 } },
    { $not: { status: "open" } },
    { tags: { $elemMatch: { $startsWith: "a" } } },
    { at: { $gte: { $date: "2026-09-02" } } },
    { total: { $gt: { $field: "total" } } },
    { $text: "open" },
    { $comment: "a note", status: "open" },
  ];
  const sets: Capabilities[] = [
    { fields: "all", operators: "all", or: true, not: true },
    { fields: "all", operators: "all" },
    keyValue,
    { fields: ["status"], operators: ["$eq"] },
    { fields: [], operators: [] },
    { fields: "all", operators: ["$eq", "$in", "$gt", "$lt", "$size", "$elemMatch", "$startsWith"], or: true },
  ];
  const now = (): number => Date.parse("2026-09-25T12:00:00Z");

  it("agrees with the whole query on every document", () => {
    for (const query of queries) {
      const whole = compile(untyped(query as never), { now });
      for (const capabilities of sets) {
        const split = plan(untyped(query as never), capabilities, { now });
        const store = split.pushed === undefined ? () => true : compile(split.pushed, { now });
        const here = split.remaining === undefined ? () => true : compile(split.remaining, { now });
        for (const document of documents) {
          const together = store(document) && here(document);
          expect(together, `${JSON.stringify(query)} split by ${JSON.stringify(capabilities)} on ${JSON.stringify(document)}`).toBe(whole(document));
          // What a store is asked for is never narrower than the query: too many rows can
          // be filtered down, too few can never be recovered.
          if (whole(document)) expect(store(document), "the pushed half dropped a match").toBe(true);
        }
      }
    }
  });
});

/**
 * The same contract, on queries nobody wrote by hand.
 *
 * The fixed list above is the shapes somebody thought of; this is the ones they did not. The
 * bug that made a store look answered while it returned nothing — a vocabulary name pushed to
 * a store that had never heard of it — was in a shape the fixed list did not hold.
 */
describe("the split holds for generated queries", () => {
  const now = (): number => Date.parse("2026-09-25T12:00:00Z");

  function capabilities(next: () => number): Capabilities {
    const some = <T>(values: readonly T[]): T[] => values.filter(() => next() < 0.5);
    return {
      fields: next() < 0.3 ? "all" : some(PATHS),
      operators: next() < 0.3 ? "all" : some([...FIELD_OPERATORS, ...QUERY_OPERATORS]),
      or: next() < 0.5,
      not: next() < 0.5,
    };
  }

  it("adds back up to the query, whatever the store can do", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const next = random(seed);
      const query = makeQuery(next);
      const able = capabilities(next);
      const split = plan(untyped(query), able, { now });
      const whole = compile(untyped(query), { now });
      const store = split.pushed === undefined ? () => true : compile(split.pushed, { now });
      const here = split.remaining === undefined ? () => true : compile(split.remaining, { now });
      for (let i = 0; i < 10; i++) {
        const document = makeRoot(next);
        const together = store(document) && here(document);
        if (together !== whole(document) || (whole(document) && !store(document))) {
          expect.fail(
            `seed ${seed}: the split does not add up\n  query:  ${JSON.stringify(query)}\n  can:    ${JSON.stringify(able)}\n  pushed: ${JSON.stringify(split.pushed)}\n  kept:   ${JSON.stringify(split.remaining)}\n  doc:    ${JSON.stringify(document)}`,
          );
        }
      }
    }
  });

  /**
   * The store's half is compiled **without** the vocabulary, because that is what a store
   * has: no idea what this process calls its fields. The vocabulary here renames `a` to `b`
   * on purpose, so a pushed name that had not been resolved would ask about the wrong field
   * and the two halves would stop adding up.
   */
  it("hands a store names it knows, not the ones this process uses", () => {
    const vocabulary = defineVocabulary<Record<string, unknown>>()({ fields: { a: { path: "b" }, arr: { path: "arr" } } });
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed + 10_000);
      const query = makeQuery(next);
      const able = capabilities(next);
      const split = plan(untyped(query), able, { now, vocabulary });
      const whole = compile(untyped(query), { now, vocabulary });
      const store = split.pushed === undefined ? () => true : compile(split.pushed, { now });
      const here = split.remaining === undefined ? () => true : compile(split.remaining, { now, vocabulary });
      for (let i = 0; i < 10; i++) {
        const document = makeRoot(next);
        if ((store(document) && here(document)) !== whole(document)) {
          expect.fail(
            `seed ${seed}: the split does not add up through a vocabulary\n  query:  ${JSON.stringify(query)}\n  pushed: ${JSON.stringify(split.pushed)}\n  kept:   ${JSON.stringify(split.remaining)}\n  doc:    ${JSON.stringify(document)}`,
          );
        }
      }
    }
  });
});

describe("as a MongoDB filter", () => {
  const now = (): number => Date.parse("2026-09-25T12:00:00Z");
  const translate = (query: unknown): unknown => {
    const split = plan(untyped(query as never), MONGO_CAPABILITIES, { now });
    expect(split.complete, `${JSON.stringify(query)} was not fully pushable`).toBe(true);
    return toMongoFilter(split.pushed, { now });
  };

  it("passes the operators MongoDB already has straight through", () => {
    expect(translate({ status: "open", total: { $gte: 100 } })).toEqual({ $and: [{ status: "open" }, { total: { $gte: 100 } }] });
    expect(translate({ tags: { $all: ["a"], $size: 2 } })).toEqual({ tags: { $all: ["a"], $size: 2 } });
    expect(translate({ items: { $elemMatch: { sku: "pen" } } })).toEqual({ items: { $elemMatch: { sku: "pen" } } });
  });

  it("writes the string operators as anchored, escaped patterns", () => {
    expect(translate({ name: { $contains: "a.b", $options: "i" } })).toEqual({ name: /a\.b/i });
    expect(translate({ name: { $startsWith: "a+" } })).toEqual({ name: /^a\+/ });
    expect(translate({ name: { $endsWith: "z" } })).toEqual({ name: /z$/ });
    expect(translate({ path: { $glob: "/api/*" } })).toEqual({ path: /^\/api\/[\s\S]*$/ });
    expect(translate({ path: { $contains: ["a", "b"] } })).toEqual({ path: { $in: [/a/, /b/] } });
  });

  /**
   * The bare pattern form, not `{ $eq: /…/ }`: MongoDB reads a bare regex as a match, while
   * `$eq` with one is a comparison with the regex value as often as it is a match, and a
   * filter that rests on which reading a server takes returns the wrong rows on the other.
   */
  it("writes case-insensitive equality as a pattern MongoDB cannot read two ways", () => {
    expect(translate({ status: { $eq: "Open", $options: "i" } })).toEqual({ status: /^Open$/i });
    expect(translate({ status: { $ne: "Open", $options: "i" } })).toEqual({ $nor: [{ status: /^Open$/i }] });
    expect(translate({ status: { $in: ["Open", "Paid"], $options: "i" } })).toEqual({ status: { $in: [/^Open$/i, /^Paid$/i] } });
    expect(translate({ status: { $nin: ["Open"], $options: "i" } })).toEqual({ $nor: [{ status: { $in: [/^Open$/i] } }] });
    // Without the flag, equality is equality and stays as it was written.
    expect(translate({ status: { $eq: "Open" } })).toEqual({ status: { $eq: "Open" } });
  });

  it("gives a date literal as a Date, and a relative one as the instant it resolved to", () => {
    expect(translate({ at: { $lt: { $date: "2026-09-01" } } })).toEqual({ at: { $lt: new Date("2026-09-01") } });
    expect(translate({ at: { $lt: { $date: { $ago: "1h" } } } })).toEqual({ at: { $lt: new Date("2026-09-25T11:00:00Z") } });
  });

  it("writes negation the way MongoDB takes it", () => {
    expect(translate({ $not: { b: 2 } })).toEqual({ $nor: [{ b: 2 }] });
    expect(translate({ s: { $not: { $eq: "x" } } })).toEqual({ $nor: [{ s: { $eq: "x" } }] });
  });

  it("translates the type names it shares", () => {
    expect(translate({ s: { $type: "number" } })).toEqual({ s: { $type: ["double", "int", "long", "decimal"] } });
    expect(translate({ s: { $type: ["string", "date"] } })).toEqual({ s: { $type: ["string", "date"] } });
  });

  /**
   * Some of MongoDB's operators answer exactly for some values and not for others, which a
   * list of operator names cannot say. Each of these used to be pushed whole and come back
   * with the wrong rows — fewer for the equality forms, more for the `$ne` one.
   */
  it("keeps a condition whose values MongoDB would answer differently", () => {
    const cases: [string, unknown][] = [
      ["ignoring case inside a list", { a: { $eq: ["X"], $options: "i" } }],
      ["the same, negated", { a: { $ne: ["X"], $options: "i" } }],
      ["ignoring case inside a set", { a: { $in: [["X"]], $options: "i" } }],
      ["ignoring case inside an object", { a: { $eq: { b: "X" }, $options: "i" } }],
      ["an embedded document, whose keys MongoDB compares in order", { a: { $eq: { b: 1, c: 2 } } }],
      ["a whole number held as a double, which is not MongoDB's `int`", { a: { $type: "integer" } }],
      // JSON cannot carry a bigint at all, and a driver hands back an ordinary number for a
      // stored `long`: MongoDB would answer with rows this engine says are not bigints, and
      // `complete` would have said no second pass was needed.
      ["a bigint, which is a run-time type rather than a stored one", { a: { $type: "bigint" } }],
      ["a flag MongoDB's patterns do not take", { a: { $regex: "x", $options: "u" } }],
    ];
    for (const [name, query] of cases) {
      const split = plan(untyped(query as never), MONGO_CAPABILITIES, { now });
      expect(split.pushed, name).toBeUndefined();
      expect(split.remaining, name).toEqual(query);
    }
  });

  it("still pushes the same operators where the values are ones MongoDB shares", () => {
    expect(translate({ a: { $eq: "X", $options: "i" } })).toEqual({ a: /^X$/i });
    expect(translate({ a: { $eq: ["x"] } })).toEqual({ a: { $eq: ["x"] } });
    expect(translate({ a: { $type: ["string", "number"] } })).toEqual({ a: { $type: ["string", "double", "int", "long", "decimal"] } });
    expect(translate({ a: { $regex: "x", $options: "i" } })).toEqual({ a: { $regex: "x", $options: "i" } });
  });

  /**
   * The translation, checked by running it.
   *
   * Every other rewriting in this package is held to "does it still answer the same
   * question", and this one was held to "does it look right" — which cannot catch the
   * failure the module exists to avoid: a filter that is *nearly* right, from a store that
   * looked like it had answered. `tests/helpers/mongo.ts` is a second reading of MongoDB's
   * own matching rules, written from its documented behaviour rather than from this engine,
   * so the two disagreeing is a signal rather than a shared mistake.
   *
   * Documents here hold no array directly inside another array, because that is the one
   * shape where the two languages genuinely differ (specification §3): MongoDB applies a
   * path segment to the elements of an array but not to the elements of *those* arrays,
   * while JQL sees an array through wherever it meets one.
   */
  it("answers what the query asks, for queries nobody wrote by hand", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const query = makeQuery(next);
      const split = plan(untyped(query), MONGO_CAPABILITIES, { now });
      const whole = compile(untyped(query), { now });
      const here = split.remaining === undefined ? () => true : compile(split.remaining, { now });
      const filter = split.pushed === undefined ? undefined : (toMongoFilter(split.pushed, { now }) as Record<string, unknown>);
      for (let i = 0; i < 8; i++) {
        // Plain JSON: MongoDB has no `Map`, and a stored document is JSON.
        const document = JSON.parse(JSON.stringify(makeRoot(next))) as unknown;
        if (!flat(document)) continue;
        const answered = (filter === undefined || matchesFilter(document, filter)) && here(document);
        expect(answered, `seed ${seed}\n  query:    ${JSON.stringify(query)}\n  pushed:   ${JSON.stringify(split.pushed)}\n  remaining:${JSON.stringify(split.remaining)}\n  document: ${JSON.stringify(document)}`).toBe(whole(document));
      }
    }
  });

  /** Whether no array in the value holds another array directly — see §3. */
  function flat(value: unknown): boolean {
    if (Array.isArray(value)) return value.every((element) => !Array.isArray(element) && flat(element));
    if (value === null || typeof value !== "object") return true;
    return Object.values(value as Record<string, unknown>).every(flat);
  }

  /** The operators MongoDB cannot answer exactly are not in its capabilities, so plan keeps them. */
  it("never sees what MongoDB cannot do", () => {
    for (const query of [{ a: { $word: "1.2.3" } }, { a: { $length: 3 } }, { a: { $field: "b" } }, { $text: "x" }]) {
      const split = plan(untyped(query as never), MONGO_CAPABILITIES, { now });
      expect(split.pushed, JSON.stringify(query)).toBeUndefined();
    }
    expect(() => toMongoFilter({ a: { $word: "x" } })).toThrow(JqlError);
  });

  /**
   * `keep` called itself the second lock on the door `plan` closes, and was not one: it
   * filtered the flags it could not use out of the pattern and carried on. Dropping `u`
   * changes what the pattern means, and passing it on gives the server a filter it refuses
   * outright — so the query fails later, somewhere else, for a reason nobody can place.
   */
  it("refuses a pattern flag MongoDB does not know, rather than dropping it", () => {
    for (const query of [{ a: { $regex: "x", $options: "u" } }, { a: { $contains: "x", $options: "iu" } }, { a: { $glob: "x*", $options: "u" } }]) {
      expect(() => toMongoFilter(query), JSON.stringify(query)).toThrow(/no "u" flag/);
    }
    expect(toMongoFilter({ a: { $regex: "x", $options: "ims" } })).toEqual({ a: { $regex: "x", $options: "ims" } });
  });
});
