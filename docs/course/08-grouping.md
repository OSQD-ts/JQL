# Lesson 8 — Counting by a field

**Goal:** the number above the table, without writing the tally loop again.

← [Course](index.md) · Previous: [Requests](07-requests.md) · Next: [Why did this not match?](09-explaining.md)

---

## Everybody writes this loop

Orders per status, requests per verdict, errors per service. It is five lines of `Map` and a
`sort`, which is why every screen writes its own — and why no two of them agree. Three
questions decide the answer, and each project answers them differently by accident:

- what does an item with **two** values count as?
- where do the items with **no** value go?
- what order do the groups come back in?

`group` answers all three, the same way every time.

## The simplest tally

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

for (const held of group(orders, "status")) console.log(held.count, held.key);
```

```
4 paid
2 open
1 cancelled
1 refunded
```

Each group is `{ key, count }`, biggest first. The second argument is a **path**, so anything
lessons 1 to 3 taught you to reach is something you can count by:

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

for (const held of group(orders, "customer.country")) console.log(held.count, held.key);
```

```
3 GB
3 US
1 DE
1 FR
```

## Counting only some of the rows

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

const big = group(orders, "status", { where: { total: { $gte: 30 } } });

console.log(big.map((held) => `${held.key}=${held.count}`));
```

```
[ 'open=2', 'cancelled=1', 'paid=1', 'refunded=1' ]
```

`where` takes an ordinary query. Put the filter **here**, not around the result: grouping
everything and then presenting it beside a filtered table is a wrong number with nothing on
the screen to say so.

## Grouping by something that holds several values

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

console.log("by tag:");
for (const held of group(orders, "tags")) console.log("  ", held.count, JSON.stringify(held.key));

console.log("by sku:");
for (const held of group(orders, "lines.sku")) console.log("  ", held.count, held.key);
```

```
by tag:
   3 "repeat"
   2 null
   2 "fragile"
   1 "damaged"
   1 "gift"
by sku:
   4 pad-a5
   3 pen-fine
   2 desk-lamp
   2 ink-blue
   2 ink-red
```

Two things are happening here, and both are answers to the questions at the top.

**An item counts once in each group it belongs to.** `o-1004` is tagged
`["damaged", "repeat"]` and appears under both. A value repeated *within* one item still
counts once, because the question is "how many orders involved this sku", not "how many
lines".

So **the counts do not add up to the number of rows**, and should not: the sku tally comes to
thirteen over eight orders. If you want the counts to add up, group by something each row has
exactly one of.

**Everything that cannot name a group shares `null`.** That is the `null` in the tag list: the
two orders with no tags at all. A missing field, a `null`, a value that is an object, and an
empty list all land there.

That is the "unlabelled" heading on a chart, and it is deliberately a real answer rather than
a row that quietly vanished. A count that silently omits rows is worse than no count, because
it still looks like a count.

## Order and size

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

const line = (groups) => groups.map((held) => `${held.key}=${held.count}`).join("  ");

console.log("biggest first (default):", line(group(orders, "status")));
console.log("alphabetically by key  :", line(group(orders, "status", { sort: "key" })));
console.log("the top two            :", line(group(orders, "status", { limit: 2 })));
```

```
biggest first (default): paid=4  open=2  cancelled=1  refunded=1
alphabetically by key  : cancelled=1  open=2  paid=4  refunded=1
the top two            : paid=4  open=2
```

Ties break by the key, so the same data always comes back in the same order and a chart does
not reshuffle itself between two refreshes that found nothing new.

## Keeping the rows behind each group

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

for (const held of group(orders, "channel", { items: 2 })) {
  console.log(String(held.key).padEnd(6), held.count, "→", held.items.map((order) => order.id).join(" "));
}
```

```
web    4 → o-1001 o-1002
app    2 → o-1005 o-1006
phone  2 → o-1003 o-1008
```

`items: true` keeps every row; `items: 2` keeps the first two. This is what turns a chart into
a chart you can click — and the cap is why a group of ten thousand rows does not arrive whole
in a dashboard payload.

## The options

| | |
| --- | --- |
| `where` | which items to count |
| `sort` | `"count"` (the default) or `"key"` |
| `limit` | how many groups, largest first |
| `items` | `true` to keep every item, or a number to keep the first few |

## Exercise

Harbour wants "money outstanding, by country" — only orders that still owe, largest first.
`group` counts rows rather than summing a field, so this one needs a little thought.

<details>
<summary>Answer</summary>

`group` deliberately counts rather than sums. A general aggregation language is a much bigger
thing than a query language, and this one stops at the edge on purpose. Keep the rows and sum
them yourself:

```js
import { group } from "@osqd/jql";
import { orders } from "./orders.mjs";

const owing = group(orders, "customer.country", {
  where: { paid: 0, status: "open" },
  items: true,
});

for (const held of owing) {
  const total = held.items.reduce((sum, order) => sum + order.total, 0);
  console.log(held.key, held.count, "order(s),", total, "outstanding");
}
```

```
GB 1 order(s), 170 outstanding
US 1 order(s), 30 outstanding
```

If you find yourself really wanting a `$sum` here, that is the signal that the *store* should
be answering this question rather than your process — which is lesson 15.
</details>

## Related

- [Library API](../reference/api.md) — `group` and its options
