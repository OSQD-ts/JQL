# Lesson 4 — Combining and negating

**Goal:** `$or`, `$nor` and `$not` — and what negation means when a path reaches more than one
value.

← [Course](index.md) · Previous: [Arrays and paths](03-arrays-and-paths.md) · Next: [Dates and windows](05-dates.md)

---

## Four operators that take whole queries

Two keys side by side already mean *and*. For everything else there are four operators whose
arguments are themselves queries:

| | |
| --- | --- |
| `$and: [ … ]` | every one of them holds |
| `$or: [ … ]` | at least one holds |
| `$nor: [ … ]` | none of them holds |
| `$not: { … }` | this one does not hold |

They nest freely, and `$not` may sit at the very top of a query, which makes "everything
except this saved filter" a one-character change.

The first half of this lesson is mechanical. The second half — negation over a list, and
negation of a field nobody filled in — is where the surprises are.

## `$or` and `$and`

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("cancelled OR over £150:", ids({
  $or: [{ status: "cancelled" }, { total: { $gt: 150 } }],
}));

console.log("paid AND under £20    :", ids({
  $and: [{ status: "paid" }, { total: { $lt: 20 } }],
}));
```

```
cancelled OR over £150: [ 'o-1005', 'o-1007' ]
paid AND under £20    : [ 'o-1003', 'o-1008' ]
```

That `$and` could have been written `{ status: "paid", total: { $lt: 20 } }`. You need the
spelled-out form only when two branches would collide on the same key — two different
conditions on `total`, say, or a list of filters you built in a loop and cannot merge into one
object.

## `$nor` and `$not`

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("neither paid nor open :", ids({ $nor: [{ status: "paid" }, { status: "open" }] }));
console.log("not a British customer:", ids({ $not: { "customer.country": "GB" } }));
console.log("$not on a field       :", ids({ status: { $not: { $in: ["paid", "open"] } } }));
```

```
neither paid nor open : [ 'o-1004', 'o-1007' ]
not a British customer: [ 'o-1002', 'o-1004', 'o-1006', 'o-1007', 'o-1008' ]
$not on a field       : [ 'o-1004', 'o-1007' ]
```

`$nor` is "none of these". `$not` comes in two positions: wrapped around a **whole query**, as
on the second line, and inside a **field's condition**, as on the third.

The first and third lines returned the same two orders, and that is not a coincidence — they
are the same question written two ways. Reach for whichever reads better where it is written:
`$nor` when the alternatives are whole queries, `$not` on the field when they are all about
one field.

## Negation is about *all* the values, not one of them

Now the lesson. `o-1004` is tagged `["damaged", "repeat"]`. Watch where it appears:

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("has the tag repeat    :", ids({ tags: "repeat" }));
console.log("$ne repeat            :", ids({ tags: { $ne: "repeat" } }));
console.log("an element that is not:", ids({ tags: { $elemMatch: { $ne: "repeat" } } }));
```

```
has the tag repeat    : [ 'o-1003', 'o-1004', 'o-1008' ]
$ne repeat            : [ 'o-1001', 'o-1002', 'o-1005', 'o-1006', 'o-1007' ]
an element that is not: [ 'o-1001', 'o-1004', 'o-1005', 'o-1007' ]
```

`o-1004` is in the **first and third** lists at once. That is not a contradiction:

- `$ne` holds when **no** value the path reached equals `"repeat"`. `o-1004` has one that
  does, so it fails.
- `$elemMatch` holds when **some** element satisfies the condition inside. `o-1004` has the
  tag `"damaged"`, which is not `"repeat"`, so it passes.

Both are true of the same order. "Not tagged repeat" and "has a tag other than repeat" are
different questions, and a list is exactly where they come apart.

Every negating operator works this way. `$ne`, `$nin`, `$exists: false` and `$not` all hold
when their positive counterpart holds for **none** of the reached values.

## Negation and a field that is not there

The same rule has a second consequence, and it catches people more often than the array one:

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("note is not 'x'      :", ids({ note: { $ne: "x" } }).length, "of 8");
console.log("has a note, not 'x'  :", ids({ note: { $exists: true, $ne: "x" } }).length, "of 8");
```

```
note is not 'x'      : 8 of 8
has a note, not 'x'  : 5 of 8
```

A path that reaches nothing has no value equal to `"x"` — so `$ne` is satisfied, and the three
orders with no `note` at all come back. This is consistent, but it is rarely what someone
means by "everything except x".

If you mean "has a note, and it is not x", say both things:

```json
{ "note": { "$exists": true, "$ne": "x" } }
```

## Empty lists

```js
import { count } from "@osqd/jql";
import { orders } from "./orders.mjs";

console.log("$and: [] matches", count(orders, { $and: [] }), "of 8");
console.log("$or:  [] matches", count(orders, { $or: [] }), "of 8");
```

```
$and: [] matches 8 of 8
$or:  [] matches 0 of 8
```

An empty `$and` matches everything and an empty `$or` matches nothing. That looks asymmetric
until you build the list in a loop: "no filters were selected" should narrow nothing, and "no
alternatives were offered" should accept nothing. Refusing the empty list instead would turn a
perfectly ordinary state of the user interface into an error every caller has to special-case.

## `$comment`

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const found = filter(orders, { status: "paid", $comment: "the weekly reconciliation" });

console.log(found.map((order) => order.id));
```

```
[ 'o-1001', 'o-1003', 'o-1006', 'o-1008' ]
```

`$comment` decides nothing. It is there because a stored filter gets read by a person months
later, and a sentence of intent beside it is worth more than a commit message they will not
find. It is also dropped from the canonical form (lesson 13), so it never makes one filter
look like two.

## Exercise

The support console wants a "needs attention" filter: orders with **no tags at all**, or **no
note**. One query.

<details>
<summary>Answer</summary>

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("with $size:", ids({ $or: [{ tags: { $size: 0 } }, { note: { $exists: false } }] }));
console.log("with []   :", ids({ $or: [{ tags: [] }, { note: { $exists: false } }] }));
```

```
with $size: [ 'o-1002', 'o-1005', 'o-1006', 'o-1008' ]
with []   : [ 'o-1002', 'o-1005', 'o-1006', 'o-1008' ]
```

The two agree, and it is worth knowing why they are not the same question.

Equality is tried against **the whole array first**, and then against each element. So
`{ tags: [] }` asks "is this array exactly the empty array?", while `{ tags: { $size: 0 } }`
asks "how many elements are in it?". At zero they coincide. One step further and they part
company: `{ tags: ["gift"] }` matches an order whose tags are exactly `["gift"]`, whereas
`{ tags: { $size: 1 } }` matches an order with one tag whatever it is — so an order tagged
`["fragile"]` satisfies the second and not the first.
</details>

## Related

- [Specification §6.1](../reference/specification.md#61-combining-queries) — the combinators
- [Specification §5.8](../reference/specification.md#58-not-on-a-field) — `$not` on a field
