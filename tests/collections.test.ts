import { describe, expect, it } from "vitest";
import { compile, count, every, filter, filterMap, filterRecord, find, findEntry, findIndex, partition, some } from "../src/index.js";

/**
 * The helpers over every kind of collection.
 *
 * "Works on any iterable" is a claim about many code paths — arrays are walked by index,
 * array-likes by length, iterables by protocol, maps by value — so each one is exercised
 * here rather than assumed from the array case.
 */

const people = [
  { id: 1, name: "Ada", team: "core" },
  { id: 2, name: "Grace", team: "infra" },
  { id: 3, name: "Alan", team: "core" },
];

describe("over an array", () => {
  it("finds the first match", () => {
    expect(find(people, { id: 2 })).toBe(people[1]);
    expect(find(people, { id: 9 })).toBeUndefined();
  });

  it("filters, counts and partitions", () => {
    expect(filter(people, { team: "core" }).map((person) => person.id)).toEqual([1, 3]);
    expect(count(people, { team: "core" })).toBe(2);
    const [core, rest] = partition(people, { team: "core" });
    expect(core.map((person) => person.id)).toEqual([1, 3]);
    expect(rest.map((person) => person.id)).toEqual([2]);
  });

  it("answers some, every and findIndex", () => {
    expect(some(people, { name: "Grace" })).toBe(true);
    expect(every(people, { id: { $gt: 0 } })).toBe(true);
    expect(every([] as { id: number }[], { id: 1 })).toBe(true);
    expect(findIndex(people, { name: "Alan" })).toBe(2);
    expect(findIndex(people, { name: "Nobody" })).toBe(-1);
  });

  it("takes a compiled query or any predicate", () => {
    const core = compile<(typeof people)[number]>({ team: "core" });
    expect(filter(people, core)).toHaveLength(2);
    expect(filter(people, (person) => person.id === 2)).toEqual([people[1]]);
  });

  it("stops at the first match rather than testing the rest", () => {
    let tested = 0;
    const counting = (person: { id: number }): boolean => {
      tested++;
      return person.id === 1;
    };
    find(people, counting);
    expect(tested).toBe(1);
  });

  it("filters arrays of primitives by conditions on the item itself", () => {
    expect(filter([3, 8, 1, 12], { $gt: 2, $lt: 10 })).toEqual([3, 8]);
    expect(filter(["apple", "banana", "avocado"], { $startsWith: "a" })).toEqual(["apple", "avocado"]);
  });
});

describe("over other collections", () => {
  it("reads a Map by value", () => {
    const byId = new Map(people.map((person) => [person.id, person]));
    expect(find(byId, { name: "Alan" })).toBe(people[2]);
    expect(filter(byId, { team: "core" })).toHaveLength(2);
    expect(count(byId, { team: "infra" })).toBe(1);
  });

  it("keeps the keys with filterMap and findEntry", () => {
    const byName = new Map(people.map((person) => [person.name, person]));
    const core = filterMap(byName, { team: "core" });
    expect([...core.keys()]).toEqual(["Ada", "Alan"]);
    expect(findEntry(byName, { id: 2 })).toEqual(["Grace", people[1]]);
  });

  it("filters a plain object's values and keeps the keys", () => {
    const record = { a: { n: 1 }, b: { n: 5 }, c: { n: 9 } };
    expect(filterRecord(record, { n: { $gt: 3 } })).toEqual({ b: { n: 5 }, c: { n: 9 } });
    expect(findEntry(record, { n: 9 })).toEqual(["c", { n: 9 }]);
  });

  it("keeps a property called __proto__ as data rather than as a prototype", () => {
    const record = JSON.parse('{"a": {"n": 1}, "__proto__": {"n": 1}}') as Record<string, { n: number }>;
    const filtered = filterRecord(record, { n: 1 });
    expect(Object.getPrototypeOf(filtered)).toBe(Object.prototype);
    expect(Object.hasOwn(filtered, "__proto__")).toBe(true);
    expect(({} as { n?: number }).n, "nothing global was touched").toBeUndefined();
  });

  it("walks a Set, a generator and an array-like", () => {
    const set = new Set(people);
    expect(find(set, { id: 3 })).toBe(people[2]);
    function* generate(): Generator<{ id: number }> {
      yield { id: 1 };
      yield { id: 2 };
    }
    expect(filter(generate(), { id: 2 })).toEqual([{ id: 2 }]);
    const arrayLike = { length: 2, 0: { id: 1 }, 1: { id: 2 } };
    expect(find(arrayLike, { id: 2 })).toEqual({ id: 2 });
    expect(filter(new Float64Array([1, 5, 9]), { $gte: 5 })).toEqual([5, 9]);
  });

  it("does not consume more of a generator than it needs", () => {
    let produced = 0;
    function* endless(): Generator<{ id: number }> {
      for (let id = 0; ; id++) {
        produced++;
        yield { id };
      }
    }
    expect(find(endless(), { id: 4 })).toEqual({ id: 4 });
    expect(produced).toBe(5);
  });
});
