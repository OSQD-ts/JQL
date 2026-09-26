# Pushing a query into a store

Letting a backend answer the part of a query it can, and filtering the rest here.

← [Documentation](../index.md)

---

A store can usually answer part of a question — a field it has an index on, an operator it
has natively — and nothing of the rest. `plan` splits a query along that line:

```ts
import { plan, filter } from "@osqd/jql";

const split = plan(query, capabilities);
const rows = await store.find(split.pushed ?? {});          // the store answers what it can
const answer = split.remaining === undefined ? rows : filter(rows, split.remaining);
```

## The contract

> `pushed` ∧ `remaining` ≡ the query

That is the whole feature, and it is why the split happens only on **conjunctions**. A
query's keys all have to hold, and so do the parts of an `$and`, so each one can go to
either side independently. Anything else — a branch of an `$or`, one operator inside a
condition — cannot be split without changing what is asked, so a conjunct is pushed whole or
kept whole.

Two consequences worth knowing:

- **The pushed half is never narrower than the query.** A caller that ran only `pushed` would
  get too many rows, never too few. Too many can be filtered down; too few cannot be
  recovered.
- **`complete` says when the second pass can be skipped**, and it is the only thing worth
  checking before doing so.

`kept` says, per clause, why it stayed — "the store cannot filter on `total`", "the store
cannot answer a negation". That is what to print when somebody asks why a query is slow.

## Capabilities

```ts
const capabilities = {
  fields: ["status", "customer.country"],   // or "all"
  operators: ["$eq", "$in", "$gt", "$lt"],  // JQL's names, or "all"
  or: true,                                 // default false
  not: false,                               // default false
  // A last word, for a store whose limits depend on the values rather than the operators.
  accepts: (field, condition) => !("$regex" in condition),
};
```

Fields are named as **the store** names them: a vocabulary alias is resolved to its path
first. A vocabulary field that is *computed* is never pushed whatever the capabilities say —
the store has no way to run a function that lives here.

**What is pushed stands on its own.** Vocabulary names are rewritten to the paths the store
knows, and relative dates are resolved to instants, so a target needs no vocabulary and both
halves of the split are judged against the same moment. What stays here keeps the names it
was written with, because this engine understands them.

## MongoDB, the first target

```ts
import { plan } from "@osqd/jql";
import { MONGO_CAPABILITIES, toMongoFilter } from "@osqd/jql/mongo";

const split = plan(query, MONGO_CAPABILITIES);
const filter = toMongoFilter(split.pushed);
const rows = await collection.find(filter).toArray();
```

The operator names line up for the most part, so most of the translation is a copy. The
interesting part is the handful that do not:

| JQL | MongoDB |
| --- | --- |
| `$contains`, `$startsWith`, `$endsWith`, `$glob` | an escaped, anchored `RegExp` |
| `$eq`/`$in` with `$options: "i"` | an anchored case-insensitive `RegExp` |
| `{ "$date": … }`, including `{ "$ago": … }` | a `Date` |
| `$type: "number"` | `$type: ["double", "int", "long", "decimal"]` |
| `$not` over a query | `$nor: [ … ]` |
| `$word`, `$length`, `{ "$field": … }`, `$text` | **not in `MONGO_CAPABILITIES`** |

Some of MongoDB's own operators answer exactly for some values and not for others, which a
list of names cannot say — so the capabilities carry an `accepts` function as well, and it
keeps back: equality against an embedded document (MongoDB compares its keys in order, JQL
does not), the case-insensitive form of any comparison whose operand is not a single string
(a pattern stands in for one string and nothing deeper), `$type: "integer"` (JQL means "a
number with no fractional part", MongoDB means the `int` storage type), `$type: "bigint"` (a
run-time type JSON cannot carry, where a driver hands back an ordinary number for a stored
`long`), and `$regex` carrying a flag MongoDB does not take.

One difference is not about operators at all, and no capability can express it: **an array
held directly inside another array**. A path segment in MongoDB applies to an array's
elements but not to the elements of *those* arrays, while JQL sees an array through at every
level (specification §3). For such a document the two answer differently, in either
direction, and `plan` cannot know — the shape is in the data, not in the query. If a
collection stores arrays of arrays of documents, do not treat `complete` as permission to
skip the second pass over those fields.

The last row is the point. Those four have no exact MongoDB filter, so they are not in the
capabilities, so `plan` keeps them here and `toMongoFilter` never sees them. A translation
that was *nearly* right would be the worst of both: fewer rows than the query asked for, from
a store that looked like it had answered.

## What a target is promising

`pushed ∧ remaining ≡ query` holds only if the store answers `pushed` **the way JQL would**.
That is an assumption about the store, not something this library can check, and it is where
a target goes quietly wrong.

This target is the easy case, because so many of the operators mean the same thing on both
sides: the translation was checked against an independent implementation of that store's
matching rules over 100 000 comparisons on generated queries — the string operators, globs, case-insensitive equality
and membership, `$not`, and the type names — with no disagreement.

Two places to be careful in any target, found while doing that:

- **Coercion.** JQL compares like with like: `$mod` against a boolean or a `null` matches
  nothing. A store that reads `false` as `0` will answer a pushed `$mod` with rows JQL would
  not have returned. If a store coerces, leave the operator out of its capabilities.
- **Missing values under a path that crosses an array.** JQL says an empty array reaches
  *missing*, so `{ "items.sku": null }` matches a document whose `items` is `[]`. Stores
  differ here, and the difference is invisible until somebody's page is short a row.

Where a store's answer might differ at all, the operator does not belong in its
capabilities. A clause kept here costs a second pass; a clause pushed to a store that reads
it differently costs the right answer.

## Writing another target

1. Write the capabilities: the fields and operators it can answer **exactly**, with the
   semantics above. Leave out anything you would have to approximate, and anything whose
   behaviour on an odd value — a boolean where a number is expected, a missing field under an
   array — you have not checked.
2. Write the translation for those operators, and throw for anything else — it should never
   arrive, and if it does you want to know.
3. Test the contract on data: for a spread of queries and capability sets, the store's filter
   and the remaining predicate together must match exactly what the whole query matches.
   `tests/plan.test.ts` does this and is worth copying.

## Related

- [Library API](../reference/api.md) — `plan`, and the collection helpers for the second pass
- [The specification](../reference/specification.md#14-splitting-a-query) — the rule that makes the split safe
