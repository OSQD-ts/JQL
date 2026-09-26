# Lesson 13 — Saved filters

**Goal:** give every question one shape and one short name, so a list of saved filters does
not quietly hold the same filter three times.

← [Course](index.md) · Previous: [Queries from outside](12-untrusted.md) · Next: [Logs and streams](14-streams-and-cli.md)

---

## The same question, four spellings

Once people can save a filter, they save the same one repeatedly. One was typed into the
search box, one was written by hand, one was built by a form, one came back from an API with
its keys in a different order.

They are one question and four rows in a table — and a cache keyed on the query text misses on
every one of them.

Two functions fix that:

- **`canonical(query)`** rewrites a query into one fixed shape;
- **`fingerprint(query)`** names that shape in sixteen characters.

## One filter, one name

```js
import { fingerprint } from "@osqd/jql";

const written = [
  { status: "open", total: { $gte: 100 } },
  { total: { $gte: 100 }, status: "open" },
  { status: { $eq: "open" }, total: { $gte: 100 } },
  { $and: [{ status: "open" }, { total: { $gte: 100 } }], $comment: "chasing" },
];

for (const query of written) console.log(fingerprint(query), JSON.stringify(query));

console.log("distinct filters here:", new Set(written.map(fingerprint)).size);
```

```
03646d4ac8b6def3 {"status":"open","total":{"$gte":100}}
03646d4ac8b6def3 {"total":{"$gte":100},"status":"open"}
03646d4ac8b6def3 {"status":{"$eq":"open"},"total":{"$gte":100}}
03646d4ac8b6def3 {"$and":[{"status":"open"},{"total":{"$gte":100}}],"$comment":"chasing"}
distinct filters here: 1
```

Four spellings, one name. Note the fourth in particular: a `$and` of two clauses, and a
comment, and it still lands on the same fingerprint as the other three.

## The shape behind the name

```js
import { canonical } from "@osqd/jql";

const typed = { $and: [{ status: "open" }, { total: { $gte: 100 } }], $comment: "chasing" };

console.log(JSON.stringify(canonical(typed), null, 2));
```

```
{
  "status": {
    "$eq": "open"
  },
  "total": {
    "$gte": 100
  }
}
```

What comes back **is still a query** — you can run it, store it, or put it in a URL — and it
matches exactly what the original matched. The test suite holds it to that on thousands of
generated queries by running both and comparing answers, rather than by comparing shapes.

| Written | Becomes |
| --- | --- |
| `{ a: 1 }` | `{ a: { $eq: 1 } }` — a bare value is a condition |
| keys in any order | keys sorted |
| `$comment: "…"` | dropped: a note decides nothing |
| `{ $and: [x, y] }` | `{ …x, …y }` — the box writes the first, a person writes the second |
| `$and` inside `$and` | one `$and` |
| `{ $in: [3, 1, 3] }` | `{ $in: [1, 3] }` — a list that is a set is sorted and deduplicated |
| `$options: "ui"` | `$options: "iu"` |
| the branches of an `$or` | sorted, so branch order stops mattering |

## Different questions, different names

```js
import { fingerprint } from "@osqd/jql";

const questions = [
  { status: "open" },
  { status: "paid" },
  { status: { $ne: "open" } },
  { $or: [{ status: "open" }, { status: "paid" }] },
  { $or: [{ status: "paid" }, { status: "open" }] },
];

for (const query of questions) console.log(fingerprint(query), JSON.stringify(query));
```

```
d4d13aede48bfdad {"status":"open"}
0c24bc335f3c3269 {"status":"paid"}
a5ba405e8cd835c8 {"status":{"$ne":"open"}}
bc66ac7eefa26bc0 {"$or":[{"status":"open"},{"status":"paid"}]}
bc66ac7eefa26bc0 {"$or":[{"status":"paid"},{"status":"open"}]}
```

The last two are the same question with its branches the other way round, so they share a
name.

## What it deliberately will not do

```js
import { fingerprint } from "@osqd/jql";

console.log(fingerprint({ total: { $gt: 3 } }), "{ total: { $gt: 3 } }");
console.log(fingerprint({ total: { $gte: 4 } }), "{ total: { $gte: 4 } }");
```

```
e7a73371277f4960 { total: { $gt: 3 } }
a27bb5f54416fc83 { total: { $gte: 4 } }
```

Those two agree on every integer, and disagree on 3.5. They get different names, and that is
the honest limit of the whole idea:

> **Equal fingerprints mean the same query. Different fingerprints mean only that the queries
> are written differently.**

One direction is a cheap, decidable property. The other — deciding whether two arbitrary
queries select the same rows — is not, and a tool that claimed to do it would be wrong in ways
you would find out about much later.

## About the name itself

A fingerprint is a 64-bit checksum in hexadecimal. It is **not** a cryptographic hash: two
different queries can collide, rarely, and never in a way that matters for a cache you are
allowed to miss.

It **is** stable across processes and across versions of this library, so it is safe as a
stored key. A set of fingerprints is written into the test suite precisely so that changing
what a query is called takes a deliberate act rather than happening as a side effect.

## Where this earns its place

- **A saved-filter list.** Fingerprint before inserting, and say "you already have this one,
  saved as *Chasing large orders*" instead of adding a fifth copy.
- **A cache key.** `` `orders:${fingerprint(query)}` ``.
- **A log line.** Sixteen characters that say which filter ran, without printing a query that
  may be long and may contain a customer's email address.
- **Telling two dashboards apart** when both claim to show "open orders" and one of them is
  wrong.

## Exercise

Harbour's filter list stores `{ name, query }`. Write `save(list, name, query)` so that saving
a duplicate gives back the existing entry instead of adding a row.

<details>
<summary>Answer</summary>

```js
import { canonical, fingerprint } from "@osqd/jql";

const save = (list, name, query) => {
  const key = fingerprint(query);
  const already = list.find((entry) => entry.key === key);
  if (already !== undefined) return { saved: false, as: already.name };
  list.push({ key, name, query: canonical(query) });
  return { saved: true, as: name };
};

const list = [];

console.log(save(list, "Chasing large orders", { status: "open", total: { $gte: 100 } }));
console.log(save(list, "Big open ones", { total: { $gte: 100 }, status: { $eq: "open" } }));
console.log("rows in the list:", list.length);
```

```
{ saved: true, as: 'Chasing large orders' }
{ saved: false, as: 'Chasing large orders' }
rows in the list: 1
```

Store `canonical(query)` rather than whatever was typed, so the row you read back tomorrow has
one shape instead of whichever spelling happened to arrive first. Keep the fingerprint beside
it, so the lookup is an index rather than a scan.
</details>

## Related

- [Library API](../reference/api.md) — `canonical` and `fingerprint`
- [Specification §13](../reference/specification.md#13-canonical-form-optional) — the rules, so another implementation agrees
