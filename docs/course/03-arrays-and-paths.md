# Lesson 3 — Arrays and paths

**Goal:** know exactly what happens when a path meets an array. This is the lesson that stops
you writing a filter that looks right and is not.

← [Course](index.md) · Previous: [Asking precisely](02-operators.md) · Next: [Combining and negating](04-combining.md)

---

## The rule

A path like `customer.country` is resolved one segment at a time. On an object, take the
field. On an array, one of two things happens:

- the segment is a **number** — take that position, so `lines.0.sku` is the first line's sku;
- the segment is anything else — apply it to **every element**. The array is *seen through*.

Because of the second case a path can reach **several values at once**, and then:

> **A condition holds when it holds for any one of the values the path reached.**

That one sentence explains almost every surprise in this language. The rest of this lesson is
four small programs showing what it does.

## A value matches any element

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const repeat = filter(orders, { tags: "repeat" });

console.log(repeat.map((order) => `${order.id} ${JSON.stringify(order.tags)}`));
```

```
[
  'o-1003 ["repeat"]',
  'o-1004 ["damaged","repeat"]',
  'o-1008 ["repeat"]'
]
```

`tags` is a list, and `"repeat"` is not a list — so the condition is tried against each tag in
turn, and one match is enough. You do not write anything special to search inside a list.

## A path can go through one

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("any line is a fine liner  ", ids({ "lines.sku": "pen-fine" }));
console.log("the FIRST line is one     ", ids({ "lines.0.sku": "pen-fine" }));
```

```
any line is a fine liner   [ 'o-1001', 'o-1003', 'o-1006' ]
the FIRST line is one      [ 'o-1001', 'o-1003' ]
```

`lines.sku` reaches the sku of *every* line. `lines.0.sku` reaches exactly one value, because
`0` is a position rather than a field name. `o-1006` has a fine liner as its second line, so
it answers the first question and not the second.

## The trap

Here is the mistake this lesson exists for. Read this query aloud:

```json
{ "lines.quantity": { "$gt": 5 }, "lines.price": { "$gt": 100 } }
```

Most people say *"a line of more than five, at over a hundred pounds"*. Now run it:

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const found = filter(orders, { "lines.quantity": { $gt: 5 }, "lines.price": { $gt: 100 } });

for (const order of found) {
  console.log(order.id);
  for (const line of order.lines) console.log("   ", line.quantity, "x", line.title, "@", line.price);
}
```

```
o-1005
    1 x Desk lamp @ 140
    10 x A5 pad @ 3
```

There is no expensive bulk line in that order at all. The query says **"some line has
quantity over five, *and* some line costs over a hundred"** — and `o-1005` satisfies it with
two *different* lines.

Each condition is resolved on its own, and each is happy as soon as any one element satisfies
it. Nothing ties them to the same element unless you say so.

## `$elemMatch` says "the same element"

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("big AND expensive, same line:", ids({
  lines: { $elemMatch: { quantity: { $gt: 5 }, price: { $gt: 100 } } },
}));

console.log("at least 2, at least £9     :", ids({
  lines: { $elemMatch: { quantity: { $gte: 2 }, price: { $gte: 9 } } },
}));
```

```
big AND expensive, same line: []
at least 2, at least £9     : [ 'o-1004', 'o-1007' ]
```

The first is empty, which is the true answer: nobody has bought more than five of anything
costing over a hundred pounds. The second shows `$elemMatch` finding real matches, so you can
see it is not simply stricter about everything.

Both readings are legitimate — "this order has a big line *and* an expensive line" is a real
question someone might ask. The danger is that the loose one is what you get by default, and
in small test data the two usually agree.

**Rule of thumb:** the moment a query puts two conditions on the *same array*, stop and decide
whether they must hold of the same element. If they must, it is `$elemMatch`.

## `$all` — several values, any elements

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("repeat            ", ids({ tags: "repeat" }));
console.log("repeat AND damaged", ids({ tags: { $all: ["repeat", "damaged"] } }));
```

```
repeat             [ 'o-1003', 'o-1004', 'o-1008' ]
repeat AND damaged [ 'o-1004' ]
```

`$all` is the other half of the pair: *every one of these values is somewhere in the list*,
each possibly in a different element. Use `$all` for a set of tags, `$elemMatch` for several
facts about one object.

## Counting: `$size` and `$length`

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("exactly two lines", ids({ lines: { $size: 2 } }));
console.log("no tags at all   ", ids({ tags: { $size: 0 } }));
console.log("exactly two tags ", ids({ tags: { $length: 2 } }));
```

```
exactly two lines [ 'o-1001', 'o-1004', 'o-1005', 'o-1006', 'o-1008' ]
no tags at all    [ 'o-1002', 'o-1006' ]
exactly two tags  [ 'o-1004' ]
```

`$size` counts elements. `$length` measures an array **or a string** — its elements, or its
UTF-16 code units — and accepts a nested condition, so `{ $length: { $gt: 18 } }` is a valid
question about a note.

Unlike the string operators, neither of these is tried against the elements. If `$length` were
seen through the array, `{ tags: { $length: 1 } }` would mean both "one tag" and "a tag one
character long" at once, with nothing in the query to say which.

## The same rule, all the way down

The "seen through" rule applies at *every* segment, including before the first one — an item
that is itself an array is seen through too:

```js
import { filter } from "@osqd/jql";

const nested = [[{ sku: "pen-fine" }], [{ sku: "ink-red" }]];

console.log("item is a list of objects:", filter(nested, { sku: "pen-fine" }).length);
console.log("items are bare numbers   :", filter([3, 8, 1, 12], { $gt: 5 }));
```

```
item is a list of objects: 1
items are bare numbers   : [ 8, 12 ]
```

The second line is worth a moment. `{ $gt: 5 }` has no field name in it at all — a field
operator at the top of a query is a condition on **the item itself**. That is how you query a
list of numbers, or of strings, where there is no field to name.

## Exercise

Find the orders containing a line of **ten or more A5 pads**. Then try the same question
without `$elemMatch`, and work out why it is not a safe way to write it.

<details>
<summary>Answer</summary>

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("with $elemMatch   :", ids({ lines: { $elemMatch: { sku: "pad-a5", quantity: { $gte: 10 } } } }));
console.log("without $elemMatch:", ids({ "lines.sku": "pad-a5", "lines.quantity": { $gte: 10 } }));
```

```
with $elemMatch   : [ 'o-1002', 'o-1005' ]
without $elemMatch: [ 'o-1002', 'o-1005' ]
```

The two agree — on *this* data, because in both orders it really is the pad line that is
large. That is exactly why the loose version survives testing: it needs a row where the two
conditions land on different elements before it goes wrong, and your fixtures probably do not
have one.
</details>

## Related

- [Specification §3](../reference/specification.md#3-paths) — path resolution, formally
- [Specification §4.1](../reference/specification.md#41-how-a-condition-meets-an-array) — the "any of them" rule
