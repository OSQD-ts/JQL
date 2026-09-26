# JQL — JSON Query Language

One query language for every place the OSQD projects filter data, and a zero-dependency
TypeScript engine that runs it.

> A query is a JSON document that means the same thing everywhere it is sent — and a query
> that is not valid JQL is refused with the reason, never run as something that looks like it
> worked.

```sh
npm install @osqd/jql
```

Node 20 or newer, and TypeScript 5.4 or newer if you use the types: the published
declarations use `NoInfer`, which TypeScript 5.4 added. Nothing else is required — the
package has no runtime dependencies.

```ts
import "@osqd/jql/global";

const arr = [{ id: 1, tags: ["a"] }, { id: 2, tags: ["b"] }];
arr.jqlSearch({ id: 2 });                                // { id: 2, tags: ["b"] }
Array.jqlSearch(arr, { tags: { $in: ["a", "c"] } });     // any array, iterable, Set or Map
arr.jqlQuery({ where: { id: { $gt: 0 } }, sort: { id: -1 }, limit: 1 });
```

## Contents

- [**The course**](docs/course/index.md) — sixteen lessons that build one real integration, with something to run at every step
- [Quick start](docs/start/quick-start.md) — install it and ask the first question
- [The specification](docs/reference/specification.md) — the standard: what every query means
- [Conformance suite](conformance/cases.json) — the standard as data, for any implementation
- [Text syntax](docs/reference/text-syntax.md) — what people type into a search box, and writing one back out
- [The command](docs/reference/cli.md) — `jql`, for filtering JSON lines from a shell
- [Pushing a query into a store](docs/guides/pushdown.md) — letting a backend answer what it can
- [Library API](docs/reference/api.md) — every export
- [TypeScript](docs/guides/typescript.md) — typed queries, the array methods, vocabularies
- [Queries from outside](docs/guides/untrusted-input.md) — accepting a query from a URL or a body
- [Adopting JQL in a project](docs/guides/adopting.md) — moving a project's filtering onto it
- [Performance](docs/design/performance.md) and [Decisions](docs/design/decisions.md)
- [All documentation](docs/index.md)

## What it is

- **A standard.** [The specification](docs/reference/specification.md) defines the language
  independently of this code, and [`conformance/cases.json`](conformance/cases.json) states it
  as JSON documents, JSON queries and the answers any implementation must give.
- **A library.** Compile a query once into a plain predicate, or use `find`, `filter`, `count`,
  `search`, `group` and friends over arrays, iterables, `Map`s, `Set`s, plain objects — and,
  with the `*Async` helpers, over a log or a cursor that arrives over time.
- **Explainable.** `explain(query, item)` says which clause decided it, with the values it
  read; `canonical` and `fingerprint` give a saved filter one shape and one short name.
- **Typed.** `Query<T>` checks paths, value types and which operators fit each field, so a typo
  is a compile error rather than a filter that matches nothing.
- **Fast.** Within about 1.1–1.5× of a hand-written loop for most queries, faster than one for
  top-k sorting, and 2–130× faster than the query-document matchers commonly used in
  JavaScript.
- **A search box, both ways.** `@osqd/jql/text` turns `status:open total:>100 has:rule at:>-1h`
  into a JQL document, and `toText` turns a stored one back into something somebody can edit.
- **A shell command.** `jql --text 'level:error' app.jsonl` filters JSON lines, with
  `--sort`, `--group`, `--omit` and `--explain`.
- **Pushable.** `plan(query, capabilities)` splits a query into the part a store can answer
  and the part that stays here, with `@osqd/jql/mongo` as the first target.
- **Extensible where it has to be.** A project can add operators of its own, named `$x…` so a
  query that needs more than a standard engine says so.

## Why this design

| Choice | Instead of | Because |
| --- | --- | --- |
| Queries are JSON | a text language | data can be stored, sent, generated and validated; text can only be typed |
| The conventional operator names | a vocabulary of our own | `$gt` and `$elemMatch` carry their meaning with them; where this language differs, the [specification](docs/reference/specification.md) says so where the operator is defined |
| Refuse anything not understood | ignore it | an ignored `$gtt` is a filter that silently filters nothing |
| Compile to closures | generate code | generated code is blocked by any real Content-Security-Policy |
| Array methods behind an import | patch on load | changing built-ins is the application's decision |
| A conformance suite in JSON | tests only in TypeScript | a standard other languages can check themselves against |
| `{ "$field": "other" }` | an expression language (`$expr`) | comparing two fields needs a path, not a language |
| Relative dates in the query | an instant computed before sending | a saved filter that means "the last hour" goes on meaning it |

More in [Decisions](docs/design/decisions.md).

## License

OSQD Non-Resale License — see [LICENSE](LICENSE).
