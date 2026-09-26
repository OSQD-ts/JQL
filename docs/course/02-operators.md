# Lesson 2 — Asking precisely

**Goal:** the field operators, and which one to reach for.

← [Course](index.md) · Previous: [Your first query](01-first-query.md) · Next: [Arrays and paths](03-arrays-and-paths.md)

---

## Beyond equality

`{ status: "open" }` asks whether a value *equals* something. For everything else, put an
object in place of the value and fill it with **operators**:

```json
{ "total": { "$gte": 30 } }
```

An operator is one question about the value the path reached. Several operators in one object
all have to hold, which is how you write a range:

```json
{ "total": { "$gte": 30, "$lt": 140 } }
```

The names are the conventional ones — `$gte`, `$in`, `$exists` — so most of this lesson is
recognition rather than learning. Read it for the three or four places where the answer is
not the one you expected.

> As in lesson 1, every example is a complete program to run next to `orders.mjs`.

## Comparing

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("at least 30    ", ids({ total: { $gte: 30 } }));
console.log("30 up to 140   ", ids({ total: { $gte: 30, $lt: 140 } }));
console.log("under 20       ", ids({ total: { $lt: 20 } }));
```

```
at least 30     [ 'o-1002', 'o-1004', 'o-1005', 'o-1006', 'o-1007' ]
30 up to 140    [ 'o-1002', 'o-1004', 'o-1006' ]
under 20        [ 'o-1003', 'o-1008' ]
```

`$gt`, `$gte`, `$lt` and `$lte` compare **like with like only**. A number is compared with
numbers and a string with strings; `"10"` is never greater than `9`, and asking is not an
error, it simply does not match. A comparison that quietly converted would give a different
answer depending on which side happened to be text, and a filter that means different things
on different rows is one nobody can reason about.

## Membership

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("open or cancelled", ids({ status: { $in: ["open", "cancelled"] } }));
console.log("anything but paid", ids({ status: { $nin: ["paid"] } }));
```

```
open or cancelled [ 'o-1002', 'o-1005', 'o-1007' ]
anything but paid [ 'o-1002', 'o-1004', 'o-1005', 'o-1007' ]
```

`$in` is *any of these*, `$nin` is *none of these*. Both take a plain list, so a set of
checkboxes in a user interface turns into one operator rather than a chain of `$or`.

## Missing, null, and neither

This is the part of the lesson worth slowing down for. Three of the eight orders have no
`note` field at all; `o-1007` has one, and its value is `null`.

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("the field is there ", ids({ note: { $exists: true } }));
console.log("the field is absent", ids({ note: { $exists: false } }));
console.log("note is null       ", ids({ note: null }));
console.log("note is text       ", ids({ note: { $type: "string" } }));
```

```
the field is there  [ 'o-1001', 'o-1003', 'o-1004', 'o-1006', 'o-1007' ]
the field is absent [ 'o-1002', 'o-1005', 'o-1008' ]
note is null        [ 'o-1002', 'o-1005', 'o-1007', 'o-1008' ]
note is text        [ 'o-1001', 'o-1003', 'o-1004', 'o-1006' ]
```

Compare the second and third lines carefully:

| The query | What it asks |
| --- | --- |
| `{ note: { $exists: true } }` | the field is present — **including `o-1007`, whose note is `null`** |
| `{ note: { $exists: false } }` | the field is not present at all |
| `{ note: null }` | the value is `null` **or the field is missing** — both |
| `{ note: { $type: "string" } }` | present, and text |

`{ field: null }` deliberately covers both cases, because "has no value" is what people mean
by it far more often than "holds the value null". When the difference does matter — an
optional field that was explicitly cleared versus one never set — `$exists` is the operator
that can tell them apart.

## Text, without a pattern

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("name contains Ada ", ids({ "customer.name": { $contains: "Ada" } }));
console.log("email starts ada  ", ids({ "customer.email": { $startsWith: "ada" } }));
console.log("id ends 1 or 8    ", ids({ id: { $endsWith: ["1", "8"] } }));
```

```
name contains Ada  [ 'o-1001', 'o-1008' ]
email starts ada   [ 'o-1001', 'o-1008' ]
id ends 1 or 8     [ 'o-1001', 'o-1008' ]
```

These four — `$contains`, `$startsWith`, `$endsWith` and `$word` — need no pattern and run in
linear time, which is why they stay available when `$regex` is turned off for queries arriving
from outside (lesson 12).

Each of them takes **one string or a list meaning *any of these***. `$endsWith: ["1", "8"]`
is one thought, not three ORed together.

### Ignoring case

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("exactly as typed", ids({ "customer.name": { $contains: "ada" } }));
console.log("ignoring case   ", ids({ "customer.name": { $contains: "ada", $options: "i" } }));
```

```
exactly as typed []
ignoring case    [ 'o-1001', 'o-1008' ]
```

`$options: "i"` applies to **every string comparison in that condition**, not only to a
pattern. Put it beside `$contains`, `$eq`, `$in` — anywhere a condition compares text — and
that whole condition stops caring about case.

### Why `$word` exists

`$contains` is the wrong tool for anything with separators in it, and the way it is wrong is
quiet:

```js
import { filter } from "@osqd/jql";

const hits = [{ actor: "203.0.113.4" }, { actor: "203.0.113.45" }, { actor: "10.203.0.113" }];
const seen = (query) => filter(hits, query).map((hit) => hit.actor);

console.log("$contains the address", seen({ actor: { $contains: "203.0.113.4" } }));
console.log("$word the address    ", seen({ actor: { $word: "203.0.113.4" } }));
console.log("$word a whole network", seen({ actor: { $word: "203.0.113." } }));
```

```
$contains the address [ '203.0.113.4', '203.0.113.45' ]
$word the address     [ '203.0.113.4' ]
$word a whole network [ '203.0.113.4', '203.0.113.45' ]
```

A block rule written with `$contains` for one address caught its neighbour as well.

`$word` matches the value as a **whole component**: bounded by the start or end of the text,
or by any character that is not a letter or a digit. So `203.0.113.4` stops finding
`203.0.113.45`. A value that itself ends in a separator has chosen its own boundary, which is
why `203.0.113.` still finds the whole network — on purpose.

## Patterns

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("glob, any ink   ", ids({ "lines.sku": { $glob: "ink-*" } }));
console.log("glob, one char  ", ids({ "lines.sku": { $glob: "pad-a?" } }));
console.log("a real regex    ", ids({ id: { $regex: "0{2}[13]$" } }));
```

```
glob, any ink    [ 'o-1001', 'o-1004', 'o-1008' ]
glob, one char   [ 'o-1002', 'o-1005', 'o-1006', 'o-1008' ]
a real regex     [ 'o-1001', 'o-1003' ]
```

`lines.sku` is a path through a *list* of order lines, and it matched an order when any
of its lines did. That is lesson 3's subject, and it is the one rule here worth meeting
slowly.

`$glob` is the pattern people usually mean: `*` for any run of characters, `?` for exactly
one, `\` to escape either. It has no engine behind it and cannot backtrack, so it is safe to
accept from a stranger. `$regex` is a full ECMAScript pattern and is the one operator you will
want to switch off at the edge of your system.

## Numbers and sizes

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("even totals    ", ids({ total: { $mod: [2, 0] } }));
console.log("a longish note ", ids({ note: { $length: { $gt: 18 } } }));
console.log("two order lines", ids({ lines: { $size: 2 } }));
```

```
even totals     [ 'o-1002', 'o-1004', 'o-1005', 'o-1007', 'o-1008' ]
a longish note  [ 'o-1001', 'o-1006' ]
two order lines [ 'o-1001', 'o-1004', 'o-1005', 'o-1006', 'o-1008' ]
```

`$mod` takes `[divisor, remainder]`. `$size` counts the elements of an array. `$length`
measures an array **or a string**, and takes a nested condition, so "longer than 18
characters" is `{ $length: { $gt: 18 } }` rather than a second query.

## The operators, in full

| | |
| --- | --- |
| `$eq` `$ne` | equal, and not equal to any reached value |
| `$gt` `$gte` `$lt` `$lte` | ordering, like with like only |
| `$in` `$nin` | membership of a list |
| `$exists` `$type` | presence, and what kind |
| `$contains` `$startsWith` `$endsWith` `$word` | text, without a pattern |
| `$glob` | `*`, `?`, `\` — a pattern with no engine behind it |
| `$regex` `$options` | an ECMAScript pattern, and its flags |
| `$mod` | `[divisor, remainder]` |
| `$size` `$length` | elements of an array; length of an array **or a string** |
| `$all` `$elemMatch` | lesson 3 |
| `$not` | lesson 4 |

## Exercise

Find the orders whose note mentions a gift — but not the ones merely *tagged* `gift` —
without caring about case.

<details>
<summary>Answer</summary>

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const found = filter(orders, { note: { $contains: "gift", $options: "i" } });

console.log(found.map((order) => `${order.id}: ${order.note}`));
```

```
[ 'o-1006: gift wrap, no receipt' ]
```

`o-1001` is tagged `gift`, but its note says "leave with the neighbour" — and a condition on
`note` only ever reads `note`.
</details>

## Related

- [Specification §5](../reference/specification.md#5-field-operators) — every operator, precisely
- [Queries from outside](../guides/untrusted-input.md) — why `$regex` is the one that gets turned off
