# Lesson 10 — A vocabulary

**Goal:** give your data its names, once, so that queries stop knowing where things are
stored.

← [Course](index.md) · Previous: [Why did this not match?](09-explaining.md) · Next: [The search box](11-the-search-box.md)

---

## Every query so far has had a storage path in it

`customer.country` is where the country *lives*. It is not what anybody calls it. Once that
path is in a saved filter, in a URL and in three dashboards, moving the field is a migration.

A **vocabulary** is the one place that says what your data is called:

| | |
| --- | --- |
| **names** | one per field, with the storage path behind it |
| **aliases** | because people type `at`, and `placed`, and `order`, and `id` |
| **kinds** | how the search box should read what somebody types after the colon |
| **computed fields** | names for things the data does not store at all |
| **`text`** | which fields a bare word searches |

One vocabulary serves both the JSON engine and the text front end, deliberately. Two lists of
field names would be two dialects within a week, and a filter typed into a search box has to
mean exactly what the JSON it becomes means.

## Harbour's vocabulary

Save this as `harbour/vocabulary.mjs`. Every example below imports it.

```js
import { defineVocabulary } from "@osqd/jql";

/** The names Harbour's data has — for the JSON engine and the search box alike. */
export const ORDERS = defineVocabulary()({
  fields: {
    id: { kind: "word", aliases: ["order"] },
    status: { kind: "exact", values: ["open", "paid", "refunded", "cancelled"] },
    channel: { kind: "exact", values: ["web", "app", "phone"] },
    who: { path: "customer.name" },
    country: { path: "customer.country", kind: "exact", values: ["GB", "US", "DE", "FR"] },
    email: { path: "customer.email", kind: "word" },
    sku: { path: "lines.sku", kind: "exact" },
    total: { kind: "number" },
    placed: { kind: "date", aliases: ["at"] },
    tag: { path: "tags", kind: "exact" },
    note: {},
    outstanding: { kind: "number", get: (order) => order.total - order.paid },
  },
  text: ["id", "who", "email", "sku", "note"],
});
```

Note the empty parentheses in `defineVocabulary()({ … })`. It is curried, so that you can give
it the document type — `defineVocabulary<Order>()({ … })` — and still have the field names
inferred from the object rather than having to write them twice.

## Querying by name

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const ids = (query) => filter(orders, query, { vocabulary: ORDERS }).map((o) => o.id);

console.log("a name for a nested path:", ids({ country: "GB" }));
console.log("a name through a list   :", ids({ sku: "desk-lamp" }));
console.log("an alias                :", ids({ at: { $gte: { $date: "2026-09-18" } } }));
```

```
a name for a nested path: [ 'o-1001', 'o-1003', 'o-1005' ]
a name through a list   : [ 'o-1005', 'o-1007' ]
an alias                : [ 'o-1006', 'o-1007', 'o-1008' ]
```

Not one of those queries mentions `customer`, `lines` or `placed`. The vocabulary is the only
thing that knows where those values are kept, so moving one is an edit to a single file.

## Computed fields

`outstanding` is not in the order book at all. It is `total - paid`, worked out when the query
runs:

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const ids = (query) => filter(orders, query, { vocabulary: ORDERS }).map((o) => o.id);

console.log("still owing anything:", ids({ outstanding: { $gt: 0 } }));
console.log("owing £100 or more  :", ids({ outstanding: { $gte: 100 } }));
```

```
still owing anything: [ 'o-1002', 'o-1004', 'o-1005', 'o-1007' ]
owing £100 or more  : [ 'o-1005', 'o-1007' ]
```

From the outside it is an ordinary field, and that is the point — it works everywhere a name
works:

```js
import { group, search } from "@osqd/jql";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const worst = search(orders, {
  where: { outstanding: { $gt: 0 } },
  sort: { outstanding: -1 },
  fields: ["id", "outstanding"],
}, { vocabulary: ORDERS });

console.log("sorted by it:");
for (const row of worst) console.log("  ", row.id, row.outstanding);

console.log("grouped by country, where it is owed:");
for (const held of group(orders, "country", { vocabulary: ORDERS, where: { outstanding: { $gt: 0 } } })) {
  console.log("  ", held.key, held.count);
}
```

```
sorted by it:
   o-1007 280
   o-1005 170
   o-1004 36
   o-1002 30
grouped by country, where it is owed:
   US 2
   DE 1
   GB 1
```

Lesson 7's exercise handed back `total` and `paid` and let the screen do the subtraction. Now
the screen asks for what it actually means.

Two things to know about `get`:

- It is called once per document per field it is tested against, and **it must not throw**. It
  is code running inside a filter; treat it as you would a comparison function.
- A computed field **cannot be pushed to a database** (lesson 15), because a store cannot run
  a function that lives in this process. `plan` knows that, and keeps those clauses here.

## Kinds

A `kind` is for the **text** front end only. A JSON query already says what it means with its
operator, so the engine ignores the kind entirely; it is how `total:>70` in a search box knows
to compare rather than to look for the characters `>70`.

| | |
| --- | --- |
| `text` | contains it, ignoring case. The default, and right for prose |
| `word` | contains it as a whole component — for identifiers and addresses |
| `exact` | equals it, ignoring case — for closed sets like a status |
| `number` | compares: `>70`, `10..20`, `42` |
| `date` | compares instants: `>2026-09-01`, `>-7d` |
| `boolean` | `true`/`false`, `yes`/`no`, `1`/`0` |

`values` lists what a closed set contains, which lesson 11 turns into completions.

## `strict`, for a public contract

```js
import { defineVocabulary, validate } from "@osqd/jql";

const PUBLIC = defineVocabulary()({
  fields: {
    status: { kind: "exact" },
    country: { path: "customer.country", kind: "exact" },
    placed: { kind: "date" },
  },
  strict: true,
});

const byName = validate({ country: "GB" }, { vocabulary: PUBLIC });
const byPath = validate({ "customer.email": "ada@example.com" }, { vocabulary: PUBLIC });

console.log("a name it knows   :", byName.valid ? "accepted" : byName.error.message);
console.log("a path it does not:", byPath.valid ? "accepted" : byPath.error.message);
```

```
a name it knows   : accepted
a path it does not: at customer.email: "customer.email" is not a field here
```

**With `strict`, the vocabulary is the whole contract.** A query may name those fields and
nothing else. That is what belongs in front of a public endpoint: documents grow fields nobody
promised to keep, and a query language that can reach every one of them turns every internal
field into part of your API.

Without `strict`, storage paths keep working alongside the names, which is what you want for
your own console.

## A vocabulary that would mean two things is refused

```js
import { defineVocabulary, JqlError } from "@osqd/jql";

const attempts = [
  ["a name that collides", () => defineVocabulary()({ fields: { a: {}, b: { aliases: ["A"] } } })],
  ["a path and a getter", () => defineVocabulary()({ fields: { a: { path: "x", get: () => 1 } } })],
  ["a text field that is not a field", () => defineVocabulary()({ fields: { a: {} }, text: ["b"] })],
];

for (const [why, build] of attempts) {
  try {
    build();
    console.log(`${why}: accepted`);
  } catch (error) {
    console.log(`${why}:`);
    console.log(`  ${error instanceof JqlError ? error.message : error}`);
  }
}
```

```
a name that collides:
  at vocabulary: "A" names both "a" and "b", so a query using it could mean either
a path and a getter:
  at vocabulary.a: "a" has both a path and a getter; one of them would be ignored, so say which
a text field that is not a field:
  at vocabulary.text: the text field "b" is not a field of this vocabulary, so a bare word would never search it
```

All three are refused **when the vocabulary is defined**, not when a query eventually uses it.
A vocabulary that could mean two things is a bug you want at startup, not in a support ticket.

## Exercise

Add a `days` field — how long an order has been waiting, in whole days, as of a given clock —
and find everything open for more than a week as of 25 September 2026.

<details>
<summary>Answer</summary>

A `get` receives only the document, so the clock has to come from the closure:

```js
import { defineVocabulary, filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const asOf = Date.parse("2026-09-25T12:00:00Z");

const AGED = defineVocabulary()({
  fields: {
    status: { kind: "exact" },
    days: { kind: "number", get: (order) => Math.floor((asOf - Date.parse(order.placed)) / 86_400_000) },
  },
});

console.log(filter(orders, { status: "open", days: { $gt: 7 } }, { vocabulary: AGED }).map((o) => o.id));
```

```
[ 'o-1002', 'o-1005' ]
```

Now notice what you have just built: a vocabulary whose meaning depends on **when it was
made**. That is fine for one created per request, and a trap at module level — a filter that
says "over a week old" and quietly means "over a week old as of process start" is exactly the
kind of wrongness the rest of this library works to prevent.

The alternative is a relative date from lesson 5, which resolves per compile and says what it
means: `{ placed: { $lt: { $date: { $ago: "7d" } } } }`.
</details>

## Related

- [TypeScript guide](../guides/typescript.md#vocabularies) — vocabularies with the types
- [Text syntax](../reference/text-syntax.md) — what each `kind` does to a typed value
