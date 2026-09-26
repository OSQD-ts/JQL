import { describe, expect, it } from "vitest";
import { compile, explain, type Explanation, untyped } from "../src/index.js";
import { makeQuery, makeRoot, random } from "./helpers/generate.js";

/**
 * Why one item does or does not match.
 *
 * The property that matters most is the last one here: an explanation is produced by
 * running the real engine on each clause, so it cannot say a query matched when the query
 * did not.
 */

const row = { id: 3, actor: "9.9.9.9", verdict: "bot", tags: ["scan"], score: 70, user: { name: "Ada" } };

function flat(node: Explanation): string[] {
  return [`${node.matched ? "ok" : "no"} ${node.at || "<query>"}`, ...(node.parts ?? []).flatMap(flat)];
}

describe("explaining a match", () => {
  it("answers for each clause, with the value it read", () => {
    const why = explain({ verdict: "bot", score: { $gt: 80 } }, row);
    expect(why.matched).toBe(false);
    expect(why.parts?.map((part) => [part.at, part.matched, part.because])).toEqual([
      ["verdict", true, 'verdict is "bot"'],
      ["score", false, "score is 70"],
    ]);
  });

  it("names each clause where it is in the query", () => {
    const why = explain({ score: { $gt: 80, $lt: 95 }, $or: [{ actor: "9.9.9.9" }, { tags: "probe" }] }, row);
    expect(flat(why)).toEqual(["no <query>", "no score", "no score.$gt", "ok score.$lt", "ok $or", "ok $or[0].actor", "no $or[1].tags"]);
  });

  it("says what a missing field is", () => {
    // Written untyped, because the types would not let a query name a field the item lacks.
    expect(explain(untyped({ nope: { $gte: 5 } }), row).because).toBe("nope is missing");
  });

  it("says what a path through an array reached", () => {
    const why = explain({ "items.sku": "pen" }, { items: [{ sku: "ink" }, { sku: "pad" }] });
    expect(why.because).toBe('items.sku is each of "ink", "pad"');
  });

  it("explains a negation by what it negates", () => {
    const why = explain({ $not: { verdict: "bot" } }, row);
    expect(why.matched).toBe(false);
    expect(why.because).toBe("what it negates holds");
    expect(why.parts?.[0]?.matched).toBe(true);
  });

  it("explains an empty query and a text search", () => {
    expect(explain({}, row).because).toBe("an empty query matches everything");
    expect(explain({ $text: "ada" }, row).because).toBe("the item holds that text");
    expect(explain({ $text: "zz" }, row).because).toBe("no value of the item holds that text");
  });

  /**
   * The explanation runs the engine on each clause rather than reading the query a second
   * way, so it cannot drift from what a filter actually does. This is that promise as a test.
   */
  /**
   * `$options` changes what some operators mean and is refused beside the ones it does not.
   * Carried onto every piece of a split condition it made a fragment the engine refuses, so
   * explaining a perfectly good query threw instead of answering. Found by the generated
   * test below once the generator learned to write the flag.
   */
  it("explains a condition that mixes an operator the flag changes with one it does not", () => {
    const row = { b: "Xy" };
    const why = explain(untyped({ b: { $contains: "x", $exists: true, $options: "i" } }), row);
    expect(why.matched).toBe(true);
    expect(why.parts?.map((part) => [part.at, part.matched])).toEqual([
      ["b.$contains", true],
      ["b.$exists", true],
    ]);
    // Each piece is still a query in its own right, and still says what the whole one says.
    for (const part of why.parts ?? []) expect(compile(untyped(part.clause as Record<string, unknown>))(row)).toBe(part.matched);
  });

  it("agrees with the engine for queries nobody wrote by hand", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const query = makeQuery(next);
      const test = compile(untyped(query));
      for (let i = 0; i < 5; i++) {
        const document = makeRoot(next);
        const why = explain(untyped(query), document);
        if (why.matched !== test(document)) {
          expect.fail(`seed ${seed}: the explanation disagrees with the filter\n  query: ${JSON.stringify(query)}\n  doc:   ${JSON.stringify(document)}`);
        }
        // Every part is a query in its own right, and answers for itself the same way.
        for (const part of why.parts ?? []) {
          expect(compile(untyped(part.clause as Record<string, unknown>))(document), `seed ${seed} at ${part.at}`).toBe(part.matched);
        }
      }
    }
  });

  it("agrees with the engine on every clause it splits", () => {
    const queries: unknown[] = [
      { verdict: "bot", score: { $gt: 80, $lt: 95 } },
      { $or: [{ actor: "1.1.1.1" }, { tags: "scan" }] },
      { $nor: [{ verdict: "human" }] },
      { $not: { score: { $lt: 10 } } },
      { "user.name": { $contains: "Ad", $options: "i" } },
      { score: { $not: { $gt: 100 } } },
      { tags: { $elemMatch: { $startsWith: "sc" } } },
      { $text: "9.9.9.9" },
      { $and: [{ id: 3 }, { $or: [{ id: 4 }, { verdict: "bot" }] }] },
    ];
    for (const query of queries) {
      const why = explain(query as never, row);
      expect(why.matched, JSON.stringify(query)).toBe(compile(query as never)(row));
      // Every part is itself a query that answers the same way on its own.
      for (const part of why.parts ?? []) {
        expect(compile(part.clause as never)(row), `${part.at} of ${JSON.stringify(query)}`).toBe(part.matched);
      }
    }
  });
});
