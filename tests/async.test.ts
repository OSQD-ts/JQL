import { describe, expect, it } from "vitest";
import { count, countAsync, every, everyAsync, filter, filterAsync, filterStream, find, findAsync, search, searchAsync, some, someAsync, untyped } from "../src/index.js";
import { makeQuery, makeRoot, random } from "./helpers/generate.js";

/**
 * The same questions, asked of something that arrives over time.
 *
 * The cases that matter are the ones about *stopping*: a log that never ends still has a
 * first match and a first page, and a helper that read past them would hang the program
 * rather than answer it.
 */

interface Line {
  i: number;
  level: "info" | "error";
  at: number;
}

/** Counts what was pulled, so "it stopped reading" is a measurement rather than a hope. */
function lines(total: number, pulled: { count: number } = { count: 0 }): AsyncGenerator<Line> {
  async function* generate(): AsyncGenerator<Line> {
    for (let i = 0; i < total; i++) {
      pulled.count++;
      yield { i, level: i % 3 === 0 ? "error" : "info", at: total - i };
      await Promise.resolve();
    }
  }
  return generate();
}

describe("asking an asynchronous source", () => {
  it("finds, filters, counts and answers some and every", async () => {
    expect(await findAsync(lines(10), { level: "error" })).toEqual({ i: 0, level: "error", at: 10 });
    expect((await filterAsync(lines(10), { level: "error" })).map((line) => line.i)).toEqual([0, 3, 6, 9]);
    expect(await countAsync(lines(10), { level: "info" })).toBe(6);
    expect(await someAsync(lines(10), { i: 9 })).toBe(true);
    expect(await someAsync(lines(10), { i: 99 })).toBe(false);
    expect(await everyAsync(lines(10), { i: { $lt: 10 } })).toBe(true);
    expect(await everyAsync(lines(0), { i: 1 })).toBe(true);
  });

  it("stops reading at the first match", async () => {
    const pulled = { count: 0 };
    await findAsync(lines(1000, pulled), { i: 2 });
    expect(pulled.count).toBe(3);
  });

  it("stops reading when the caller stops taking", async () => {
    const pulled = { count: 0 };
    let taken = 0;
    for await (const _line of filterStream(lines(1000, pulled), { level: "error" })) {
      taken++;
      if (taken === 2) break;
    }
    expect(taken).toBe(2);
    expect(pulled.count, "nothing was pulled after the caller left").toBe(4);
  });

  it("answers an unsorted page without reading the rest", async () => {
    const pulled = { count: 0 };
    const page = await searchAsync(lines(1000, pulled), { where: { level: "error" }, skip: 1, limit: 2 });
    expect(page.map((line) => line.i)).toEqual([3, 6]);
    expect(pulled.count).toBe(7);
  });

  it("sorts by reading everything and keeping only the page", async () => {
    const page = await searchAsync(lines(50), { sort: { at: 1 }, limit: 3, fields: ["i"] });
    expect(page).toEqual([{ i: 49 }, { i: 48 }, { i: 47 }]);
  });

  it("drops fields from an asynchronous result too", async () => {
    const page = await searchAsync(lines(2), { omit: ["at"] });
    expect(page).toEqual([
      { i: 0, level: "error" },
      { i: 1, level: "info" },
    ]);
  });

  /**
   * The asynchronous helpers have their own loop, their own early exit and their own path
   * through the request planner. None of that may change an answer: a log read line by line
   * and the same lines in an array are the same items, and a query that told them apart
   * would be a query nobody could trust in either place.
   */
  it("answers exactly as the synchronous helpers do", async () => {
    for (let seed = 1; seed <= 120; seed++) {
      const next = random(seed);
      const query = untyped(makeQuery(next));
      const items = Array.from({ length: 12 }, () => makeRoot(next));
      async function* arriving(): AsyncGenerator<unknown> {
        for (const item of items) yield item;
      }
      const where = `seed ${seed}: ${JSON.stringify(query)}`;
      expect(await findAsync(arriving(), query), where).toEqual(find(items, query));
      expect(await filterAsync(arriving(), query), where).toEqual(filter(items, query));
      expect(await countAsync(arriving(), query), where).toBe(count(items, query));
      expect(await someAsync(arriving(), query), where).toBe(some(items, query));
      expect(await everyAsync(arriving(), query), where).toBe(every(items, query));
      for (const request of [
        { where: query },
        { where: query, limit: 3 },
        { where: query, skip: 2, limit: 3 },
        { where: query, sort: { a: -1 as const }, limit: 4 },
        { where: query, sort: { "a.b": 1 as const }, skip: 1 },
        { where: query, fields: ["a"] },
        { where: query, omit: ["a"] },
      ]) {
        expect(await searchAsync(arriving(), request as never), `${where} ${JSON.stringify(request)}`).toEqual(search(items, request as never));
      }
    }
  });

  /**
   * `findAsync(…) !== undefined` cannot tell "nothing matched" from "an item that is
   * `undefined` matched", so `someAsync` disagreed with `some` on exactly those.
   */
  it("says an undefined item was found, as the synchronous some does", async () => {
    expect(await someAsync([undefined], {})).toBe(some([undefined], {}));
    expect(await someAsync([undefined], {})).toBe(true);
    expect(await someAsync([], {})).toBe(false);
  });

  it("takes the ordinary collections as well, so one call site serves both", async () => {
    const rows: Line[] = [
      { i: 1, level: "error", at: 1 },
      { i: 2, level: "info", at: 2 },
    ];
    expect(await findAsync(rows, { level: "info" })).toBe(rows[1]);
    expect(await countAsync(new Set(rows), { at: { $gte: 1 } })).toBe(2);
    expect(await countAsync(new Map(rows.map((row) => [row.i, row])), { level: "error" })).toBe(1);
  });
});
