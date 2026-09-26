import { afterAll, describe, expect, it } from "vitest";
import { install, uninstall } from "../src/global.js";

/**
 * The query methods on the built-ins.
 *
 * The first two cases are the two ways of calling it that the library was asked to
 * support, written exactly as they were asked for.
 */

afterAll(() => {
  uninstall();
});

describe("the methods on arrays", () => {
  it("finds an item with arr.jqlSearch", () => {
    const arr = [{ id: 1 }, { id: 2 }];
    const object2 = arr.jqlSearch({ id: 2 });
    expect(object2).toBe(arr[1]);
  });

  it("finds an item with Array.jqlSearch", () => {
    const arr = [{ id: 1 }, { id: 2 }];
    const object2 = Array.jqlSearch(arr, { id: 2 });
    expect(object2).toBe(arr[1]);
  });

  it("offers the rest of the collection helpers", () => {
    const arr = [
      { id: 1, tags: ["a"] },
      { id: 2, tags: ["b"] },
      { id: 3, tags: ["a", "b"] },
    ];
    expect(arr.jqlFilter({ tags: "a" }).map((item) => item.id)).toEqual([1, 3]);
    expect(arr.jqlCount({ tags: "b" })).toBe(2);
    expect(arr.jqlSome({ id: 3 })).toBe(true);
    expect(arr.jqlEvery({ id: { $lt: 4 } })).toBe(true);
    expect(arr.jqlFindIndex({ id: 3 })).toBe(2);
    expect(arr.jqlPartition({ id: 1 })[1]).toHaveLength(2);
    expect(arr.jqlQuery({ sort: { id: -1 }, limit: 1 })).toEqual([arr[2]]);
    expect(arr.jqlQuery({ where: { id: 1 }, fields: ["id"] })).toEqual([{ id: 1 }]);
  });

  it("works on a readonly array and an array of primitives", () => {
    const readonly: readonly number[] = [5, 10, 15];
    expect(readonly.jqlFilter({ $gte: 10 })).toEqual([10, 15]);
  });

  it("takes any iterable in the static form", () => {
    expect(Array.jqlFilter(new Set([1, 2, 3]), { $gt: 1 })).toEqual([2, 3]);
    expect(Array.jqlSearch(new Map([["k", { id: 1 }]]), { id: 1 })).toEqual({ id: 1 });
  });

  it("does not show up in a for…in over an array", () => {
    const keys: string[] = [];
    for (const key in [1, 2] as any) keys.push(key);
    expect(keys).toEqual(["0", "1"]);
  });
});

describe("the methods on maps and sets", () => {
  it("filters a Map by value and keeps it a Map", () => {
    const users = new Map([
      ["ada", { age: 36 }],
      ["grace", { age: 85 }],
    ]);
    const old = users.jqlFilter({ age: { $gt: 50 } });
    expect(old).toBeInstanceOf(Map);
    expect([...old.keys()]).toEqual(["grace"]);
    expect(users.jqlSearch({ age: 36 })).toEqual({ age: 36 });
    expect(users.jqlCount({})).toBe(2);
  });

  it("filters a Set and keeps it a Set", () => {
    const set = new Set([1, 2, 3, 4]);
    const even = set.jqlFilter({ $mod: [2, 0] });
    expect(even).toBeInstanceOf(Set);
    expect([...even]).toEqual([2, 4]);
  });
});

describe("installing", () => {
  it("can be installed again without complaint", () => {
    expect(() => install()).not.toThrow();
  });

  it("refuses to replace a method somebody else defined", () => {
    uninstall();
    Object.defineProperty(Array.prototype, "jqlCount", { value: () => -1, configurable: true, writable: true });
    try {
      expect(() => install()).toThrow(/already defined by something else/);
      // Nothing was half-installed on the way to refusing.
      expect(Object.hasOwn(Array.prototype, "jqlSearch")).toBe(false);
    } finally {
      Reflect.deleteProperty(Array.prototype, "jqlCount");
    }
    install();
    expect([1].jqlCount({})).toBe(1);
  });

  /**
   * npm puts two copies of a package in one process whenever two dependencies want
   * different versions. The second copy's import used to throw "already defined by
   * something else" — about JQL's own methods — which takes the application down at load.
   */
  it("loads beside another copy of JQL rather than refusing to", () => {
    uninstall();
    const theirs = function jqlSearch(): string {
      return "from the other copy";
    };
    Object.defineProperty(theirs, Symbol.for("@osqd/jql.method"), { value: true });
    Object.defineProperty(Array.prototype, "jqlSearch", { value: theirs, configurable: true, writable: true });

    expect(() => install()).not.toThrow();
    // The copy that got there first keeps the field; both answer the same queries.
    expect([{ id: 1 }].jqlSearch({ id: 1 }) as unknown).toBe("from the other copy");
    // The rest of the methods are this copy's, installed beside it.
    expect([{ id: 1 }, { id: 2 }].jqlFilter({ id: 2 })).toEqual([{ id: 2 }]);

    uninstall();
    expect(Object.hasOwn(Array.prototype, "jqlSearch"), "uninstall removes JQL's methods whichever copy installed them").toBe(false);
    install();
  });

  it("removes only its own methods", () => {
    uninstall();
    expect(Object.hasOwn(Array.prototype, "jqlSearch")).toBe(false);
    expect(Object.hasOwn(Array, "jqlSearch")).toBe(false);
    install();
  });
});
