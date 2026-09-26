/**
 * JQL in one file: the same questions asked four ways.
 *
 *   npm run example
 *
 * Prints each answer on its own line. Every line should end in "ok"; the example checks
 * its own answers so that a change which breaks the documented behaviour fails the
 * examples test rather than printing something plausible.
 */
import "@osqd/jql/global";
import { canonical, compile, defineVocabulary, explain, fingerprint, group, JqlError, plan, search, searchAsync, UNTRUSTED_LIMITS, untyped, validate } from "@osqd/jql";
import { parseText, toText } from "@osqd/jql/text";

interface Order {
  id: string;
  customer: { name: string; country: string };
  status: "open" | "paid" | "refunded";
  total: number;
  paid: number;
  placed: string;
  lines: { sku: string; quantity: number }[];
}

const orders: Order[] = [
  { id: "o-1", customer: { name: "Ada", country: "GB" }, status: "paid", total: 120, paid: 120, placed: "2026-09-01T10:00:00Z", lines: [{ sku: "pen", quantity: 3 }] },
  { id: "o-2", customer: { name: "Grace", country: "US" }, status: "open", total: 40, paid: 10, placed: "2026-09-12T08:30:00Z", lines: [{ sku: "ink", quantity: 1 }, { sku: "pen", quantity: 10 }] },
  { id: "o-3", customer: { name: "Alan", country: "GB" }, status: "refunded", total: 15, paid: 15, placed: "2026-08-20T16:45:00Z", lines: [{ sku: "pad", quantity: 2 }] },
];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${label}: ${JSON.stringify(actual)} ${ok ? "ok" : `NOT OK, expected ${JSON.stringify(expected)}`}`);
  if (!ok) process.exitCode = 1;
}

// 1. On the array itself, after importing "@osqd/jql/global".
check("by id", orders.jqlSearch({ id: "o-2" })?.customer.name, "Grace");
check("static form", Array.jqlSearch(orders, { "customer.country": "US" })?.id, "o-2");

// 2. A query as data: this object could have come from a URL, a file or another service.
const bigBritishOrders = { "customer.country": "GB", total: { $gte: 100 } } as const;
check("filter", orders.jqlFilter(bigBritishOrders).map((order) => order.id), ["o-1"]);
check("any line of ten or more", orders.jqlFilter({ lines: { $elemMatch: { quantity: { $gte: 10 } } } }).map((order) => order.id), ["o-2"]);
check("since a date", orders.jqlCount({ placed: { $gte: { $date: "2026-09-01" } } }), 2);

// 3. Compile once for a hot loop.
const open = compile<Order>({ status: { $in: ["open", "paid"] } });
check("compiled", orders.filter(open).length, 2);

// 4. A whole request: which, in what order, which page, which fields.
check("request", search(orders, { where: { status: { $ne: "refunded" } }, sort: { total: -1 }, limit: 1, fields: ["id", "total"] }), [{ id: "o-1", total: 120 }]);

// 5. The search-box syntax, with a vocabulary so people can type short names.
const vocabulary = defineVocabulary<Order>()({
  fields: {
    who: { path: "customer.name" },
    country: { path: "customer.country", kind: "exact", values: ["GB", "US"] },
    status: { kind: "exact", values: ["open", "paid", "refunded"] },
    total: { kind: "number" },
    sku: { path: "lines.sku", kind: "exact" },
  },
  text: ["who", "sku"],
});
const typed = parseText("country:gb total:>20 -status:refunded", { vocabulary });
check("text becomes JSON", typed, { $and: [{ country: { $eq: "gb", $options: "i" } }, { total: { $gt: 20 } }, { $not: { status: { $eq: "refunded", $options: "i" } } }] });
check("text runs", orders.jqlFilter(typed, { vocabulary }).map((order) => order.id), ["o-1"]);

// 6. A query from somebody you do not trust: validate first, with the untrusted limits.
const fromUrl = untyped(JSON.parse('{ "customer.name": { "$regex": "(a+)+$" } }'));
const verdict = validate(fromUrl, { limits: UNTRUSTED_LIMITS });
check("untrusted pattern refused", verdict.valid ? "accepted" : verdict.error.message, "at customer.name.$regex: patterns are turned off for this query; $contains, $startsWith, $endsWith and $word cover most of what one is for");

// A good one comes back compiled, so the query that was checked is the query that runs.
const allowed = validate<Order>(JSON.parse('{ "customer.country": "GB" }'), { limits: UNTRUSTED_LIMITS });
check("untrusted query accepted", allowed.valid ? orders.filter(allowed.test).map((order) => order.id) : allowed.error.message, ["o-1", "o-3"]);

// 7. One field against another, a glob, and a length — no expression language, no pattern.
check("not paid in full", orders.jqlFilter({ paid: { $lt: { $field: "total" } } }).map((order) => order.id), ["o-2"]);
check("glob", orders.jqlFilter({ id: { $glob: "o-?" } }).length, 3);
check("length", orders.jqlFilter({ "customer.name": { $length: { $gt: 3 } } }).map((order) => order.id), ["o-2", "o-3"]);

// 8. A window that goes on meaning "since the first of the month".
const since = { placed: { $gte: { $date: { $ago: "30d" } } } } as const;
check("relative window", orders.jqlCount(since, { now: () => Date.parse("2026-09-21T00:00:00Z") }), 2);

// 9. Counting by a field — what a dashboard shows above the rows.
check("grouped", group(orders, "status").map((held) => [held.key, held.count]), [["open", 1], ["paid", 1], ["refunded", 1]]);

// 10. Redaction as data: the value never leaves the process.
check("redacted", search(orders, { where: { id: "o-1" }, omit: ["customer.country", "lines", "placed", "status", "total", "paid"] }), [{ id: "o-1", customer: { name: "Ada" } }]);

// 11. Why a row did not match, clause by clause.
const why = explain({ status: "open", total: { $gte: 100 } }, orders[1] as Order);
check("explained", why.parts?.map((part) => [part.at, part.matched]), [["status", true], ["total", false]]);

// 12. One shape and one short name per query, for saving filters without duplicates.
check("canonical", canonical({ status: "open" }), { status: { $eq: "open" } });
check("fingerprint", fingerprint({ status: "open" }) === fingerprint({ status: { $eq: "open" }, $comment: "same" }), true);

// 13. A source that arrives over time answers the same questions.
async function* arriving(): AsyncGenerator<Order> {
  for (const order of orders) yield order;
}
const firstTwo = await searchAsync(arriving(), { where: { status: { $ne: "refunded" } }, limit: 2, fields: ["id"] });
check("async page", firstTwo, [{ id: "o-1" }, { id: "o-2" }]);

// 14. A stored filter, put back in a search box — and what the box cannot say.
const stored = parseText("country:gb total:>20", { vocabulary });
const form = toText(stored, { vocabulary });
check("back to text", [form.text, form.complete], ["country:gb total:>20", true]);
const partly = toText(untyped({ lines: { $elemMatch: { sku: "pen" } } }), { vocabulary });
check("and what it cannot say", [partly.text, partly.complete], ["", false]);

// 15. Splitting a query between a store and this engine.
const split = plan(untyped({ status: "open", "customer.name": { $contains: "Ad" } }), { fields: ["status"], operators: ["$eq"] });
check("pushed to the store", split.pushed, { status: "open" });
check("kept here", split.remaining, { "customer.name": { $contains: "Ad" } });

// 16. A mistake is an error with a place and a suggestion, never a silently empty result.
try {
  orders.jqlFilter(untyped({ total: { $gtt: 10 } }));
  check("typo", "accepted", "refused");
} catch (error) {
  check("typo", error instanceof JqlError ? error.message : String(error), 'at total.$gtt: "$gtt" is not an operator; did you mean "$gt"?');
}
