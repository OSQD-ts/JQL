# Lesson 5 — Dates and windows

**Goal:** write an instant in JSON, and a window that still means the same thing next week.

← [Course](index.md) · Previous: [Combining and negating](04-combining.md) · Next: [Typed queries](06-typed-queries.md)

---

## JSON has no date type

So JQL adds one wrapper:

```json
{ "placed": { "$gte": { "$date": "2026-09-14" } } }
```

`{ "$date": … }` is the query **saying** that this comparison is about time. Without it a
timestamp is a string, and is compared as one. The wrapper accepts four things:

| | |
| --- | --- |
| `{ "$date": "2026-09-14" }` | an ISO 8601 date or timestamp |
| `{ "$date": 1788254100000 }` | epoch milliseconds |
| `{ "$date": "now" }` | the moment the query is compiled |
| `{ "$date": { "$ago": "7d" } }` | that long before now — `$ahead` for the future |

## A fixed window

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const ids = (query) => filter(orders, query).map((order) => order.id);

console.log("on or after the 14th:", ids({ placed: { $gte: { $date: "2026-09-14" } } }));

console.log("the 7th to the 18th :", ids({
  placed: { $gte: { $date: "2026-09-07" }, $lt: { $date: "2026-09-18" } },
}));
```

```
on or after the 14th: [ 'o-1005', 'o-1006', 'o-1007', 'o-1008' ]
the 7th to the 18th : [ 'o-1003', 'o-1004', 'o-1005' ]
```

Two operators in one condition, exactly as in lesson 2 — a window is just a range that happens
to be made of instants.

## A window that moves with the clock

This is what `{ "$ago": … }` is for. A saved filter written this way means *"the last seven
days"*, not *"since the Tuesday somebody saved it"*:

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

// The clock is an argument, which is what makes this example reproducible.
const now = () => Date.parse("2026-09-25T12:00:00Z");
const ids = (query) => filter(orders, query, { now }).map((order) => order.id);

console.log("the last seven days:", ids({ placed: { $gte: { $date: { $ago: "7d" } } } }));
console.log("the last 36 hours  :", ids({ placed: { $gte: { $date: { $ago: "36h" } } } }));
console.log("anything before now:", ids({ placed: { $lt: { $date: "now" } } }).length, "of 8");
```

```
the last seven days: [ 'o-1006', 'o-1007', 'o-1008' ]
the last 36 hours  : [ 'o-1008' ]
anything before now: 8 of 8
```

## "Now" is an argument, not a clock

Notice `{ now }` in that example. The current time is an **option you pass**, never something
read from the environment behind your back. Two things fall out of that:

- a relative window is testable without waiting for time to pass, which is the only reason the
  output above can be printed in a document at all;
- a scheduled job can ask for "the last hour" as of the hour it was *scheduled* for, rather
  than the moment it happened to start.

### The window is fixed when the query compiles

```js
import { compile } from "@osqd/jql";
import { orders } from "./orders.mjs";

const now = () => Date.parse("2026-09-25T12:00:00Z");
const lastWeek = compile({ placed: { $gte: { $date: { $ago: "7d" } } } }, { now });

console.log("first pass :", orders.filter(lastWeek).map((order) => order.id));
console.log("second pass:", orders.filter(lastWeek).map((order) => order.id));
```

```
first pass : [ 'o-1006', 'o-1007', 'o-1008' ]
second pass: [ 'o-1006', 'o-1007', 'o-1008' ]
```

A relative date resolves **once**, when the query is compiled — not once per row. That matters
more than it sounds. Resolving per comparison would judge two rows a second apart against two
different windows, and a scan over a million rows takes long enough for that to happen. When
you want the window to move, compile again; it costs well under a microsecond.

## What counts as a date in a document

The wrapper says how the *query* means its value. The other half of the contract is how the
value in the **row** is read:

```js
import { filter } from "@osqd/jql";

const held = [
  { id: "iso-z", at: "2026-09-01T09:15:00Z" },
  { id: "iso-no-offset", at: "2026-09-01T09:15:00" },
  { id: "space", at: "2026-09-01 09:15:00" },
  { id: "epoch", at: 1788254100000 },
  { id: "date-object", at: new Date("2026-09-01T09:15:00Z") },
  { id: "not-a-date", at: "1 September 2026" },
];

const seen = filter(held, { at: { $eq: { $date: "2026-09-01T09:15:00Z" } } });

console.log(seen.map((row) => row.id));
```

```
[ 'iso-z', 'iso-no-offset', 'space', 'epoch', 'date-object' ]
```

Five of the six are the same instant. A `Date` object, epoch milliseconds, or an ISO 8601
string with either a `T` or a space all count. `"1 September 2026"` does not — even though
JavaScript's own parser would accept it happily.

That restriction is deliberate. Host date parsers accept things no standard requires
(`"12/31/2020"` is a date in one country and nonsense in another), and a document that matched
in one implementation and not in another would make the same query mean two things.

### A timestamp with no offset is UTC

`"2026-09-01T09:15:00"` means 09:15 **UTC**, not 09:15 wherever the process happens to be
running — which is why `iso-no-offset` and `space` are in that list.

JavaScript itself does not do this: it reads a date-only string as UTC and a timestamp without
an offset as local time. A query language cannot afford that, or the same filter over the same
data would give different answers in London and in Tokyo.

### Nothing is a date unless the query says so

```js
import { filter } from "@osqd/jql";

const held = [
  { id: "iso-z", at: "2026-09-01T09:15:00Z" },
  { id: "space", at: "2026-09-01 09:15:00" },
  { id: "epoch", at: 1788254100000 },
];

console.log("with $date   :", filter(held, { at: { $eq: { $date: "2026-09-01T09:15:00Z" } } }).map((r) => r.id));
console.log("without $date:", filter(held, { at: "2026-09-01T09:15:00Z" }).map((r) => r.id));
```

```
with $date   : [ 'iso-z', 'space', 'epoch' ]
without $date: [ 'iso-z' ]
```

Without the wrapper it is a string comparison, and only the row holding that exact string
matches. No value is ever read as a date unless the query asked for it.

## Durations

`$ago` and `$ahead` take `ms`, `s`, `m`, `h`, `d` and `w`, in any order and as many as you
like: `"90s"`, `"1h30m"`, `"7d"`, `"2w3d"`.

Months and years are deliberately missing. Neither has a fixed length, and a window that
changed size with the calendar is one nobody can reason about. Write `"30d"` and mean it.

## Exercise

Write the query behind a "paid this month" figure on the Harbour dashboard, for September
2026. Fixed dates, not relative ones — a monthly total should not move.

<details>
<summary>Answer</summary>

```js
import { filter } from "@osqd/jql";
import { orders } from "./orders.mjs";

const paidInSeptember = filter(orders, {
  status: "paid",
  placed: { $gte: { $date: "2026-09-01" }, $lt: { $date: "2026-10-01" } },
});

console.log(paidInSeptember.map((order) => order.id));
console.log("total:", paidInSeptember.reduce((sum, order) => sum + order.paid, 0));
```

```
[ 'o-1001', 'o-1003', 'o-1006', 'o-1008' ]
total: 72
```

Half-open — `$gte` the first of the month, `$lt` the first of the next — is the range to reach
for by default. It has no gap and no overlap with the neighbouring month, whatever the
precision of the timestamps involved.
</details>

## Related

- [Specification §7](../reference/specification.md#7-dates) — the date rules in full
