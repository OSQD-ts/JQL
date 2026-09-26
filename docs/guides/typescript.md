# TypeScript

Typed queries, the array methods, and vocabularies.

← [Documentation](../index.md)

---

## Typed queries

`Query<T>` knows the shape of `T`. Paths are checked, values are checked, and an operator is
offered only where it makes sense:

```ts
import type { Query } from "@osqd/jql";

interface User {
  id: number;
  name: string;
  joined: Date;
  roles: ("admin" | "editor")[];
  address: { city: string };
  sessions: { device: string; minutes: number }[];
}

const ok: Query<User> = {
  "address.city": "London",                                   // paths into objects
  "sessions.device": "mobile",                                // paths through arrays
  roles: "admin",                                             // a value matches any element
  joined: { $gte: { $date: "2026-01-01" } },                  // dates, the JSON way
  sessions: { $elemMatch: { minutes: { $gt: 30 } } },
};

const wrong: Query<User> = {
  nme: "Ada",                  // error: no such field
  id: "1",                     // error: id is a number
  "address.cty": "London",     // error: no such path
  name: { $size: 3 },          // error: $size is for arrays
  roles: "owner",              // error: not a role
};
```

Every one of those errors is a query that would otherwise have compiled, run, and silently
matched nothing. Paths are enumerated five levels deep; deeper ones still work at run time but
are not offered.

For data whose shape is not known — `unknown`, `any`, parsed JSON — `Query<unknown>` accepts any
field. The engine still validates the query itself when it compiles it.

## The array methods infer the type

```ts
import "@osqd/jql/global";

users.jqlSearch({ "address.city": "London" });   // User | undefined
Array.jqlSearch(users, { id: 1 });               // the same, from any iterable
users.jqlSearch({ missing: 1 });                 // error: User has no field `missing`
[1, 2, 3].jqlFilter({ $gt: 1 });                 // a condition on the number itself
```

The methods and their types come from one import, `@osqd/jql/global`, on purpose: if the main
entry added `jqlSearch` to the type of every array without adding it to every array, the
compiler would promise a method that fails at run time.

## Queries from outside the types

A query typed into a search box or read from a URL has no static type. `parseText` returns an
`UntypedQuery`, and `untyped(json)` marks any other one, so it can be passed where a typed
query is expected:

```ts
import { untyped } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";

users.jqlFilter(parseText(searchBox.value));
users.jqlFilter(untyped(JSON.parse(request.body)));
```

It is a brand rather than a loose object type because a loose type would also accept every
object literal, and `users.jqlSearch({ nme: "Ada" })` would stop being an error. What checks an
untyped query is the engine, when it compiles it — see
[Queries from outside](untrusted-input.md).

## Vocabularies

A vocabulary gives a collection the names people use, and fields that are computed rather than
stored:

```ts
import { defineVocabulary, type Query } from "@osqd/jql";

const vocabulary = defineVocabulary<User>()({
  fields: {
    city: { path: "address.city", kind: "exact" },
    minutes: { get: (user) => user.sessions.reduce((sum, s) => sum + s.minutes, 0), kind: "number" },
  },
  text: ["city"],
});

users.jqlFilter({ city: "London", minutes: { $gt: 60 } }, { vocabulary });
```

The field names type-check: `defineVocabulary` is curried so that `T` is given and the fields
are inferred, and passing the vocabulary in the options adds its names to what the query may
use, with the type of each computed field. Aliases are for the text syntax and untyped queries;
the types know the fields.

The same vocabulary drives the [text syntax](../reference/text-syntax.md#field-kinds), which is
the reason it exists: one list of names for the search box and for the JSON, so the two cannot
drift apart.

## Related

- [Library API](../reference/api.md) — every export
- [The specification](../reference/specification.md) — what the queries mean
