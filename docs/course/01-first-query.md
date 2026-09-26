# Lesson 1 — Your first query

**Goal:** ask a collection a question with a JSON document, and see what happens when the
document is wrong.

← [Course](index.md) · Next: [Asking precisely](02-operators.md)

---

## A query is data

Most filters are code. You write a function, it takes a row, it returns true or false. That
works right up to the moment you want to *do* something with the filter itself — store it,
put it in a URL, send it to another service, show it to somebody, check it before running it.
A function can only be called.

A JQL query is **a JSON document**:

```json
{ "status": "open" }
```

That is a whole query. It says: the field `status` equals the string `"open"`. It is also a
value you could have read from a file or taken out of a request body — and everything else in
this course follows from that one decision.

> Every example below is a complete program. Put it in a file next to `orders.mjs` and run it
> with `node`.

## Asking the question

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const open = filter(orders, { status: "open" });

for (const order of open) console.log(order.id, order.customer.name);
```

```
o-1002 Grace Hopper
o-1005 Tim Berners-Lee
```

`filter` takes the collection and the query, and gives back every order that matches. There is
no callback anywhere — the shape of the question is entirely in that little object.

## The query really is just data

Watch it survive a round trip through text, which is what happens when a filter is saved in a
database or arrives in a request:

```js
import { count } from "@osqd/jql";
import { orders } from "./orders.mjs";

const query = { status: "open" };
const sent = JSON.stringify(query);
const arrived = JSON.parse(sent);

console.log("sent over the wire:", sent);
console.log("open orders, here :", count(orders, query));
console.log("open orders, there:", count(orders, arrived));
```

```
sent over the wire: {"status":"open"}
open orders, here : 2
open orders, there: 2
```

Nothing was lost, because there was nothing to lose. This is the property the rest of the
library is built on: a saved filter, a URL parameter and a line of code are the same thing.

## Two keys mean "and"

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const britishAndPaid = filter(orders, {
  status: "paid",
  "customer.country": "GB",
});

console.log(britishAndPaid.map((order) => order.id));
```

```
[ 'o-1001', 'o-1003' ]
```

Two things to notice.

**Both keys have to hold.** Listing them side by side means *and*. There is an explicit `$and`
for the times you need it, and lesson 4 covers when that is.

**`customer.country` is a path.** A dot reaches inside a nested object, so you can ask about
`customer.country` without pulling the customer out first. Lesson 3 is about what a path does
when it meets a *list*, which is the part worth slowing down for.

## Four ways to ask

`filter` is one of a family. They all take the same query and differ only in what they hand
back:

```js
import { count, find, filter, some } from "@osqd/jql";
import { orders } from "./orders.mjs";

const unpaid = { paid: 0 };

console.log("the first one   :", find(orders, unpaid)?.id);
console.log("all of them     :", filter(orders, unpaid).map((order) => order.id));
console.log("how many        :", count(orders, unpaid));
console.log("are there any   :", some(orders, unpaid));
```

```
the first one   : o-1002
all of them     : [ 'o-1002', 'o-1004', 'o-1005', 'o-1007' ]
how many        : 4
are there any   : true
```

| | |
| --- | --- |
| `find` | the first match, or `undefined`. Stops looking at it |
| `filter` | every match, as a new array |
| `count` | how many, without building the list |
| `some` / `every` | whether any / all match. Both stop early |

There are more — `findIndex`, `partition`, `filterMap`, `filterRecord`, `findEntry` — and they
work over arrays, `Set`s, `Map`s, iterables and plain objects. The query never changes; only
the question about the collection does.

## Compiling, when you ask the same thing often

Every helper turns the query into a predicate before it starts. If you are asking the same
question many times, do that once yourself:

```js
import { compile } from "@osqd/jql";
import { orders } from "./orders.mjs";

const isPaid = compile({ status: "paid" });

console.log("the predicate is just a function:", typeof isPaid);
console.log("so anything that takes one works:", orders.filter(isPaid).length);
console.log("and it answers one item too     :", isPaid(orders[0]));
```

```
the predicate is just a function: function
so anything that takes one works: 4
and it answers one item too     : true
```

`compile` is not something you need before you need it — a small query costs about as much to
compile as testing a handful of rows. It is for a hot loop, or for handing the predicate to
something that expects one.

## A wrong query is refused

This is the one behaviour to take away from lesson 1:

```js
import { filter, JqlError } from "@osqd/jql";
import { orders } from "./orders.mjs";

try {
  filter(orders, { total: { $gtt: 100 } });
} catch (error) {
  console.log("refused:", error instanceof JqlError);
  console.log(error.message);
}
```

```
refused: true
at total.$gtt: "$gtt" is not an operator; did you mean "$gt"?
```

`$gtt` is a typo. The query is **refused** — it does not quietly match nothing.

That matters more than it looks. A filter that silently matches nothing still returns a
result, the page still renders, and the number on it is wrong in a way no test notices.
Everything in this language that seems strict is protecting you from that one outcome, and
the error always says *where* in the query the problem is.

## Exercise

Find the orders placed through the app that nobody has paid for. Two keys, no operators.

<details>
<summary>Answer</summary>

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

console.log(filter(orders, { channel: "app", paid: 0 }).map((order) => order.id));
```

```
[ 'o-1005' ]
```

`o-1006` is on the app too, but it has been paid, so `paid: 0` leaves it out.
</details>

## Related

- [Quick start](../start/quick-start.md) — the same ground in five minutes
- [Library API](../reference/api.md) — every helper, and what each takes
- [Specification §2](../reference/specification.md#2-queries) — what a query document is
