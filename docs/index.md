# Documentation

Everything about JQL, one page per question.

← [README](../README.md)

---

## What JQL is

JQL is a query language whose queries are **JSON documents**:

```json
{ "status": "open", "customer.country": "GB", "total": { "$gte": 100 } }
```

That single decision is the whole idea. A filter that is *data* rather than code can be saved
in a database, put in a URL, sent to another service, shown to a person, checked before it is
run, and split so that a store answers the half it is able to. A function can only be called.

`@osqd/jql` is the engine that runs them: zero dependencies, ESM and CommonJS, Node 20 or
newer.

## What it does

| | |
| --- | --- |
| **Filters a collection** | arrays, `Set`s, `Map`s, iterables, async streams, plain objects |
| **Answers a whole request** | filter, sort, page and choose fields, in one document |
| **Reads a search box** | what people type compiles into the same JQL, and back out again |
| **Accepts queries from strangers** | caps on cost, an operator allowlist, and a field allowlist |
| **Pushes into a store** | splits a query so a database answers the part it can |
| **Explains itself** | which clause decided a row, and the values it read |
| **Refuses what it does not understand** | a misspelt operator throws, rather than quietly matching nothing |

That last row is the rule the rest is built on: **a query that is not understood is refused,
never run as something that looks like it worked.**

## Quick start

```sh
npm install @osqd/jql
```

```js
import { filter, search } from "@osqd/jql";

const orders = [
  { id: "o-1", status: "open", total: 170, tags: ["fragile"], customer: { country: "GB" } },
  { id: "o-2", status: "paid", total: 22.5, tags: ["gift"], customer: { country: "GB" } },
  { id: "o-3", status: "open", total: 30, tags: [], customer: { country: "US" } },
];

// Two keys mean "and", and a dot reaches inside a nested object.
filter(orders, { status: "open", "customer.country": "GB" });   // [o-1]

// A value matches any element of an array; operators go where a value would.
filter(orders, { tags: "gift", total: { $lt: 100 } });          // [o-2]

// Filter, sort, page and pick fields — one document, one call.
search(orders, { where: { status: "open" }, sort: { total: -1 }, fields: ["id", "total"] });
// [ { id: "o-1", total: 170 }, { id: "o-3", total: 30 } ]

// And a query that is wrong says so.
filter(orders, { total: { $gtt: 100 } });
// JqlError: at total.$gtt: "$gtt" is not an operator; did you mean "$gt"?
```

Where to go from here:

- **Another five minutes** — [Quick start](start/quick-start.md): the array methods,
  `compile`, the search box, and queries from outside.
- **About three hours** — [the course](course/index.md): sixteen lessons that build one real
  integration, teaching every capability in the order that makes each one make sense, with
  something to run at every step.
- **A specific question** — the reference pages below, which answer "how does X work?"
  rather than "what do I do next?".

## Reference

| Page | Answers |
| --- | --- |
| [The specification](reference/specification.md) | What exactly does a query mean? The standard, independent of any implementation |
| [Text syntax](reference/text-syntax.md) | What can people type into a search box, and what JSON does it become? |
| [Library API](reference/api.md) | Which functions does the TypeScript package export? |
| [The command](reference/cli.md) | How do I filter JSON lines from a shell? |

## Guides

| Page | Answers |
| --- | --- |
| [TypeScript](guides/typescript.md) | How do typed queries, the array methods and vocabularies fit together? |
| [Queries from outside](guides/untrusted-input.md) | How do I accept a query from a URL or a request body safely? |
| [Pushing a query into a store](guides/pushdown.md) | How does a backend answer the part of a query it can? |
| [Adopting JQL in a project](guides/adopting.md) | How does a project in this family move its filtering onto JQL? |

## Design

| Page | Answers |
| --- | --- |
| [Decisions](design/decisions.md) | Why is it shaped this way, and what did that cost? |
| [Performance](design/performance.md) | How fast is it, how is that measured, and what makes it so? |
