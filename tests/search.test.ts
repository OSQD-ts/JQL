import { describe, expect, it } from "vitest";
import { compile, defineVocabulary, JqlError, search, validate } from "../src/index.js";

/**
 * Sorting, paging and projection.
 *
 * The bounded heap is an optimisation, so its one obligation is to be invisible: every
 * request is also answered by the obvious filter, sort and slice, and the two must agree
 * exactly — including the order of ties, which is what keeps paging honest.
 */

interface Row {
  id: number;
  score: number | null | undefined;
  group: string;
  tags: string[];
}

/** A small deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function rows(total: number, seed: number): Row[] {
  const next = random(seed);
  return Array.from({ length: total }, (_, id) => ({
    id,
    // Plenty of ties and some missing values, which is where a sort is most often wrong.
    score: next() < 0.1 ? null : next() < 0.05 ? undefined : Math.floor(next() * 20),
    group: ["a", "b", "c"][Math.floor(next() * 3)] as string,
    tags: next() < 0.5 ? ["x"] : ["y", "z"],
  }));
}

function rank(value: unknown): number {
  return value === null || value === undefined ? 0 : 1;
}

function obvious(data: Row[], descending: boolean): Row[] {
  return [...data].sort((a, b) => {
    const ra = rank(a.score);
    const rb = rank(b.score);
    const order = ra !== rb ? ra - rb : ra === 0 ? 0 : (a.score as number) - (b.score as number);
    return order !== 0 ? (descending ? -order : order) : a.id - b.id;
  });
}

describe("sorting and paging", () => {
  it("agrees with the obvious sort for every page, with and without the heap", () => {
    for (const seed of [1, 2, 3]) {
      const data = rows(500, seed);
      for (const descending of [false, true]) {
        const expected = obvious(data, descending).map((row) => row.id);
        const sort = { score: descending ? -1 : 1 } as const;
        expect(search(data, { sort }).map((row) => row.id)).toEqual(expected);
        for (const [skip, limit] of [
          [0, 10],
          [10, 10],
          [490, 25],
          [0, 0],
          [3, 1],
        ] as const) {
          const page = search(data, { sort, skip, limit }).map((row) => row.id);
          expect(page, `seed ${seed} skip ${skip} limit ${limit}`).toEqual(expected.slice(skip, skip + limit));
        }
      }
    }
  });

  it("breaks ties with the next key, then with arrival order", () => {
    const data = [
      { id: 0, group: "b", score: 1 },
      { id: 1, group: "a", score: 2 },
      { id: 2, group: "b", score: 2 },
      { id: 3, group: "a", score: 2 },
    ];
    expect(search(data, { sort: { group: "asc", score: "desc" } }).map((row) => row.id)).toEqual([1, 3, 2, 0]);
  });

  it("puts values of different types in the specified order", () => {
    const data = [{ v: "b" }, { v: true }, { v: 3 }, {}, { v: null }, { v: { a: 1 } }, { v: 1 }, { v: new Date(0) }, { v: "a" }];
    expect(search(data, { sort: { v: 1 } }).map((row) => row.v)).toEqual([undefined, null, 1, 3, "a", "b", { a: 1 }, true, new Date(0)]);
  });

  /** Every comparison with NaN is false, so it has no place among the numbers. */
  it("sorts a NaN with missing and null rather than among the numbers", () => {
    const data = [{ id: 0, v: 2 }, { id: 1, v: Number.NaN }, { id: 2, v: null }, { id: 3 }, { id: 4, v: -5 }];
    expect(search(data, { sort: { v: 1 } }).map((row) => row.id)).toEqual([1, 2, 3, 4, 0]);
    expect(search(data, { sort: { v: -1 } }).map((row) => row.id)).toEqual([0, 4, 1, 2, 3]);
  });

  it("sorts by the smallest element ascending and the largest descending", () => {
    const data = [
      { id: 0, n: [5, 1] },
      { id: 1, n: [3] },
      { id: 2, n: [4, 9] },
    ];
    expect(search(data, { sort: { n: 1 } }).map((row) => row.id)).toEqual([0, 1, 2]);
    expect(search(data, { sort: { n: -1 } }).map((row) => row.id)).toEqual([2, 0, 1]);
  });

  it("takes a compiled query or any predicate as `where`", () => {
    const data = rows(50, 4);
    const compiled = compile<Row>({ group: "a" });
    expect(search(data, { where: compiled, limit: 3 })).toEqual(data.filter((row) => row.group === "a").slice(0, 3));
    expect(search(data, { where: (row) => row.id < 3 })).toEqual(data.slice(0, 3));
  });

  it("filters before it pages", () => {
    const data = rows(100, 9);
    const expected = data.filter((row) => row.group === "a").slice(5, 10);
    expect(search(data, { where: { group: "a" }, skip: 5, limit: 5 })).toEqual(expected);
  });

  it("stops walking once an unsorted page is full", () => {
    let seen = 0;
    const data = Array.from({ length: 1000 }, (_, id) => ({ id }));
    const counted = new Proxy(data, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) seen++;
        return Reflect.get(target, key, receiver);
      },
    });
    search(counted, { limit: 3 });
    expect(seen).toBe(3);
  });
});

describe("over collections that are not arrays", () => {
  const rows = [
    { id: "a", n: 5 },
    { id: "b", n: 1 },
    { id: "c", n: 9 },
  ];

  it("sorts and pages a Map by its values", () => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(search(byId, { sort: { n: 1 }, limit: 2 }).map((row) => row.id)).toEqual(["b", "a"]);
    expect(search(byId, { where: { n: { $gt: 1 } }, sort: { n: -1 } }).map((row) => row.id)).toEqual(["c", "a"]);
  });

  it("reads a Set and an array-like", () => {
    expect(search(new Set(rows), { sort: { n: -1 }, limit: 1 }).map((row) => row.id)).toEqual(["c"]);
    const arrayLike: ArrayLike<(typeof rows)[number]> = { length: 2, 0: rows[0] as (typeof rows)[number], 1: rows[1] as (typeof rows)[number] };
    expect(search(arrayLike, { sort: { n: 1 } }).map((row) => row.id)).toEqual(["b", "a"]);
  });

  /** The early exit is a promise about generators in particular: an endless one must still answer. */
  it("stops pulling from a generator once an unsorted page is full", () => {
    let produced = 0;
    function* endless(): Generator<{ id: number }> {
      for (let id = 0; ; id++) {
        produced++;
        yield { id };
      }
    }
    expect(search(endless(), { skip: 2, limit: 3 })).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
    expect(produced).toBe(5);
  });
});

describe("projection", () => {
  const data = [{ id: 1, name: "Ada", address: { city: "London", zip: "W1" }, langs: [{ name: "en", level: 5 }, { name: "fr", level: 3 }] }];

  it("keeps the named paths in the document's own shape", () => {
    expect(search(data, { fields: ["id", "address.city"] })).toEqual([{ id: 1, address: { city: "London" } }]);
  });

  it("projects through an array of objects", () => {
    expect(search(data, { fields: ["langs.name"] })).toEqual([{ langs: [{ name: "en" }, { name: "fr" }] }]);
  });

  it("keeps the whole value when a path and its parent are both asked for", () => {
    expect(search(data, { fields: ["address.city", "address"] })).toEqual([{ address: { city: "London", zip: "W1" } }]);
  });

  /**
   * `out[key] = value` with the key "__proto__" replaces the result's prototype instead of
   * adding the field, and `JSON.parse` makes an own `__proto__` property out of ordinary
   * data. The projection used to drop the field and hand back an object that answered to
   * names nobody put on it.
   */
  it("projects a field called __proto__ as data, leaving the result's prototype alone", () => {
    const hostile: Record<string, unknown>[] = [JSON.parse('{"id": 1, "__proto__": {"polluted": "yes"}}')];
    const [projected] = search(hostile, { fields: ["id", "__proto__"] });
    expect(Object.getPrototypeOf(projected as object)).toBe(Object.prototype);
    expect((projected as { polluted?: string }).polluted).toBeUndefined();
    expect(Object.hasOwn(projected as object, "__proto__")).toBe(true);
    expect(({} as { polluted?: string }).polluted, "nothing global was touched").toBeUndefined();
  });

  it("projects a vocabulary's path field into the document's shape, and a computed one under its name", () => {
    const vocabulary = defineVocabulary<(typeof data)[number]>()({
      fields: { city: { path: "address.city" }, label: { get: (row) => `${row.name} (${row.id})` } },
    });
    expect(search(data, { fields: ["city", "label"] }, { vocabulary })).toEqual([{ address: { city: "London" }, label: "Ada (1)" }]);
  });

  /**
   * The query and the projection were given the same path and disagreed about it. Matching
   * followed it to any depth; `pick` walked its own tree of segments and stopped at
   * sixty-four, silently, so past that depth an item matched and came back without the
   * field the request had named. Both sides are bounded by the same limit now.
   */
  it("keeps a path as deep as one is allowed to be", () => {
    const depth = 200;
    const path = Array.from({ length: depth }, (_, index) => `k${index}`).join(".");
    let item: Record<string, unknown> = { value: "here" };
    for (let index = depth - 1; index >= 0; index--) item = { [`k${index}`]: item };
    expect(compile({ [`${path}.value`]: "here" })(item)).toBe(true);
    expect(JSON.stringify(search([item], { fields: [`${path}.value`] }))).toContain("here");
  });

  it("includes a vocabulary's computed field under its name", () => {
    const vocabulary = defineVocabulary<(typeof data)[number]>()({ fields: { label: { get: (row) => `${row.name} (${row.id})` } } });
    expect(search(data, { fields: ["id", "label"] }, { vocabulary })).toEqual([{ id: 1, label: "Ada (1)" }]);
  });
});

describe("dropping fields", () => {
  const rows = [
    { id: 1, user: { name: "Ada", password: "secret" }, items: [{ sku: "p", cost: 3 }] },
    { id: 2, user: { name: "Grace", password: "hunter2" }, items: [] },
  ];

  it("drops a nested path from every result", () => {
    expect(search(rows, { omit: ["user.password"] })).toEqual([
      { id: 1, user: { name: "Ada" }, items: [{ sku: "p", cost: 3 }] },
      { id: 2, user: { name: "Grace" }, items: [] },
    ]);
  });

  it("drops through an array, and drops a whole subtree", () => {
    expect(search(rows, { omit: ["items.cost", "user"] })).toEqual([
      { id: 1, items: [{ sku: "p" }] },
      { id: 2, items: [] },
    ]);
  });

  it("applies after fields", () => {
    expect(search(rows, { fields: ["id", "user"], omit: ["user.password"] })).toEqual([{ id: 1, user: { name: "Ada" } }, { id: 2, user: { name: "Grace" } }]);
  });

  /** A question must not edit what it is asked of. */
  it("copies rather than changing the item, and shares what it did not touch", () => {
    const before = JSON.stringify(rows);
    const results = search(rows, { omit: ["user.password"] });
    expect(JSON.stringify(rows)).toBe(before);
    expect(results[0]?.items, "an untouched subtree is the item's own").toBe(rows[0]?.items);
    // Nothing to drop in this one — its `items` is empty — so the item itself comes back.
    expect(search(rows, { omit: ["items.cost"] })[1]).toBe(rows[1]);
  });

  /** A redaction that quietly gave up returned the field it was asked to remove. */
  it("refuses to redact an item too deep to walk, rather than leaving it in", () => {
    let deep: unknown = { secret: "S" };
    for (let i = 0; i < 700; i++) deep = [deep];
    expect(() => search([{ deep }], { omit: ["deep.secret"] } as never)).toThrow(/cannot be redacted/);
    let shallow: unknown = { secret: "S" };
    for (let i = 0; i < 60; i++) shallow = [shallow];
    expect(JSON.stringify(search([{ deep: shallow }], { omit: ["deep.secret"] } as never))).not.toContain("secret");
  });

  it("drops a vocabulary's field by either of its names", () => {
    const vocabulary = defineVocabulary<(typeof rows)[number]>()({ fields: { secret: { path: "user.password" }, label: { get: (row) => `#${row.id}` } } });
    expect(search(rows, { omit: ["secret"] }, { vocabulary })[0]).toEqual({ id: 1, user: { name: "Ada" }, items: [{ sku: "p", cost: 3 }] });
    expect(search(rows, { fields: ["id", "label"], omit: ["label"] }, { vocabulary })[0]).toEqual({ id: 1 });
  });
});

describe("a path longer than anything can hold", () => {
  const over = Array.from({ length: 513 }, () => "k").join(".");

  /**
   * A field name is the one part of a query the node count does not bound: `{"a.a.a…": 1}`
   * is a single node however long it is, and every segment of it becomes a step in a walk.
   * Past the depth a document walk will follow, such a path can reach nothing anyway.
   */
  it("refuses one past the limit rather than reaching nothing with it", () => {
    expect(() => search([{}], { where: { [over]: 1 } } as never)).toThrow(/past the limit of 512/);
    expect(() => search([{}], { fields: [over] } as never)).toThrow(/past the limit of 512/);
    expect(() => search([{}], { omit: [over] } as never)).toThrow(/past the limit of 512/);
    expect(() => search([{}], { sort: { [over]: 1 } } as never)).toThrow(/past the limit of 512/);
  });

  /**
   * A field name decides how long the sentence refusing it is. Quoting a four-hundred-
   * kilobyte path into the message made the reason unreadable and the log line unusable;
   * `at` still carries the whole thing for a program to read.
   */
  it("says so without quoting the whole path back", () => {
    const enormous = Array.from({ length: 5_000 }, () => "k").join(".");
    const verdict = validate({ [enormous]: 1 });
    expect(verdict.valid).toBe(false);
    if (verdict.valid) return;
    expect(verdict.error.message.length).toBeLessThan(200);
    expect(verdict.error.at).toBe(enormous);
  });
});

describe("refusing a malformed request", () => {
  it("names an unknown key", () => {
    expect(() => search([], { limt: 5 } as never)).toThrow(/did you mean "limit"/);
  });

  it("refuses a limit that is not a whole number", () => {
    expect(() => search([], { limit: -1 })).toThrow(JqlError);
    expect(() => search([], { limit: 1.5 })).toThrow(JqlError);
    expect(() => search([], { skip: "2" } as never)).toThrow(JqlError);
  });

  it("refuses a direction it does not know", () => {
    expect(() => search([{ a: 1 }], { sort: { a: "up" } } as never)).toThrow(/direction/);
  });
});
