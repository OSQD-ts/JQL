# Lesson 12 — Queries from outside

**Goal:** accept a query from a URL or a request body without accepting *every* query.

← [Course](index.md) · Previous: [The search box](11-the-search-box.md) · Next: [Saved filters](13-saved-filters.md)

---

## A filter in a URL is a lovely API

…right up until it is a way to read every field of every row, and spend a minute of CPU doing
it. A query is data, which is what lets it travel — and what lets one arrive from somebody you
have never met.

Three independent things make that safe, and a fourth ties them together:

| | |
| --- | --- |
| **the untrusted limits** | bound **cost** — size, depth, patterns |
| **an allowlist** | bounds **capability** — the operators this endpoint answers |
| **a strict vocabulary** | bounds **surface** — the fields it will talk about |
| **`validate`** | one call that answers 400 with a sentence instead of 500 with a stack |

## The endpoint

Save this as `harbour/public-api.mjs`; the examples below use it.

```js
import { UNTRUSTED_LIMITS, defineVocabulary, validate } from "@osqd/jql";
import { orders } from "./orders.mjs";

/** The fields a stranger may ask about — and, because of `strict`, no others. */
const PUBLIC = defineVocabulary()({
  fields: {
    status: { kind: "exact", values: ["open", "paid", "refunded", "cancelled"] },
    country: { path: "customer.country", kind: "exact" },
    total: { kind: "number" },
    placed: { kind: "date" },
  },
  strict: true,
});

/** The untrusted caps, plus the short menu of operators this endpoint answers. */
const limits = {
  ...UNTRUSTED_LIMITS,
  allowOperators: ["$eq", "$ne", "$in", "$gt", "$gte", "$lt", "$lte", "$and", "$or"],
};

/** One request: JSON in, a status line out. */
export function endpoint(body) {
  const checked = validate(JSON.parse(body), { vocabulary: PUBLIC, limits });
  if (!checked.valid) return `400 ${checked.error.message}`;
  return `200 ${orders.filter(checked.test).map((o) => o.id).join(" ") || "(no matches)"}`;
}
```

## What it accepts

```js
import { endpoint } from "./public-api.mjs";

console.log(endpoint('{"status":"open"}'));
console.log(endpoint('{"country":"GB","total":{"$gte":20}}'));
console.log(endpoint('{"placed":{"$gte":{"$date":"2026-09-18"}}}'));
console.log(endpoint('{"status":{"$in":[]}}'));
```

```
200 o-1002 o-1005
200 o-1001 o-1005
200 o-1006 o-1007 o-1008
200 (no matches)
```

Ordinary queries, named through the vocabulary. The last one matches nothing and is still a
perfectly valid request — "no results" is an answer, not an error.

## What it refuses, and what it says

```js
import { endpoint } from "./public-api.mjs";

for (const body of [
  '{"customer.email":"ada@example.com"}',
  '{"note":{"$contains":"gift"}}',
  '{"total":{"$gtt":20}}',
  '{"status":{"$regex":"^o"}}',
  '{"$text":"ada"}',
]) {
  console.log(body);
  console.log("  ", endpoint(body));
}
```

```
{"customer.email":"ada@example.com"}
   400 at customer.email: "customer.email" is not a field here
{"note":{"$contains":"gift"}}
   400 at note: "note" is not a field here
{"total":{"$gtt":20}}
   400 at total.$gtt: "$gtt" is not an operator this query may use ($eq, $ne, $in, $gt, $gte, $lt, $lte, $and, …)
{"status":{"$regex":"^o"}}
   400 at status.$regex: "$regex" is not an operator this query may use ($eq, $ne, $in, $gt, $gte, $lt, $lte, $and, …)
{"$text":"ada"}
   400 at $text: "$text" is not an operator this query may use ($eq, $ne, $in, $gt, $gte, $lt, $lte, $and, …)
```

Every refusal is a sentence you can hand straight back to the caller. It quotes only the query
they sent, and it names the place in it — so a partner integrating against your API can fix
their request without opening a support ticket.

## Why `validate` and not `try`/`compile`

`validate` **hands back the predicate it compiled**. That is not a convenience; it closes a
real hole. The obvious alternative has a gap in the middle of it:

```ts
function handler(body: string) {
  const query = JSON.parse(body);
  if (!isValid(query, { limits: UNTRUSTED_LIMITS })) return respond(400);
  const test = compile(query);            // ← the untrusted limits are gone
  return respond(200, orders.filter(test));
}
```

```
!! THREW
file:///tmp/claude-1000/-home-micha-Documents-OSQD/b2e0526c-49d7-4fed-9959-41234adfc826/scratchpad/harbour/authoring-3.mjs:1
if (!isValid(query, { limits: UNTRUSTED_LIMITS })) return respond(400);
                                                   ^^^^^^

SyntaxError: Illegal return statement
    at compileSourceTextModule (node:internal/modules/esm/utils:346:16)
```

Two compiles, two sets of options, and the check no longer describes the thing that runs.
Nothing in that code looks wrong. With `validate`, the query you checked *is* the query you
run.

## The limits

```js
import { DEFAULT_LIMITS, UNTRUSTED_LIMITS } from "@osqd/jql";

for (const [name, limits] of [["default", DEFAULT_LIMITS], ["untrusted", UNTRUSTED_LIMITS]]) {
  console.log(name);
  for (const [key, value] of Object.entries(limits)) console.log("  ", key.padEnd(18), JSON.stringify(value));
}
```

```
default
   maxDepth           32
   maxNodes           10000
   maxPatternLength   1024
   maxGlobLength      1024
   maxTextDepth       16
   allowRegex         true
   allowOperators     "all"
untrusted
   maxDepth           16
   maxNodes           512
   maxPatternLength   0
   maxGlobLength      256
   maxTextDepth       8
   allowRegex         false
   allowOperators     "all"
```

`UNTRUSTED_LIMITS` halves the depth, caps the query at 512 fields and operators, and **turns
`$regex` off** — `maxPatternLength: 0`.

That last one is the important one. No engine can tell a pattern that backtracks for a minute
(`(a+)+$` against a long run of `a`s) from one that returns immediately, without running it.
The string operators from lesson 2 answer almost everything a pattern would, in linear time,
and they stay available.

Every cap **refuses** rather than truncates. A query quietly cut short answers a different
question, and nobody downstream can tell that it did.

## The allowlist

`$regex` being off is a decision this library makes for you. Which of the *rest* your endpoint
wants is a decision only you can make: `$text` walks a whole document, `$elemMatch` carries a
query of its own. An endpoint that needs neither says so once, in `allowOperators`, rather
than finding out later which of them somebody used.

```js
import { validate } from "@osqd/jql";

const typo = validate({ a: 1 }, { limits: { allowOperators: ["$eq", "$gte", "$grater"] } });

console.log(typo.valid ? "accepted" : typo.error.message);
```

```
at limits.allowOperators: "$grater" is not an operator, so allowing it allows nothing
```

A typo in the allowlist is refused too. An allowlist that allows nothing while looking like it
allows something is precisely the failure this library exists to prevent.

## The strict vocabulary

This is the defence people skip and regret. Without it a query can reach **every field of
every row you run it over** — including the ones you added last week and never meant to
publish. `customer.email` and `note` were refused above not because they are secret, but
because they were never promised.

## What this is not

**Not an access control layer.** A query runs over the rows you hand it. If a caller must not
see a row, do not put the row in the collection — filter first, then run their query over what
is left.

**Not a bound on the request.** A `$in` of a million values is a legitimate query, and `$in`
lists deliberately do not count towards `maxNodes`, because looking one item up in a set costs
the same however long the list is. Cap the body where you read it.

## Exercise

Harbour's public API should let a partner ask about their own orders by status and date, but
never about money. Write the vocabulary, and prove it by showing what happens to
`{"total":{"$gte":100}}`.

<details>
<summary>Answer</summary>

Leave `total` out of the vocabulary entirely. `strict` does the rest:

```js
import { UNTRUSTED_LIMITS, defineVocabulary, validate } from "@osqd/jql";

const PARTNER = defineVocabulary()({
  fields: { status: { kind: "exact" }, placed: { kind: "date" } },
  strict: true,
});

const asked = validate({ total: { $gte: 100 } }, { vocabulary: PARTNER, limits: UNTRUSTED_LIMITS });

console.log(asked.valid ? "accepted" : asked.error.message);
```

```
at total: "total" is not a field here
```

A field that is not in the vocabulary cannot be filtered on — *and* cannot be sorted by or
projected with, because `fields`, `omit` and `sort` resolve their names through the same
vocabulary. One list, one contract.
</details>

## Related

- [Queries from outside](../guides/untrusted-input.md) — the same ground as a reference page
- [Security](../../SECURITY.md) — what this does and does not promise
- [Specification §10](../reference/specification.md#10-limits) — what the standard says about caps
