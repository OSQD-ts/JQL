# Lesson 7 — Requests

**Goal:** ask a whole question — which rows, in what order, which page, which fields — as one
document.

← [Course](index.md) · Previous: [Typed queries](06-typed-queries.md) · Next: [Counting by a field](08-grouping.md)

---

## A table on a screen is four questions

It is a filter, an order, a page, and a decision about which columns are allowed to leave the
server. A **request** is all four in one JSON document:

```json
{
  "where":  { "status": "paid" },
  "sort":   { "total": -1 },
  "skip":   0,
  "limit":  20,
  "fields": ["id", "total"],
  "omit":   []
}
```

Every key is optional, and `where` takes a query — everything from lessons 1 to 5. Because the
whole thing is still one JSON document, the whole question can travel in a URL, be saved, or
be validated in one go.

`search(collection, request)` runs it.

## Filter, sort, and take a page

```js
import { search } from "@osqd/jql";
import { orders } from "./orders.mjs";

const page = search(orders, {
  where: { status: { $ne: "cancelled" } },
  sort: { total: -1 },
  limit: 3,
  fields: ["id", "total"],
});

for (const row of page) console.log(row);
```

```
{ id: 'o-1005', total: 170 }
{ id: 'o-1004', total: 36 }
{ id: 'o-1006', total: 33 }
```

## The next page

Add `skip`. Nothing else changes:

```js
import { search } from "@osqd/jql";
import { orders } from "./orders.mjs";

const request = {
  where: { status: { $ne: "cancelled" } },
  sort: { total: -1 },
  limit: 3,
  fields: ["id", "total"],
};

console.log("page 1:", search(orders, { ...request, skip: 0 }).map((row) => row.id));
console.log("page 2:", search(orders, { ...request, skip: 3 }).map((row) => row.id));
console.log("page 3:", search(orders, { ...request, skip: 6 }).map((row) => row.id));
```

```
page 1: [ 'o-1005', 'o-1004', 'o-1006' ]
page 2: [ 'o-1002', 'o-1001', 'o-1008' ]
page 3: [ 'o-1003' ]
```

## Sorting by more than one key

The keys are applied in order: the first sorts, the next breaks its ties. `1` or `"asc"` is
ascending, `-1` or `"desc"` descending.

```js
import { search } from "@osqd/jql";
import { orders } from "./orders.mjs";

const line = (row) => `${row.status.padEnd(10)}${String(row.total).padStart(6)}  ${row.id}`;

console.log("by status alone:");
for (const row of search(orders, { sort: { status: "asc" } })) console.log("  ", line(row));

console.log("by status, then total, descending:");
for (const row of search(orders, { sort: { status: "asc", total: -1 } })) console.log("  ", line(row));
```

```
by status alone:
   cancelled    280  o-1007
   open          30  o-1002
   open         170  o-1005
   paid        22.5  o-1001
   paid         4.5  o-1003
   paid          33  o-1006
   paid          12  o-1008
   refunded      36  o-1004
by status, then total, descending:
   cancelled    280  o-1007
   open         170  o-1005
   open          30  o-1002
   paid          33  o-1006
   paid        22.5  o-1001
   paid          12  o-1008
   paid         4.5  o-1003
   refunded      36  o-1004
```

### Why this paging can be trusted

**The sort is stable.** In the first list the four paid orders tie on the only key there is,
and they come back in the order they arrived: `o-1001`, `o-1003`, `o-1006`, `o-1008`. An
unstable sort is free to return them in any order at all, and a *different* order each time —
so a reader paging through would see one of them twice and never see another. Adding `total`
as a second key, as the second list does, settles them deliberately instead.

**Missing values have a defined place.** The full order is written down in the specification —
missing and `null` first, then numbers, strings, objects, booleans, dates. It is not the order
you would guess. It is the order you can *rely* on, which is the property that matters when
two systems sort the same result.

## `fields` — keeping some of the document

```js
import { search } from "@osqd/jql";
import { orders } from "./orders.mjs";

const [row] = search(orders, {
  where: { id: "o-1001" },
  fields: ["id", "customer.name", "lines.sku"],
});

console.log(JSON.stringify(row, null, 2));
```

```
{
  "id": "o-1001",
  "customer": {
    "name": "Ada Lovelace"
  },
  "lines": [
    {
      "sku": "pen-fine"
    },
    {
      "sku": "ink-blue"
    }
  ]
}
```

`fields` keeps the paths you name **in the document's own shape**. `customer.name` comes back
as `{ customer: { name } }`, and an array on the way stays an array of projected elements. A
caller reads a projected row exactly as it reads a whole one — no flattening, no `"customer.name"`
keys to unpick.

## `omit` — dropping some of it

```js
import { search } from "@osqd/jql";
import { orders } from "./orders.mjs";

const [row] = search(orders, {
  where: { id: "o-1001" },
  omit: ["customer.email", "lines", "note"],
});

console.log(JSON.stringify(row, null, 2));
```

```
{
  "id": "o-1001",
  "placed": "2026-09-01T09:15:00Z",
  "status": "paid",
  "channel": "web",
  "customer": {
    "name": "Ada Lovelace",
    "country": "GB"
  },
  "total": 22.5,
  "paid": 22.5,
  "tags": [
    "gift"
  ]
}
```

`omit` runs **after** `fields`, and that order is what redaction needs:

```json
{ "fields": ["request"], "omit": ["request.headers.cookie"] }
```

Keep the whole request object, except the one header that must not leave the process. Naming
every header you *do* want would mean a code change every time a new one appears; naming the
one you do not is a rule that stays true.

The row is copied rather than changed, and only the objects on the way to a dropped field are
copied — so redacting one field of a large record does not duplicate the record.

## Two things `search` does that a hand-written version would not

**Without a sort, it stops early.** The first page of matches is the first `skip + limit` of
them, so the walk ends as soon as it has them rather than testing the rest of the collection.

**With a sort and a limit, it keeps only the best `skip + limit`** in a bounded heap rather
than sorting everything to keep ten. "The ten largest orders out of a million" sorts ten. This
is the one case where `search` is genuinely *faster* than filter-sort-slice by hand, rather
than merely equal to it.

## Exercise

The console shows "the five newest orders that still owe money", with the id, the customer's
name, and enough to work out what is outstanding. Write the request.

<details>
<summary>Answer</summary>

```js
import { search } from "@osqd/jql";
import { orders } from "./orders.mjs";

const chase = search(orders, {
  where: { paid: 0, status: { $nin: ["cancelled", "refunded"] } },
  sort: { placed: -1 },
  limit: 5,
  fields: ["id", "customer.name", "total", "paid"],
});

for (const row of chase) console.log(row.id, row.customer.name, "owes", row.total - row.paid);
```

```
o-1005 Tim Berners-Lee owes 170
o-1002 Grace Hopper owes 30
```

`paid: 0` is the filter. The `$nin` is what stops a cancelled or refunded order appearing on a
list of people to chase — worth writing down, because "unpaid" and "owes money" are not the
same set.

In lesson 10 `outstanding` becomes a computed field, and this request gets to name it
directly instead of handing back two numbers for the screen to subtract.
</details>

## Related

- [Specification §8](../reference/specification.md#8-requests) — the request envelope
- [Specification §8.1](../reference/specification.md#81-sort-order) — the order, in full
