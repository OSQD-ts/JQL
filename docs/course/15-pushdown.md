# Lesson 15 — Pushing a query into a store

**Goal:** let a database answer the part of a query it can, and answer the rest here — without
either half quietly changing the question.

← [Course](index.md) · Previous: [Logs and streams](14-streams-and-cli.md) · Next: [Extending it, and proving it](16-extending.md)

---

## Half a query is still useful

Every query so far has run over an array in memory. Harbour's orders really live in a
database, and that database can answer *some* of what a query asks — the indexed fields, the
operators it happens to have — and none of the rest.

`plan(query, capabilities)` splits a query in two:

```
pushed ∧ remaining ≡ query
```

The store filters with `pushed`; this engine filters what comes back with `remaining`. That
identity is the contract, and it has a direction: **neither half is ever wider than the
query**, so a caller that runs only `pushed` gets too many rows rather than too few.

It splits only on **conjunctions**, because those are the only parts that can go to either
side independently. A branch of an `$or` cannot be split without changing what is asked, so a
conjunct goes whole or not at all.

## Describing a store

Save this as `harbour/store.mjs`. It is what a modest store can do: a few indexed columns,
equality and ranges, nothing clever.

```js
/** What Harbour's database can answer for itself. */
export const INDEXED = {
  fields: ["status", "customer.country", "placed", "total"],
  operators: ["$eq", "$in", "$gt", "$gte", "$lt", "$lte", "$and"],
  or: false,
  not: false,
};

/** Print a plan the way a person reads one. */
export function show(result) {
  console.log("  pushed   ", JSON.stringify(result.pushed));
  console.log("  remaining", JSON.stringify(result.remaining));
  console.log("  complete ", result.complete);
  for (const kept of result.kept) console.log(`  kept      ${kept.at}: ${kept.why}`);
}
```

| | |
| --- | --- |
| `fields` | the paths it can filter on, as **it** names them, or `"all"` |
| `operators` | the operators it can answer, in JQL's names, or `"all"` |
| `or` | whether it can answer an `$or`. Default `false` — plenty of key-value stores cannot |
| `not` | whether it can answer a negation. Default `false` |
| `accepts` | the last word on one field's condition, for a store whose limits depend on the *values* |

## Splitting a query

```js
import { plan } from "@osqd/jql";
import { INDEXED, show } from "./store.mjs";

const query = {
  status: "paid",
  "customer.country": "GB",
  note: { $contains: "neighbour" },
  "lines.quantity": { $gte: 3 },
};

show(plan(query, INDEXED));
```

```
  pushed    {"$and":[{"status":"paid"},{"customer.country":"GB"}]}
  remaining {"$and":[{"note":{"$contains":"neighbour"}},{"lines.quantity":{"$gte":3}}]}
  complete  false
  kept      note: the store cannot filter on "note"
  kept      lines.quantity: the store cannot filter on "lines.quantity"
```

Two conjuncts went to the store, two stayed here, and `kept` says why each one stayed.

That sentence — `the store cannot filter on "note"` — is something you can act on. Either
index `note` and add it to `fields`, or decide you do not care. A pushdown layer that silently
held things back would leave you guessing why a query is slow.

## The halves add up

```js
import { filter, plan } from "@osqd/jql";
import { orders } from "./orders.mjs";
import { INDEXED } from "./store.mjs";

const query = {
  status: "paid",
  "customer.country": "GB",
  note: { $contains: "neighbour" },
  "lines.quantity": { $gte: 3 },
};

const { pushed, remaining } = plan(query, INDEXED);

// `orders` stands in for the database here; in real life this is a round trip.
const fromStore = filter(orders, pushed ?? {});
const answer = filter(fromStore, remaining ?? {});

console.log("the store returned:", fromStore.map((o) => o.id));
console.log("the engine kept   :", answer.map((o) => o.id));
console.log("whole query, here :", filter(orders, query).map((o) => o.id));
```

```
the store returned: [ 'o-1001', 'o-1003' ]
the engine kept   : [ 'o-1001' ]
whole query, here : [ 'o-1001' ]
```

The store narrowed eight orders to two, using only indexed columns; the engine took one of
those away. The answer is the one the whole query gives.

## What cannot be split at all

```js
import { plan } from "@osqd/jql";
import { INDEXED, show } from "./store.mjs";

show(plan({ $or: [{ status: "open" }, { status: "paid" }] }, INDEXED));
```

```
  pushed    undefined
  remaining {"$or":[{"status":"open"},{"status":"paid"}]}
  complete  false
  kept      $or: the store cannot answer an $or
```

`pushed` is `undefined` — there is nothing to send. Both branches are about an indexed field,
but this store cannot answer an `$or` at all, and half an `$or` is a different question. So
the whole thing stays here, and `kept` says so in one line.

## A store that can answer more

A store target is a capabilities object plus a translator. One ships with the library, for
document databases that speak the conventional query-document dialect:

```js
import { plan } from "@osqd/jql";
import { MONGO_CAPABILITIES, toMongoFilter } from "@osqd/jql/mongo";

const query = {
  status: "paid",
  "customer.country": "GB",
  note: { $contains: "neighbour" },
  "lines.quantity": { $gte: 3 },
};

const planned = plan(query, MONGO_CAPABILITIES);

console.log("complete:", planned.complete);
// A driver is handed real RegExp and Date objects, which JSON.stringify cannot show.
const readable = (value) => JSON.stringify(value, (_, held) => (held instanceof RegExp ? `/${held.source}/${held.flags}` : held));
console.log("filter  :", readable(toMongoFilter(planned.pushed)));
```

```
complete: true
filter  : {"$and":[{"status":"paid"},{"customer.country":"GB"},{"note":"/neighbour/"},{"lines.quantity":{"$gte":3}}]}
```

All four conjuncts went, so `complete` is `true` and there is no second pass to run:

```ts
const { pushed, remaining, complete } = plan(query, MONGO_CAPABILITIES);
const rows = await collection.find(toMongoFilter(pushed)).toArray();
const answer = complete ? rows : filter(rows, remaining);
```

Look at what happened to `$contains`. The store has no such operator, so the target wrote an
**escaped pattern** that the store runs exactly as JQL would.

What a target will not do is guess. Any operator the store cannot answer *exactly* is left out
of its capabilities, so `plan` keeps those clauses here and the translator never sees them. A
translation that was *nearly* right would be the worst of both worlds: fewer rows than the
query asked for, from a store that looked as though it had answered.

## The limit of `complete`

Capabilities describe what a store can be *asked*. They cannot describe how it resolves a path
through your data, and those can differ.

The case to know about is an array held directly inside another array. JQL sees an array
through at every level (lesson 3); a store may apply a path segment to an array's elements but
not to the elements of *those* arrays. For such a document the two give different answers, and
`plan` cannot know, because nothing in the query says what shape the rows are.

If your collection stores arrays of arrays of documents, do not read `complete` as permission
to skip the second pass over those fields.

## Exercise

Harbour's store gains an index on `tags`. Add it to `INDEXED` and see what changes for
`{ status: "paid", tags: "repeat", note: { $contains: "same" } }`.

<details>
<summary>Answer</summary>

```js
import { plan } from "@osqd/jql";
import { INDEXED, show } from "./store.mjs";

const WITH_TAGS = { ...INDEXED, fields: [...INDEXED.fields, "tags"] };

show(plan({ status: "paid", tags: "repeat", note: { $contains: "same" } }, WITH_TAGS));
```

```
  pushed    {"$and":[{"status":"paid"},{"tags":"repeat"}]}
  remaining {"note":{"$contains":"same"}}
  complete  false
  kept      note: the store cannot filter on "note"
```

`tags: "repeat"` pushed as an equality even though `tags` is a list, because *a value matches
any element* is a rule both sides share — and shared rules are exactly what makes a clause
safe to push.

`note` stayed, and the reason is worth reading closely: `the store cannot filter on "note"`.
Not "cannot answer `$contains`" — `note` is not in `fields` at all, so the field is refused
before the operator is ever considered. Two different fixes hide behind those two sentences
(index the column, or teach the store an operator), which is why `kept` says which one it is.
</details>

## Related

- [Pushing a query into a store](../guides/pushdown.md) — the guide, including writing your own target
- [Specification §14](../reference/specification.md#14-splitting-a-query) — the split, as a rule other implementations can follow
