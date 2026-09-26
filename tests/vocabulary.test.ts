import { describe, expect, it } from "vitest";
import { compile, defineVocabulary, group, JqlError, search, untyped, validate } from "../src/index.js";
import { parseText, suggest, toText } from "../src/text/index.js";

/**
 * Named, aliased and computed fields.
 *
 * A vocabulary is shared by the JSON engine and the text front end, so a mistake in one is
 * a mistake in both. Every refusal here is a vocabulary that would have looked defined and
 * meant something else.
 */

interface Order {
  id: string;
  customer: { name: string; email: string };
  lines: { sku: string; quantity: number; price: number }[];
}

const orders: Order[] = [
  { id: "o1", customer: { name: "Ada", email: "ada@example.com" }, lines: [{ sku: "pen", quantity: 2, price: 3 }] },
  { id: "o2", customer: { name: "Grace", email: "grace@example.com" }, lines: [{ sku: "ink", quantity: 1, price: 40 }, { sku: "pen", quantity: 5, price: 3 }] },
];

const vocabulary = defineVocabulary<Order>()({
  fields: {
    who: { path: "customer.name", aliases: ["customer"] },
    total: { get: (order) => order.lines.reduce((sum, line) => sum + line.quantity * line.price, 0), kind: "number" },
    buyer: { get: (order) => order.customer },
  },
});

describe("names", () => {
  it("reaches a path through a field name and its alias", () => {
    expect(orders.filter(compile({ who: "Ada" }, { vocabulary }))).toEqual([orders[0]]);
    // An alias is a name the text syntax and untyped queries use; the types know the fields.
    expect(orders.filter(compile(untyped({ customer: "Grace" }), { vocabulary }))).toEqual([orders[1]]);
  });

  it("matches field names without regard to case", () => {
    expect(orders.filter(compile({ WHO: "Ada" } as never, { vocabulary }))).toEqual([orders[0]]);
  });

  it("computes a field that is stored nowhere", () => {
    expect(orders.filter(compile({ total: { $gt: 50 } }, { vocabulary }))).toEqual([orders[1]]);
  });

  it("continues a path from a computed field", () => {
    expect(orders.filter(compile({ "buyer.email": { $endsWith: "grace@example.com" } } as never, { vocabulary }))).toEqual([orders[1]]);
  });

  it("still takes any path when it is not strict", () => {
    expect(orders.filter(compile({ "lines.sku": "ink" }, { vocabulary }))).toEqual([orders[1]]);
  });

  it("refuses an unknown name when strict, and suggests the right one", () => {
    const strict = defineVocabulary<Order>()({ fields: { who: { path: "customer.name" } }, strict: true });
    expect(() => compile({ wh: "Ada" } as never, { vocabulary: strict })).toThrow(/did you mean "who"/);
    expect(() => compile({ id: "o1" }, { vocabulary: strict })).toThrow(JqlError);
  });

  it("uses the text fields for a bare $text", () => {
    const texty = defineVocabulary<Order>()({ fields: { who: { path: "customer.name" } }, text: ["who"] });
    expect(orders.filter(compile({ $text: "grace" }, { vocabulary: texty }))).toEqual([orders[1]]);
    // The email holds "ada" too, but it is not a text field.
    expect(orders.filter(compile({ $text: "example" }, { vocabulary: texty }))).toEqual([]);
  });
});

describe("refusing a vocabulary that would mislead", () => {
  it("refuses two fields answering to one name", () => {
    expect(() => defineVocabulary()({ fields: { a: { aliases: ["x"] }, b: { aliases: ["X"] } } })).toThrow(/names both/);
  });

  it("refuses a field with both a path and a getter", () => {
    expect(() => defineVocabulary()({ fields: { a: { path: "b", get: () => 1 } } })).toThrow(/one of them would be ignored/);
  });

  it("refuses a name that looks like an operator or a path", () => {
    expect(() => defineVocabulary()({ fields: { $a: {} } })).toThrow(JqlError);
    expect(() => defineVocabulary()({ fields: { "a.b": {} } })).toThrow(JqlError);
  });

  it("refuses a text field that is not a field", () => {
    expect(() => defineVocabulary()({ fields: { a: {} }, text: ["b"] })).toThrow(/never search it/);
  });
});

/**
 * `defineVocabulary` is curried, so the parentheses are easy to forget, and a definition
 * looks enough like a vocabulary to pass by eye. Both used to arrive as `Cannot read
 * properties of undefined (reading 'get')` from inside whichever module happened to
 * dereference `lookup` first — and a `TypeError` is not a `JqlError`, so `validate` re-threw
 * it rather than answering with a verdict, and `parseText` threw where it promises not to.
 */
describe("something that is not a vocabulary", () => {
  const definition = { fields: { title: { path: "t" } } } as never;
  const curried = defineVocabulary as never;

  it("is refused by name wherever one is taken", () => {
    for (const given of [definition, curried, null as never]) {
      expect(() => compile({ a: 1 }, { vocabulary: given })).toThrow(JqlError);
      expect(() => search([{}], { sort: { a: 1 } } as never, { vocabulary: given })).toThrow(JqlError);
      expect(() => group([{}], "a", { vocabulary: given })).toThrow(JqlError);
      expect(() => parseText("a:b", { vocabulary: given })).toThrow(JqlError);
      expect(() => toText({ a: 1 }, { vocabulary: given })).toThrow(JqlError);
      expect(() => suggest("a", 1, given)).toThrow(JqlError);
    }
  });

  it("says which mistake it probably was", () => {
    expect(() => compile({ a: 1 }, { vocabulary: definition })).toThrow(/empty parentheses first/);
    expect(() => compile({ a: 1 }, { vocabulary: curried })).toThrow(/but a function/);
  });

  it("leaves validate answering with a verdict rather than a stack", () => {
    const verdict = validate({ a: 1 }, { vocabulary: definition });
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.error).toBeInstanceOf(JqlError);
  });
});
