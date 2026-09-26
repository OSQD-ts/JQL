# The JQL course

Sixteen lessons that build one real integration, from a first query to a filter you can put
behind a public endpoint.

← [Documentation](../index.md)

---

## What this is

The [reference documentation](../index.md) answers *"how does X work?"*. This answers *"what
do I do, and in what order?"* — every capability of the library, taught in the order that
makes each one make sense, with something to run at every step.

It is written to be worked through rather than read. Every lesson is a handful of short,
self-contained programs, each followed by what it prints — and **every one of those outputs
was produced by running the code**, not by imagining what it would print. A script in this
repository runs all of them on the packed package before a release, so a page that drifts
from the library fails the build.

**Time:** about three hours to do properly. Lessons 1–5 are the language itself and are worth
slowing down for; everything after them assumes you have those.

## Who it is for

A TypeScript or JavaScript developer with a collection of things and a filter to write — rows
in a dashboard, records behind an API, lines in a log. You need no background in query
languages: the operator names are the conventional ones, so if you have written a filter in
almost any document store you will recognise most of them, and
[the specification](../reference/specification.md) says precisely what each one means here.

## The running example

You are building **Harbour**, the order desk of a small shop. It has an order book worth
searching, a support console worth giving a search box, and an API worth not letting strangers
run arbitrary queries against. Every lesson adds one thing to Harbour, and by lesson 16 you
have a complete, tested, production-shaped setup.

## Set up once

```bash
mkdir harbour && cd harbour
npm init -y && npm pkg set type=module
npm install @osqd/jql
```

Then save the order book as `harbour/orders.mjs`. Every lesson imports it, and it is small
enough that you can check any answer by hand:

```js
/** The Harbour order book: eight orders, small enough to check an answer by hand. */
export const orders = [
  {
    id: "o-1001", placed: "2026-09-01T09:15:00Z", status: "paid", channel: "web",
    customer: { name: "Ada Lovelace", country: "GB", email: "ada@example.com" },
    lines: [{ sku: "pen-fine", title: "Fine liner", quantity: 3, price: 4.5 }, { sku: "ink-blue", title: "Blue ink", quantity: 1, price: 9 }],
    total: 22.5, paid: 22.5, tags: ["gift"], note: "leave with the neighbour",
  },
  {
    id: "o-1002", placed: "2026-09-03T14:02:00Z", status: "open", channel: "web",
    customer: { name: "Grace Hopper", country: "US", email: "grace@example.com" },
    lines: [{ sku: "pad-a5", title: "A5 pad", quantity: 10, price: 3 }],
    total: 30, paid: 0, tags: [],
  },
  {
    id: "o-1003", placed: "2026-09-07T08:40:00Z", status: "paid", channel: "phone",
    customer: { name: "Alan Turing", country: "GB", email: "alan@example.com" },
    lines: [{ sku: "pen-fine", title: "Fine liner", quantity: 1, price: 4.5 }],
    total: 4.5, paid: 4.5, tags: ["repeat"], note: "same as last time",
  },
  {
    id: "o-1004", placed: "2026-09-11T19:30:00Z", status: "refunded", channel: "web",
    customer: { name: "Katherine Johnson", country: "US", email: "kj@example.com" },
    lines: [{ sku: "ink-blue", title: "Blue ink", quantity: 2, price: 9 }, { sku: "ink-red", title: "Red ink", quantity: 2, price: 9 }],
    total: 36, paid: 0, tags: ["damaged", "repeat"], note: "arrived leaking",
  },
  {
    id: "o-1005", placed: "2026-09-14T11:05:00Z", status: "open", channel: "app",
    customer: { name: "Tim Berners-Lee", country: "GB", email: "tim@example.com" },
    lines: [{ sku: "desk-lamp", title: "Desk lamp", quantity: 1, price: 140 }, { sku: "pad-a5", title: "A5 pad", quantity: 10, price: 3 }],
    total: 170, paid: 0, tags: ["fragile"],
  },
  {
    id: "o-1006", placed: "2026-09-18T16:45:00Z", status: "paid", channel: "app",
    customer: { name: "Barbara Liskov", country: "US", email: "barbara@example.com" },
    lines: [{ sku: "pad-a5", title: "A5 pad", quantity: 2, price: 3 }, { sku: "pen-fine", title: "Fine liner", quantity: 6, price: 4.5 }],
    total: 33, paid: 33, tags: [], note: "gift wrap, no receipt",
  },
  {
    id: "o-1007", placed: "2026-09-21T07:20:00Z", status: "cancelled", channel: "web",
    customer: { name: "Margaret Hamilton", country: "DE", email: "margaret@example.com" },
    lines: [{ sku: "desk-lamp", title: "Desk lamp", quantity: 2, price: 140 }],
    total: 280, paid: 0, tags: ["fragile"], note: null,
  },
  {
    id: "o-1008", placed: "2026-09-24T13:10:00Z", status: "paid", channel: "phone",
    customer: { name: "Ada Byron", country: "FR", email: "ada.b@example.com" },
    lines: [{ sku: "ink-red", title: "Red ink", quantity: 1, price: 9 }, { sku: "pad-a5", title: "A5 pad", quantity: 1, price: 3 }],
    total: 12, paid: 12, tags: ["repeat"],
  },
];
```

Look at it for a moment before you start. Three orders have no `note` at all, one has a `note`
of `null`, two have no tags, and one has two lines that are nothing like each other. Every one
of those is there to catch a lesson out.

Each example is a whole program: put it in a file next to `orders.mjs` and run it with
`node`. A few lessons introduce a second module — a vocabulary, a store description — and say
so where they do. Lesson 6 is the one that wants TypeScript; nothing here needs a server or a
database at all.

---

## Part 1 — The language

| | | |
|-|-|-|
| 1 | [Your first query](01-first-query.md) | A query is data. Four helpers, and a refusal. |
| 2 | [Asking precisely](02-operators.md) | Comparison, membership, existence, strings, patterns. |
| 3 | [Arrays and paths](03-arrays-and-paths.md) | How a path meets an array. **The most important lesson here.** |
| 4 | [Combining and negating](04-combining.md) | `$or`, `$nor`, `$not` — and what "not" means over a list. |
| 5 | [Dates and windows](05-dates.md) | An instant in JSON, and a window that stays true tomorrow. |

## Part 2 — Letting the compiler help

| | | |
|-|-|-|
| 6 | [Typed queries](06-typed-queries.md) | A typo in a field name as a compile error rather than an empty result. |

## Part 3 — Whole questions about a collection

| | | |
|-|-|-|
| 7 | [Requests](07-requests.md) | Order, pages, and which fields you hand back. |
| 8 | [Counting by a field](08-grouping.md) | The number above the table. |
| 9 | [Why did this not match?](09-explaining.md) | The clause that decided it, with the values it read. |

## Part 4 — People typing

| | | |
|-|-|-|
| 10 | [A vocabulary](10-vocabulary.md) | The names your data has, in one place, for both front ends. |
| 11 | [The search box](11-the-search-box.md) | Text into JQL, JQL back into text, and completions. |

## Part 5 — Production

| | | |
|-|-|-|
| 12 | [Queries from outside](12-untrusted.md) | Accepting one from a URL without accepting everything. |
| 13 | [Saved filters](13-saved-filters.md) | One shape and one short name per question. |
| 14 | [Logs and streams](14-streams-and-cli.md) | The async helpers, and the `jql` command. |
| 15 | [Pushing into a store](15-pushdown.md) | Letting a backend answer the part it can. |
| 16 | [Extending it, and proving it](16-extending.md) | Operators of your own, the conformance suite, and a finished Harbour. |

---

## How to get the most out of it

**Type the code, do not paste it.** The examples are short on purpose.

**Predict the answer before you run it.** Eight orders is few enough to work out in your head,
and the times you are wrong are the times you learn where this language differs from the one
in your head.

**When something surprises you, chase it.** Every lesson ends with links into the reference
documentation and the specification for the thing you just used.

## One sentence to keep

> **A query that is not understood is refused, never run as something that looks like it
> worked.**

You will meet it in lesson 1, thirty seconds in, when a misspelt operator throws instead of
quietly matching nothing. Every other refusal in this course is that same rule: the failure
this language exists to prevent is a filter that looks applied and is not.

Start with [lesson 1](01-first-query.md).

## Related

- [Quick start](../start/quick-start.md) — if you want five minutes rather than three hours
- [The specification](../reference/specification.md) — what every operator means, precisely
- [Library API](../reference/api.md) — every export, grouped by what it is for
