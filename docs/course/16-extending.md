# Lesson 16 — Extending it, and proving it

**Goal:** add an operator this project needs, check a filter before it meets anybody, and
finish Harbour.

← [Course](index.md) · Previous: [Pushing into a store](15-pushdown.md)

---

## Operators of your own

Some questions are not JSON. *"Is this address inside that network"*, *"does this score beat
the model's threshold"* — no amount of `$gt` expresses them, and the honest answer is to let a
project add an operator.

The cost of doing that is portability, so the language makes the cost **visible**: an added
operator's name must begin with `$x` and a capital letter. Somebody reading a stored filter
can see at a glance that it needs more than a standard engine, and a future version of JQL
cannot collide with a name you chose.

Save this as `harbour/within-days.mjs`:

```js
import { JqlError } from "@osqd/jql";

/** How recently an order was placed — the sort of question a project adds for itself. */
export const withinDays = {
  name: "$xWithinDays",
  cost: 2,
  compile: (operand, at) => {
    if (typeof operand !== "number" || !Number.isFinite(operand)) {
      throw new JqlError(`takes a number of days, not ${JSON.stringify(operand)}`, at);
    }
    const since = Date.parse("2026-09-25T12:00:00Z") - operand * 86_400_000;
    return (value) => typeof value === "string" && Date.parse(value) >= since;
  },
};
```

## Using it

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";
import { withinDays } from "./within-days.mjs";

const operators = [withinDays];
const ids = (query) => filter(orders, query, { operators }).map((o) => o.id);

console.log("within 7 days :", ids({ placed: { $xWithinDays: 7 } }));
console.log("within 20 days:", ids({ placed: { $xWithinDays: 20 } }));
```

```
within 7 days : [ 'o-1006', 'o-1007', 'o-1008' ]
within 20 days: [ 'o-1003', 'o-1004', 'o-1005', 'o-1006', 'o-1007', 'o-1008' ]
```

From the query's side it is an ordinary operator: it composes with everything else, it can sit
inside `$or`, and `explain` describes it like any other clause.

## Three refusals that make it safe to have

```js
import { filter, validate } from "@osqd/jql";
import { orders } from "./orders.mjs";
import { withinDays } from "./within-days.mjs";

const say = (verdict) => console.log("  ", verdict.valid ? "accepted" : verdict.error.message);

console.log("an operand that is not a number:");
say(validate({ placed: { $xWithinDays: "seven" } }, { operators: [withinDays] }));

console.log("an engine that was not given it:");
say(validate({ placed: { $xWithinDays: 7 } }));

console.log("a name without the $x:");
try {
  filter(orders, { placed: { $withinDays: 7 } }, { operators: [{ ...withinDays, name: "$withinDays" }] });
  console.log("   accepted");
} catch (error) {
  console.log("  ", error.message);
}
```

```
an operand that is not a number:
   at placed.$xWithinDays: takes a number of days, not "seven"
an engine that was not given it:
   at placed.$xWithinDays: "$xWithinDays" is an added operator, and this query was compiled without it; pass it in `operators`
a name without the $x:
   at operators: "$withinDays" cannot name an added operator: the name is $x and a capital, such as "$xCidr", so a query that needs more than standard JQL says so
```

Each of those is a property worth having:

- **`compile` runs once**, when the query is compiled, and returns the test. Validate the
  operand there and throw `JqlError` — the sentence reaches whoever wrote the query, with the
  place in it.
- **A query that needs an added operator says so.** The second refusal is an engine *without*
  the operator, naming it and saying what to do, rather than treating it as a typo and
  matching nothing.
- **The naming rule is enforced**, so the visibility it buys is real.

There is a fourth property with no error message: **`cost`** is a hint for ordering an `$and`,
so a cheap equality runs before your expensive test. It changes the speed and never the
answer.

Before reaching for any of this, look at the field operators once more. `$word`, `$glob`,
`$length` and `{ "$field": … }` exist precisely because they are the four things people most
often added an escape hatch to do — and a query using them is still portable JQL.

## Proving a filter before it meets anybody

The language ships its own test suite as **data**: `conformance/cases.json`, 158 matching
cases and 27 request cases. Each is a document set, a query, and the answer any implementation
must give.

```json
{"group": "equality", "name": "an empty query matches everything", "documents": "people", "query": {}, "matches": [0, 1, 2, 3]}
```

You need it mostly if you implement JQL in another language. But it is also the clearest
statement of what an operator means, in twelve groups — equality, arrays and paths, existence
and type, ordering, strings, logic, text, references, length, glob, relative dates, refusals.
When you are unsure what something does, the case is faster to read than the prose.

For your *own* filters, the tools are ones you already have:

| | |
| --- | --- |
| `validate` | a query from outside, refused with a sentence (lesson 12) |
| `explain` | why one row did or did not match (lesson 9) |
| `jql --explain` | the same from a shell, over the first line of a real file (lesson 14) |
| `fingerprint` | whether the filter in the test is the filter in production (lesson 13) |
| `toText(…).complete` | whether the box is showing the whole filter (lesson 11) |

## Harbour, finished

Everything the course built, in one place:

```ts
// vocabulary.mjs — the names, once, for both front ends            (lesson 10)
export const ORDERS = defineVocabulary()({ fields: { … }, text: [ … ] });

// the console's search box                                        (lesson 11)
const query = parseText(typed, { vocabulary: ORDERS });

// the table                                                       (lessons 7, 15)
const { pushed, remaining, complete } = plan(query, STORE_CAPABILITIES);
const rows = await collection.find(toStoreFilter(pushed)).toArray();
const page = search(complete ? rows : filter(rows, remaining), {
  sort: { placed: -1 }, skip, limit, omit: ["customer.email"],
}, { vocabulary: ORDERS });

// the number above it                                             (lesson 8)
const byStatus = group(rows, "status", { vocabulary: ORDERS, where: query });

// "why isn't this here?"                                          (lesson 9)
const why = explain(query, row, { vocabulary: ORDERS });

// saving it                                                       (lesson 13)
await filters.insert({ key: fingerprint(query), name, query: canonical(query) });

// and the public API, which trusts none of the above              (lesson 12)
const checked = validate(JSON.parse(body), { vocabulary: PUBLIC, limits });
if (!checked.valid) return respond(400, { error: checked.error.message });
```

One query document runs in the console, in the API, in the store and in the nightly export,
and means the same thing in all four. That is the whole argument for a query being data.

## Where to go next

| | |
| --- | --- |
| [The specification](../reference/specification.md) | what every operator means, precisely — the thing to read when you disagree with an answer |
| [Adopting JQL in a project](../guides/adopting.md) | moving an existing project's filtering onto it |
| [Pushing a query into a store](../guides/pushdown.md) | writing a target for a store of your own |
| [Design decisions](../design/decisions.md) | what this library refuses to do, and what that costs |
| [Performance](../design/performance.md) | how fast it is, how that is measured, and what makes it so |

## A last exercise

Take the filter your own project uses most — the one behind a dashboard or an endpoint — and
write it as a JQL document. Two things usually come out of that:

1. a clause you cannot express, which is worth knowing about; and
2. a clause you *can* express that you had been doing in application code, which is worth
   moving.

If it is the first, the [specification](../reference/specification.md) will tell you whether
it is a gap in the language or a gap in this course. If it is the second, you have just made a
filter storable, sendable and explainable — which is what the whole thing is for.

## Related

- [Course index](index.md) — all sixteen lessons
- [Library API](../reference/api.md) — every export, grouped by what it is for
