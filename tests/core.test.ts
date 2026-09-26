import { describe, expect, it } from "vitest";
import { compile, DEFAULT_LIMITS, JqlError, matches, UNTRUSTED_LIMITS, untyped, validate } from "../src/index.js";

/**
 * What the engine does beyond what JSON documents can show.
 *
 * The conformance suite pins the language on JSON data. These are the places the engine
 * meets things JSON never produces — `Date` objects, `Map`s, bigints, prototypes — and the
 * refusals that exist because a query written in code can hold values a JSON one cannot.
 */

function refusal(query: unknown, options?: Parameters<typeof compile>[1]): JqlError {
  try {
    compile(query as never, options);
  } catch (error) {
    if (error instanceof JqlError) return error;
    throw error;
  }
  throw new Error("the query was accepted");
}

describe("documents JSON cannot express", () => {
  it("compares Date objects with a $date literal", () => {
    const event = { at: new Date("2026-09-01T12:00:00Z") };
    expect(matches(event, { at: { $gt: { $date: "2026-09-01" } } })).toBe(true);
    expect(matches(event, { at: { $lt: { $date: "2026-09-01" } } })).toBe(false);
    expect(matches(event, { at: { $date: "2026-09-01T12:00:00.000Z" } })).toBe(true);
    // Epoch milliseconds are a date too, once the query says it is comparing dates.
    expect(matches({ at: Date.UTC(2026, 0, 1) }, { at: { $gte: { $date: "2026-01-01" } } })).toBe(true);
  });

  it("types a Date as a date and not an object", () => {
    expect(matches({ at: new Date() }, { at: { $type: "date" } })).toBe(true);
    expect(matches({ at: new Date() }, { at: { $type: "object" } })).toBe(false);
  });

  it("orders bigints with numbers, and types them as numbers too", () => {
    expect(matches({ n: 10n }, { n: { $gt: 5 } })).toBe(true);
    expect(matches({ n: 10n }, { n: { $type: "bigint" } })).toBe(true);
    // `$gt` treating a value as a number while `$type` did not was a distinction nobody
    // could explain.
    expect(matches({ n: 10n }, { n: { $type: "number" } })).toBe(true);
    expect(matches({ n: 10n }, { n: { $type: "integer" } })).toBe(true);
    // The same argument reaches $mod, which the specification defines over "a reached
    // number": `%` refuses to mix the two kinds, so a bigint used to match nothing at all.
    expect(matches({ n: 10n }, { n: { $mod: [3, 1] } })).toBe(true);
    expect(matches({ n: 10n }, { n: { $mod: [3, 2] } })).toBe(false);
    expect(matches({ n: -10n }, { n: { $mod: [3, -1] } })).toBe(true);
    // A divisor with a fraction cannot divide one, and says so by matching nothing.
    expect(matches({ n: 10n }, { n: { $mod: [2.5, 0] } })).toBe(false);
    expect(matches({ n: 10 }, { n: { $mod: [2.5, 0] } })).toBe(true);
    // A bigint far past what a number holds exactly still answers.
    expect(matches({ n: 123456789012345678901234567890n }, { n: { $mod: [10, 0] } })).toBe(true);
  });

  /**
   * Ordering said `10n` and `10` were the same value and equality said they were not, so one
   * document was at once `$gte: 10`, `$lte: 10` and `$ne: 10` — which nothing can be. A query
   * cannot carry a big integer of its own (JSON has none, and one is refused), so an ordinary
   * number is the only way to ask about such a value at all.
   */
  it("compares a bigint with the number a query can actually write", () => {
    const item = { id: 10n, list: [1n, 2n], deep: { n: 10n } };
    expect(matches(item, { id: 10 })).toBe(true);
    expect(matches(item, { id: { $eq: 10 } })).toBe(true);
    expect(matches(item, { id: { $ne: 10 } })).toBe(false);
    expect(matches(item, { id: { $in: [9, 10] } })).toBe(true);
    expect(matches(item, { id: { $nin: [10] } })).toBe(false);
    expect(matches(item, { list: { $all: [1, 2] } })).toBe(true);
    // Through an array, and inside a literal being compared whole.
    expect(matches(item, { list: 2 })).toBe(true);
    expect(matches(item, { deep: { n: 10 } })).toBe(true);
    expect(matches(item, { list: { $eq: [1, 2] } })).toBe(true);
    // A number that is not whole is no big integer, and nothing about this changes that.
    expect(matches(item, { id: 10.5 })).toBe(false);
    expect(matches({ id: 10 }, { id: 10 })).toBe(true);
    expect(matches({ id: "10" }, untyped({ id: 10 }))).toBe(false);
    // Two document values through a reference, where either side may be the big one.
    expect(matches({ a: 10n, b: 10 }, { a: { $eq: { $field: "b" } } })).toBe(true);
    expect(matches({ a: 10n, b: 11 }, { a: { $eq: { $field: "b" } } })).toBe(false);
    // And a value too large to be a number exactly is still only equal to itself.
    expect(matches({ id: 9007199254740993n }, { id: 9007199254740992 })).toBe(false);
  });

  /**
   * A relative date read by a function that knows only absolute ones came out `NaN`, so a
   * clause holding one inside a list or an object quietly matched nothing — while the same
   * literal written on its own worked.
   */
  it("resolves a relative date nested inside a value", () => {
    const now = (): number => Date.parse("2026-09-25T12:00:00Z");
    expect(matches({ a: { b: new Date(now()) } }, { a: { b: { $date: "now" } } }, { now })).toBe(true);
    expect(matches({ a: [new Date(now() - 2000)] }, { a: { $eq: [{ $date: { $ago: "2s" } }] } }, { now })).toBe(true);
    expect(matches({ a: [new Date(now() - 1000)] }, { a: { $eq: [{ $date: { $ago: "2s" } }] } }, { now })).toBe(false);
  });

  /**
   * A document's date is an ISO 8601 string. What a host language's own parser takes beyond
   * that is its own business, and a document that matched in one implementation and not in
   * another would make the same query mean two things.
   */
  it("reads only an ISO 8601 string as a date", () => {
    const after2020 = { t: { $gt: { $date: "2020-01-01" } } } as const;
    expect(matches({ t: "2020-12-31" }, after2020)).toBe(true);
    expect(matches({ t: "2020-12-31T10:00:00Z" }, after2020)).toBe(true);
    expect(matches({ t: "2020-12-31 10:00:00" }, after2020), "RFC 3339 allows the space, and people write it").toBe(true);
    expect(matches({ t: "12/31/2020" }, after2020)).toBe(false);
    expect(matches({ t: "Mar 5 2021" }, after2020)).toBe(false);
    expect(matches({ t: "5" }, after2020), "which Date.parse reads as a year").toBe(false);
  });

  /**
   * The marker standing for `*` used to be a string, which a pattern can also contain: the
   * glob `a*\u0000\*` re-formed it when the pieces were joined and matched everything.
   */
  it("keeps a glob's own markers out of reach of the pattern", () => {
    expect(matches({ a: "abc" }, { a: { $glob: "a*\u0000\\*" } })).toBe(false);
    expect(matches({ a: "a\u0000*" }, { a: { $glob: "a*\u0000\\*" } })).toBe(true);
  });

  it("counts a word boundary in characters, not in halves of one", () => {
    // A lone surrogate is in no Unicode category, so half a letter looked like a separator.
    expect(matches({ s: "\u{1D400}\u{1D401}" }, { s: { $word: "\u{1D400}" } })).toBe(false);
    expect(matches({ s: "\u{1D400}.b" }, { s: { $word: "\u{1D400}" } })).toBe(true);
  });

  it("reads a Map document by key, and a Map on the way down a path", () => {
    const document = new Map<string, unknown>([
      ["id", 7],
      ["meta", new Map([["owner", "ada"]])],
    ]);
    expect(matches(document, { id: 7 })).toBe(true);
    expect(matches(document, { "meta.owner": "ada" })).toBe(true);
    expect(matches(document, { id: { $in: [6, 7] } })).toBe(true);
  });

  /**
   * `size` and `get` are the Map's own members. Read directly, `{ size: 2 }` asked the Map
   * how many entries it had, rather than what its `size` entry held.
   */
  it("answers a Map's own member names with its entries, not its methods", () => {
    const document = new Map<string, unknown>([["size", "large"]]);
    expect(matches(document, { size: "large" })).toBe(true);
    expect(matches(new Map([["a", 1]]), { size: 1 })).toBe(false);
    expect(matches(new Map(), { get: { $exists: true } })).toBe(false);
  });
});

describe("an item that is itself an array", () => {
  const lines = [[{ sku: "pen" }, { sku: "ink" }], [{ sku: "pad" }], [], [3, 4]];

  /**
   * The first segment of a path is a segment like any other. Read straight off the array as
   * a property it answered `undefined`, so `{ sku: "pen" }` missed the item holding a pen —
   * and `{ sku: { $exists: false } }` matched it, which is a filter widening rather than
   * narrowing. Two segments over the same data were already right, so the library disagreed
   * with itself one segment apart.
   */
  it("is seen through, as an array met anywhere else is", () => {
    expect(lines.filter(compile(untyped({ sku: "pen" })))).toEqual([lines[0]]);
    expect(lines.filter(compile(untyped({ sku: { $exists: true } })))).toEqual([lines[0], lines[1]]);
    expect(lines.filter(compile(untyped({ sku: { $exists: false } })))).toEqual([lines[2], lines[3]]);
    expect(matches([{ sku: "pen" }], untyped({ sku: { $gt: "a" } }))).toBe(true);
  });

  it("names its elements by position", () => {
    expect(lines.filter(compile(untyped({ "0.sku": "pad" })))).toEqual([lines[1]]);
  });

  /** `length` is a property of the array, not a field of the item. `$size` asks that. */
  it("does not answer with its own length", () => {
    expect(matches([1, 2, 3], untyped({ length: 3 }))).toBe(false);
    expect(matches([1, 2, 3], untyped({ length: { $exists: true } }))).toBe(false);
    expect(matches({ tags: [1, 2, 3] }, { tags: { $size: 3 } })).toBe(true);
  });
});

describe("what a query can never reach", () => {
  it("does not see inherited properties", () => {
    // Written as untyped queries: the types already know these names are not fields.
    expect(matches({}, untyped({ constructor: { $exists: true } }))).toBe(false);
    expect(matches({}, untyped({ toString: { $exists: true } }))).toBe(false);
    expect(matches({}, untyped({ "__proto__.polluted": { $exists: false } }))).toBe(true);
    expect(matches({ items: [{}] }, untyped({ "items.hasOwnProperty": { $exists: true } }))).toBe(false);
  });

  it("still sees an own property with an inherited name", () => {
    expect(matches({ constructor: "mine" }, { constructor: "mine" })).toBe(true);
  });

  /**
   * The guard used to be a list of the names `Object.prototype` and `Map.prototype` have,
   * so a document that was a class instance answered from its prototype — and answered
   * `{ secret: … }` by *running* an inherited getter, which is a query executing code the
   * document's author wrote. Ownership is now asked before every read, which is also why no
   * accessor outside the item can run at all.
   */
  it("sees nothing a document inherits, and runs no inherited getter", () => {
    let ran = 0;
    class Record_ {
      id = 1;
      get secret(): string {
        ran++;
        return "shh";
      }
      isAdmin(): boolean {
        return true;
      }
    }
    (Record_.prototype as unknown as Record<string, unknown>).role = "admin";
    const document = new Record_();

    expect(matches(document, untyped({ id: 1 })), "its own fields are still visible").toBe(true);
    expect(matches(document, untyped({ role: "admin" }))).toBe(false);
    expect(matches(document, untyped({ role: { $exists: true } }))).toBe(false);
    expect(matches(document, untyped({ secret: "shh" }))).toBe(false);
    expect(matches(document, untyped({ isAdmin: { $exists: true } }))).toBe(false);
    expect(matches({ x: document }, untyped({ "x.role": "admin" }))).toBe(false);
    // A negation must not widen either: the field is missing, so `$ne` holds.
    expect(matches(document, untyped({ role: { $ne: "admin" } }))).toBe(true);
    expect(ran, "an inherited getter was never invoked").toBe(0);
  });

  /**
   * A document is data from outside, and a walk over it that could not stop would be a way
   * to end the process: ten thousand nested arrays threw a RangeError out of the predicate,
   * which aborts a whole scan over one row.
   */
  it("stops descending into a document nested past any sane depth", () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 20_000; i++) deep = [deep];
    const test = compile(untyped({ "a.leaf": 1 }));
    expect(() => test({ a: deep })).not.toThrow();
    // Shallow enough to reach, and it still does.
    let shallow: unknown = { leaf: 1 };
    for (let i = 0; i < 50; i++) shallow = [shallow];
    expect(test({ a: shallow })).toBe(true);
  });

  it("walks a cyclic document without looping", () => {
    const document: Record<string, unknown> = { name: "loop" };
    document.self = document;
    expect(matches(document, { $text: "nothing like this" })).toBe(false);
    expect(matches(document, { $text: "loop" })).toBe(true);
  });
});

describe("refusing what JSON cannot carry", () => {
  it("refuses a RegExp object and names the JSON spelling", () => {
    expect(refusal({ name: /ada/ }).message).toMatch(/\$regex/);
  });

  it("refuses a Date object and names the JSON spelling", () => {
    expect(refusal({ at: new Date() }).message).toMatch(/\$date/);
  });

  /**
   * `{ id: user.id }` where `user.id` is undefined used to be the classic silent failure
   * of this kind of API: a condition on nothing, which matched everything.
   */
  it("refuses an undefined value rather than matching everything", () => {
    const error = refusal({ id: undefined });
    expect(error.at).toBe("id");
    expect(error.message).toMatch(/match everything/);
    expect(refusal({ age: { $gt: undefined } }).at).toBe("age.$gt");
  });

  it("refuses NaN and Infinity as values", () => {
    expect(() => compile({ n: Number.NaN })).toThrow(JqlError);
    expect(() => compile({ n: { $gt: Number.NaN } })).toThrow(JqlError);
    expect(() => compile({ n: { $in: [Number.POSITIVE_INFINITY] } })).toThrow(JqlError);
  });

  it("refuses a function as a value", () => {
    expect(refusal({ f: () => 1 }).message).toMatch(/not JSON/);
  });
});

describe("the refusals say what was meant", () => {
  it("says what it was given when that is not a query", () => {
    // "a query is an object, not an object" was what a Map, a Set and a class instance
    // each used to produce.
    expect(refusal(new Map()).message).toContain("not a Map");
    expect(refusal(new Set()).message).toContain("not a Set");
    class Order {}
    expect(refusal(new Order()).message).toContain("not an instance of Order");
    expect(refusal([{ a: 1 }]).message).toContain("not an array");
    expect(refusal("a").message).toContain('not the string "a"');
    // A `constructor` field of the caller's own does not get to name the value.
    expect(refusal(JSON.parse('{"a": {"$gtt": 1, "constructor": "Sneaky"}}')).message).toContain("mixes operators with field names");
  });

  it("suggests the operator a typo was probably for", () => {
    expect(refusal({ age: { $gtt: 5 } }).message).toContain('did you mean "$gt"');
    expect(refusal({ name: { $contain: "a" } }).message).toContain('did you mean "$contains"');
    expect(refusal({ $nr: [] }).message).toContain('did you mean "$or"');
  });

  it("suggests a type name", () => {
    expect(refusal({ n: { $type: "strng" } }).message).toContain('did you mean "string"');
  });

  it("points at the place in the query", () => {
    const error = refusal({ $or: [{ a: 1 }, { b: { $in: 3 } }] });
    expect(error.at).toBe("$or[1].b.$in");
    expect(error.message.startsWith("at $or[1].b.$in: ")).toBe(true);
  });

  it("answers through validate without throwing, and hands back the predicate", () => {
    const good = validate<{ a: number }>({ a: 1 });
    expect(good.valid).toBe(true);
    // The predicate comes from the same call, so it cannot have been compiled with
    // different limits from the ones the query was checked against.
    if (good.valid) expect([{ a: 1 }, { a: 2 }].filter(good.test)).toEqual([{ a: 1 }]);
    const result = validate({ a: { $bogus: 1 } });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error.at).toBe("a.$bogus");
  });

  it("applies the limits it was given to the predicate it returns", () => {
    const result = validate({ a: { $regex: "x" } }, { limits: UNTRUSTED_LIMITS });
    expect(result.valid).toBe(false);
  });
});

describe("operators a project adds", () => {
  const rows = [{ ip: "203.0.113.5" }, { ip: "8.8.8.8" }];
  const cidr = {
    name: "$xCidr",
    compile: (operand: unknown, at: string) => {
      if (typeof operand !== "string") throw new JqlError("takes a network as a string", at);
      const prefix = `${operand.split("/")[0]?.split(".").slice(0, 3).join(".")}.`;
      return (value: unknown) => typeof value === "string" && value.startsWith(prefix);
    },
  };

  it("runs an operator the language does not have", () => {
    expect(rows.filter(compile({ ip: { $xCidr: "203.0.113.0/24" } } as never, { operators: [cidr] }))).toEqual([rows[0]]);
  });

  it("refuses the same query where the operator was not given", () => {
    expect(refusal({ ip: { $xCidr: "203.0.113.0/24" } }).message).toMatch(/added operator.*pass it in/);
  });

  /**
   * The `$x` prefix is what tells a reader that a stored filter needs more than a standard
   * engine, and what keeps a future version of the language from colliding with one.
   */
  it("refuses a name that does not say it is an addition", () => {
    expect(() => compile({ a: 1 }, { operators: [{ name: "$cidr", compile: () => () => true }] })).toThrow(/\$x and a capital/);
    expect(() => compile({ a: 1 }, { operators: [cidr, cidr] })).toThrow(/given twice/);
  });

  it("carries the operator's own refusal out to whoever wrote the query", () => {
    const error = refusal({ ip: { $xCidr: 5 } }, { operators: [cidr] });
    expect(error.at).toBe("ip.$xCidr");
    expect(error.message).toContain("takes a network as a string");
  });

  it("is tried against the elements of an array unless it says otherwise", () => {
    const whole = { name: "$xLong", compile: () => (value: unknown) => Array.isArray(value), elementwise: false };
    expect(compile({ tags: { $xCidr: "203.0.113.0/24" } } as never, { operators: [cidr] })({ tags: ["203.0.113.9"] })).toBe(true);
    expect(compile({ tags: { $xLong: true } } as never, { operators: [whole] })({ tags: ["a"] })).toBe(true);
  });
});

describe("a text search's own options", () => {
  /**
   * `?? false` and `?? vocabulary.text` swallowed an explicit `null`, so a search of two
   * named fields silently became a search of the whole item.
   */
  it("refuses a null where a list of fields or a flag belongs", () => {
    expect(refusal({ $text: { $search: "x", $fields: null } }).message).toMatch(/non-empty list/);
    expect(refusal({ $text: { $search: "x", $caseSensitive: null } }).message).toMatch(/true or false/);
  });

  /**
   * An empty phrase matches everything, and the engine said so before it had looked at
   * `$fields` at all — so the same saved filter was valid while the box was empty and
   * refused after the first letter. A dashboard that validates what it stores was told its
   * filter was good by the one call whose job is to say otherwise.
   */
  it("checks the fields whichever phrase stands beside them", () => {
    for (const phrase of ["", "x"]) {
      expect(refusal({ $text: { $search: phrase, $fields: 42 } }).message, phrase).toMatch(/non-empty list/);
      expect(refusal({ $text: { $search: phrase, $fields: [] } }).message, phrase).toMatch(/non-empty list/);
      expect(refusal({ $text: { $search: phrase, $fields: [7] } }).message, phrase).toMatch(/field name is a string/);
    }
    // An empty phrase still matches everything once its fields are good ones.
    expect(matches({ a: "anything" }, { $text: { $search: "", $fields: ["a"] } })).toBe(true);
  });
});

describe("comparing one field with another", () => {
  const rows = [
    { id: 0, out: 900, in: 100 },
    { id: 1, out: 100, in: 900 },
    { id: 2, out: 5 },
  ];

  it("compares, and matches nothing where the other field is absent", () => {
    expect(rows.filter(compile({ out: { $gt: { $field: "in" } } })).map((row) => row.id)).toEqual([0]);
    expect(rows.filter(compile({ out: { $field: "in" } })).map((row) => row.id)).toEqual([]);
  });

  /**
   * Found by the differential test: a `$not` holding a reference used to drop it, because
   * only the tests that look at one value were being negated. The query read as
   * restrictive and never looked at the other field at all.
   */
  it("does not lose a reference inside a negation", () => {
    const test = compile(untyped({ out: { $not: { $exists: false, $eq: { $field: "in" } } } }));
    // Row 2 has no `in`, so the inner condition cannot hold, so its negation does.
    expect(rows.filter(test).map((row) => row.id)).toEqual([0, 1, 2]);
    const equal = [{ a: 1, b: 1 }, { a: 1, b: 2 }];
    expect(equal.filter(compile(untyped({ a: { $not: { $eq: { $field: "b" } } } })))).toEqual([{ a: 1, b: 2 }]);
  });

  it("reads both sides of a nested path", () => {
    const nested = [{ a: { x: 5 }, b: { y: 3 } }, { a: { x: 1 }, b: { y: 3 } }];
    expect(nested.filter(compile({ "a.x": { $gt: { $field: "b.y" } } }))).toHaveLength(1);
  });
});

describe("relative dates", () => {
  const rows = [{ at: "2026-09-22T11:30:00Z" }, { at: "2026-09-20T11:30:00Z" }];
  const now = (): number => Date.parse("2026-09-22T12:00:00Z");

  it("resolves against the clock it was given", () => {
    expect(rows.filter(compile({ at: { $gte: { $date: { $ago: "1h" } } } }, { now }))).toHaveLength(1);
    expect(rows.filter(compile({ at: { $gte: { $date: { $ago: "1w" } } } }, { now }))).toHaveLength(2);
  });

  /**
   * Read once, when the query compiles. A window that moved during a scan would judge two
   * items a second apart against different hours, and no result would be explicable.
   */
  it("reads the clock once, not once per item", () => {
    let reads = 0;
    const ticking = (): number => {
      reads++;
      return Date.parse("2026-09-22T12:00:00Z");
    };
    const test = compile({ at: { $gte: { $date: { $ago: "1h" } } } }, { now: ticking });
    rows.filter(test);
    rows.filter(test);
    expect(reads).toBe(1);
  });

  it("refuses a duration nobody can size", () => {
    expect(refusal({ at: { $gte: { $date: { $ago: "1mo" } } } }).message).toMatch(/is not a date/);
    expect(refusal({ at: { $gte: { $date: { $ago: "1h", $ahead: "2h" } } } })).toBeInstanceOf(JqlError);
  });
});

describe("limits", () => {
  it("refuses a query nested past the depth limit", () => {
    let query: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < DEFAULT_LIMITS.maxDepth + 2; i++) query = { $and: [query] };
    expect(refusal(query).message).toMatch(/nests deeper/);
  });

  it("does not overflow the stack on a query nested far past it", () => {
    let query: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 100_000; i++) query = { $not: query };
    expect(() => compile(query)).toThrow(JqlError);
  });

  it("refuses a query with more operators than the limit", () => {
    const query = { $or: Array.from({ length: 20 }, (_, i) => ({ [`f${i}`]: i })) };
    expect(() => compile(query, { limits: { maxNodes: 10 } })).toThrow(/more than 10/);
    expect(() => compile(query)).not.toThrow();
  });

  it("does not count a long $in against the node limit", () => {
    const ids = Array.from({ length: 50_000 }, (_, i) => i);
    const test = compile({ id: { $in: ids } }, { limits: UNTRUSTED_LIMITS });
    expect(test({ id: 49_999 })).toBe(true);
  });

  it("turns patterns off for untrusted queries", () => {
    expect(refusal({ a: { $regex: "x" } }, { limits: UNTRUSTED_LIMITS }).message).toMatch(/turned off/);
    expect(() => compile({ a: { $contains: "x" } }, { limits: UNTRUSTED_LIMITS })).not.toThrow();
  });

  /**
   * `$regex` is turned off for untrusted callers while `$glob` stays on, which is exactly
   * when a glob's own cap has to hold: matching one that holds `?` costs the pattern's
   * length times the value's.
   */
  it("refuses a glob longer than the limit", () => {
    expect(() => compile({ a: { $glob: "?".repeat(2000) } })).toThrow(/past the limit/);
    expect(() => compile({ a: { $glob: "?".repeat(300) } }, { limits: UNTRUSTED_LIMITS })).toThrow(/past the limit/);
    expect(() => compile({ a: { $glob: "x*" } }, { limits: UNTRUSTED_LIMITS }), "an ordinary glob still works where patterns are off").not.toThrow();
  });

  it("refuses a pattern longer than the limit", () => {
    expect(() => compile({ a: { $regex: "a".repeat(2000) } })).toThrow(/past the limit/);
  });
});

describe("compiling", () => {
  it("hands back a predicate that was passed in, untouched", () => {
    const predicate = (value: { id: number }): boolean => value.id > 1;
    expect(compile(predicate)).toBe(predicate);
  });

  it("never hands out a shared predicate", () => {
    expect(compile({})).not.toBe(compile({}));
    expect(compile({ $or: [] })).not.toBe(compile({ $or: [] }));
  });

  /**
   * The parts of an `$and` are reordered by cost. That is only safe if every order gives
   * the same answer, so the same conditions are written in every order here and must agree
   * on every document.
   */
  it("gives the same answer whatever order the conditions are written in", () => {
    const parts = [{ a: 1 }, { b: { $regex: "^x" } }, { $text: "needle" }, { "c.d": { $gt: 2 } }];
    const documents = [
      { a: 1, b: "xyz", c: { d: 3 }, e: "needle" },
      { a: 1, b: "xyz", c: { d: 1 }, e: "needle" },
      { a: 2, b: "xyz", c: { d: 3 }, e: "needle" },
      { a: 1, b: "yz", c: { d: 3 }, e: "hay" },
    ];
    const orders = [parts, [...parts].reverse(), [parts[2], parts[0], parts[3], parts[1]]];
    const answers = orders.map((order) => {
      const test = compile({ $and: order } as never);
      return documents.map((document) => test(document));
    });
    expect(answers[0]).toEqual([true, false, false, false]);
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);
  });

  it("does not cache: a query edited after use means the edit", () => {
    const query: Record<string, unknown> = { id: 1 };
    const items = [{ id: 1 }, { id: 2 }];
    expect(items.filter(compile(untyped(query)))).toEqual([{ id: 1 }]);
    query.id = 2;
    expect(items.filter(compile(untyped(query)))).toEqual([{ id: 2 }]);
  });
});
