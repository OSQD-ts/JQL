# Lesson 9 — Why did this not match?

**Goal:** answer "why isn't this row in my list?" in one call, with the values the filter
actually read.

← [Course](index.md) · Previous: [Counting by a field](08-grouping.md) · Next: [A vocabulary](10-vocabulary.md)

---

## The support question

*"Why isn't order 1002 on my screen?"*

A filter that returns nothing tells you nothing about which part of it was wrong. Without a
tool, answering that means commenting clauses out one at a time until the row reappears.

`explain(query, item)` takes the query apart and answers for **each piece separately**, with
the values it read. It is the only function in the library that tells you about a row that did
*not* match.

## A first explanation

```js
import { explain } from "@osqd/jql";
import { orders } from "./orders.mjs";

const filterInUse = { status: "paid", "customer.country": "GB", total: { $gte: 20 } };
const order = orders.find((o) => o.id === "o-1002");

const result = explain(filterInUse, order);

console.log(result.matched, "—", result.because);
for (const part of result.parts) console.log(" ", part.matched ? "yes" : "no ", part.at, "—", part.because);
```

```
false — 1 of 3 parts hold
  no  status — status is "open"
  no  customer.country — customer.country is "US"
  yes total — total is 30
```

There is the answer, and it is not the clause anybody would have guessed. The order is missing
because it is **open and American**; whoever asked was almost certainly looking at the total.

## What an explanation holds

| | |
| --- | --- |
| `matched` | whether this clause holds |
| `at` | where it is in the query, written as you would reach it in code: `$or[1].tags` |
| `clause` | the JSON fragment that was evaluated |
| `because` | one sentence: what was read, or how the parts came out |
| `parts` | the clauses this one is made of |

`parts` nests, so a useful way to look at an explanation is to walk it:

```js
import { explain } from "@osqd/jql";
import { orders } from "./orders.mjs";

const draw = (node, depth = 0) => {
  const where = node.at === "" ? "the query" : node.at;
  console.log(`${" ".repeat(depth)}${node.matched ? "yes" : "no "}  ${where} — ${node.because}`);
  for (const part of node.parts ?? []) draw(part, depth + 2);
};

const order = orders.find((o) => o.id === "o-1002");

draw(explain({ $or: [{ "lines.sku": "desk-lamp" }, { tags: "gift" }] }, order));
```

```
no   $or — 0 of 2 parts hold, and one is enough
  no   $or[0].lines.sku — lines.sku is "pad-a5"
  no   $or[1].tags — tags is []
```

Keep that `draw` function; the rest of the lesson uses it.

Notice `$or[0].lines.sku` — the path into the query is exact enough to find the clause in a
long filter by search, and `because` says how the branch came out as well as what each side
read.

## The values it read

This is where the time is saved:

```js
import { explain } from "@osqd/jql";
import { orders } from "./orders.mjs";

const draw = (node, depth = 0) => {
  const where = node.at === "" ? "the query" : node.at;
  console.log(`${" ".repeat(depth)}${node.matched ? "yes" : "no "}  ${where} — ${node.because}`);
  for (const part of node.parts ?? []) draw(part, depth + 2);
};

draw(explain({ tags: "gift" }, orders.find((o) => o.id === "o-1002")));
draw(explain({ note: "x" }, orders.find((o) => o.id === "o-1002")));
draw(explain({ "lines.sku": "desk-lamp" }, orders.find((o) => o.id === "o-1001")));
```

```
no   tags — tags is []
no   note — note is missing
no   lines.sku — lines.sku is each of "pen-fine", "ink-blue"
```

Three different failures, each described differently:

- `tags is []` — the array was there and empty, not missing;
- a missing field says so, rather than being reported as some falsy value;
- when a path reaches **several** values you get `each of …`, listing them. That last line is
  usually the moment somebody realises their query means what lesson 3 said it meant rather
  than what they read it as.

## It runs the real engine

Every clause is compiled on its own and tested, rather than interpreted by a second reading of
the language. That is worth stating plainly, because the alternative is tempting and wrong: a
second reading would be a second set of semantics, and the only thing worse than a filter you
cannot explain is an explanation that disagrees with what the filter did.

The cost is that it compiles once per clause, so `explain` is for **one row at a time** —
`compile` is for the collection. That is a deliberate trade: an explanation exists for a person
asking about one row.

## Where to put it

- **In a support console**, behind a row: "why is this not in the current view?".
- **In a test**, when a filter breaks.
  `expect(explain(filter, row).parts.map((p) => [p.at, p.matched]))` fails with the name of the
  clause rather than with `expected [] to have length 1`.

## Exercise

`o-1007` is not on the "needs chasing" list from lesson 7. Explain it against that request's
`where`, and say in one sentence what the operator should tell the customer.

<details>
<summary>Answer</summary>

```js
import { explain } from "@osqd/jql";
import { orders } from "./orders.mjs";

const result = explain(
  { paid: 0, status: { $nin: ["cancelled", "refunded"] } },
  orders.find((o) => o.id === "o-1007"),
);

console.log(result.because);
for (const part of result.parts) console.log(" ", part.matched ? "yes" : "no ", part.at, "—", part.because);
```

```
1 of 2 parts hold
  yes paid — paid is 0
  no  status — status is "cancelled"
```

Nobody owes anything: the order was cancelled, so the unpaid balance is not a debt. The
explanation names the clause that decided it, and that clause is the sentence the operator
repeats back.
</details>

## Related

- [Library API](../reference/api.md) — `explain` and `Explanation`
- [The command line](../reference/cli.md) — `jql --explain` prints this tree for the first line of a file
