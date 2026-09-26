import { describe, expect, it } from "vitest";
import { compile, defineVocabulary, group, JqlError, untyped } from "../src/index.js";
import { makeQuery, makeRoot, PATHS, random } from "./helpers/generate.js";

/**
 * Counting the matches by a field.
 *
 * The cases are the three questions every dashboard that tallies a feed has had to answer
 * for itself, and answered differently: what an item with two values counts as, where the
 * items with no value go, and what order the groups arrive in.
 */

const feed = [
  { id: 1, actor: "1.2.3.4", verdict: "bot", tags: ["scan", "probe"], score: 90 },
  { id: 2, actor: "1.2.3.4", verdict: "human", tags: [], score: 10 },
  { id: 3, actor: "9.9.9.9", verdict: "bot", tags: ["scan", "scan"], score: 70 },
  { id: 4, verdict: "bot", tags: ["probe"], score: 60 },
];

describe("grouping", () => {
  it("counts by a field, largest group first", () => {
    expect(group(feed, "verdict")).toEqual([
      { key: "bot", count: 3 },
      { key: "human", count: 1 },
    ]);
  });

  it("puts everything with no value under null", () => {
    expect(group(feed, "actor")).toEqual([
      { key: "1.2.3.4", count: 2 },
      { key: null, count: 1 },
      { key: "9.9.9.9", count: 1 },
    ]);
  });

  it("counts an item once per distinct value it holds", () => {
    // Two "scan" tags on one request are one request that scanned. The request with *no*
    // tags is still a request: it goes under `null`, like every other value that cannot name
    // a group. Leaving it out altogether meant the numbers above a table did not add up to
    // the number of rows in it, and nothing said which rows had gone.
    expect(group(feed, "tags")).toEqual([
      { key: "probe", count: 2 },
      { key: "scan", count: 2 },
      { key: null, count: 1 },
    ]);
  });

  /**
   * The row that belonged to no group at all. Every other value that cannot name one — a
   * missing field, a `null`, an object — already shared `null`; an empty array fell through
   * both, so counting by a tag quietly left every untagged row out of the tally.
   */
  it("keeps a row whose value is an empty list", () => {
    const rows = [{ t: ["a"] }, { t: [] }, { t: null }, {}, { t: ["a", "b"] }];
    const counted = group(rows, "t");
    expect(counted.reduce((total, held) => total + held.count, 0)).toBe(rows.length + 1);
    expect(counted).toEqual([
      { key: null, count: 3 },
      { key: "a", count: 2 },
      { key: "b", count: 1 },
    ]);
    expect(group([{ t: [] }], "t")).toEqual([{ key: null, count: 1 }]);
  });

  it("counts only what the query matches", () => {
    expect(group(feed, "verdict", { where: { score: { $gt: 50 } } })).toEqual([{ key: "bot", count: 3 }]);
  });

  it("keeps the items when asked, and how many", () => {
    const [bots] = group(feed, "verdict", { items: 2 });
    expect(bots?.items?.map((row) => row.id)).toEqual([1, 3]);
    expect(group(feed, "verdict", { items: true })[0]?.items).toHaveLength(3);
    expect(group(feed, "verdict")[0]?.items).toBeUndefined();
  });

  it("orders by the key when asked, and breaks count ties the same way every time", () => {
    expect(group(feed, "tags", { sort: "key" }).map((held) => held.key)).toEqual([null, "probe", "scan"]);
    expect(group(feed, "score", { sort: "key" }).map((held) => held.key)).toEqual([10, 60, 70, 90]);
  });

  it("keeps the largest few", () => {
    expect(group(feed, "verdict", { limit: 1 })).toEqual([{ key: "bot", count: 3 }]);
    expect(group(feed, "verdict", { limit: 0 })).toEqual([]);
  });

  it("groups a Map by its values, and any other collection", () => {
    expect(group(new Map(feed.map((row) => [row.id, row])), "verdict")).toEqual([
      { key: "bot", count: 3 },
      { key: "human", count: 1 },
    ]);
    expect(group(new Set(feed), "verdict")[0]).toEqual({ key: "bot", count: 3 });
  });

  it("groups by a vocabulary's computed field", () => {
    const vocabulary = defineVocabulary<(typeof feed)[number]>()({ fields: { band: { get: (row) => (row.score >= 70 ? "high" : "low") } } });
    // Two at or above 70, two below; equal counts come back in key order.
    expect(group(feed, "band", { vocabulary })).toEqual([
      { key: "high", count: 2 },
      { key: "low", count: 2 },
    ]);
  });

  /**
   * The same tally, written the slow obvious way: reach every value, take the keys it stands
   * for, count each item once per distinct key. The rules about fan-out, repeats and the
   * values that cannot name a group are easy to state and easy to get subtly wrong.
   */
  it("counts what a naive tally counts, for generated data", () => {
    const reached = (value: unknown, keys: string[], into: unknown[]): void => {
      if (keys.length === 0) {
        if (Array.isArray(value)) {
          // An empty array names no group, exactly as an empty one met *on the way* down a
          // path does a few lines below. Written without this, the reference disagreed with
          // itself about the same shape depending on where the path ended.
          if (value.length === 0) return reached(undefined, [], into);
          for (const element of value) reached(element, keys, into);
          return;
        }
        const key = value === undefined || value === null || typeof value === "object" ? null : value;
        if (!into.includes(key)) into.push(key);
        return;
      }
      const [head, ...rest] = keys as [string, ...string[]];
      if (value === null || typeof value !== "object") return reached(undefined, [], into);
      if (Array.isArray(value)) {
        if (/^\d+$/.test(head)) return reached(value[Number(head)], rest, into);
        if (value.length === 0) return reached(undefined, [], into);
        for (const element of value) reached(element, keys, into);
        return;
      }
      if (value instanceof Map) return reached(value.get(head), rest, into);
      reached(Object.hasOwn(value, head) ? (value as Record<string, unknown>)[head] : undefined, rest, into);
    };

    for (let seed = 1; seed <= 200; seed++) {
      const next = random(seed);
      const query = untyped(makeQuery(next));
      const items = Array.from({ length: 10 }, () => makeRoot(next));
      const by = PATHS[Math.floor(next() * PATHS.length)] as string;
      const test = compile(query);

      const tally = new Map<unknown, number>();
      for (const item of items) {
        if (!test(item)) continue;
        const keys: unknown[] = [];
        reached(item, by.split("."), keys);
        for (const key of keys) tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const counted = group(items, by, { where: query });
      const where = `seed ${seed}: by ${by}, query ${JSON.stringify(query)}`;
      expect(counted.length, where).toBe(tally.size);
      for (const held of counted) expect(held.count, `${where} at ${JSON.stringify(held.key)}`).toBe(tally.get(held.key));
      // Largest first, and every count adds up to the matches it stands for.
      for (let i = 1; i < counted.length; i++) expect((counted[i - 1] as { count: number }).count >= (counted[i] as { count: number }).count, where).toBe(true);
    }
  });

  it("refuses options that would mean nothing", () => {
    expect(() => group(feed, "verdict", { limit: -1 })).toThrow(JqlError);
    expect(() => group(feed, "verdict", { items: 1.5 })).toThrow(JqlError);
    expect(() => group(feed, "" as string)).toThrow(JqlError);
  });
});
