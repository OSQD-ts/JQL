# Library API

Every export of the TypeScript implementation.

← [Documentation](../index.md) · [Reference](index.md)

---

Three entry points, so nothing is loaded that is not used:

| Import | Holds | Side effects |
| --- | --- | --- |
| `@osqd/jql` | the engine, the collection helpers, `search`, vocabularies, types | none |
| `@osqd/jql/text` | `parseText`, `suggest` — the search-box syntax | none; does not load the engine |
| `@osqd/jql/global` | the methods on `Array`, `Map` and `Set`, and their types | installs them on import |

Every function that takes a query also takes an already compiled predicate or any function
`(item) => boolean`, and an options object `{ vocabulary?, limits? }`.

## `@osqd/jql`

### Compiling

| Export | Does |
| --- | --- |
| `compile(query, options?)` | Validates the query and returns a predicate. Throws `JqlError` for anything that is not valid JQL |
| `matches(item, query, options?)` | One item, one query. For a one-off; compile once for a loop |
| `validate(query, options?)` | `{ valid: true, test }` — the compiled predicate — or `{ valid: false, error }`, without throwing |
| `untyped(json)` | Marks a query from outside the type system so typed helpers accept it. Returns the same object |
| `explain(query, item, options?)` | Why one item does or does not match, clause by clause |
| `canonical(query, options?)` | The query in one shape per meaning |
| `fingerprint(query, options?)` | Sixteen hex characters naming that shape |
| `plan(query, capabilities, options?)` | Splits a query into what a store can answer and what stays here — see [Pushing a query into a store](../guides/pushdown.md) |
| `FIELD_OPERATORS`, `QUERY_OPERATORS` | The operator names, for editors and completions |

`compile` and everything built on it take `{ vocabulary, limits, now, operators }`:
`now` supplies the instant relative dates resolve against (read once, when the query
compiles), and `operators` adds operators of your own — see [below](#operators-of-your-own).

### Collections

Each takes an array, an array-like, any iterable, or a `Map` (whose **values** are the items).

| Export | Returns |
| --- | --- |
| `find(source, query)` | the first match, or `undefined`; stops at it |
| `findIndex(source, query)` | its position, or -1 |
| `filter(source, query)` | every match, as a new array |
| `count(source, query)` | how many match, without building the list |
| `some(source, query)` / `every(source, query)` | whether any / all match; both stop early |
| `partition(source, query)` | `[matches, rest]`, in one pass |
| `filterMap(map, query)` | a new `Map` of the entries whose value matches |
| `filterRecord(object, query)` | a new object of the properties whose value matches |
| `findEntry(mapOrObject, query)` | the first `[key, value]` whose value matches |
| `group(source, by, options?)` | the matches counted by one field, largest group first |

`group` takes `{ where, limit, items, sort, vocabulary }`. An item counts once in each group
it belongs to, so a path reaching an array puts it in one group per distinct value; everything
that cannot name a group — a missing field, a `null`, an object, an **empty list** — shares
the key `null`, so the rows counted always add up to the rows there are. Ask
for `items: true` (or a number) to keep the items as well as the count.

### Requests

`search(source, request, options?)` runs a whole [request](specification.md#8-requests):
`where`, `sort`, `skip`, `limit`, `fields`, `omit`. Without a sort it stops as soon as the page is
full; with a sort and a limit it keeps only the best `skip + limit` in a bounded heap. With
`fields` each result is a new object holding only those paths.

`omit` drops paths from each result after `fields` has chosen them, which is how a server
redacts: the values never leave the process, and the request that says so is data like the
rest. Results are copies, and anything not on the way to a dropped field is shared with the
item rather than duplicated.

`where` takes a compiled predicate as well as a query, which is how a page and its total are
asked for without compiling — or writing — the query twice:

```ts
const matching = compile<Order>(query);
const page = search(orders, { where: matching, sort: { placed: -1 }, skip, limit });
const total = count(orders, matching);
```

### Sources that arrive over time

For a log read line by line, a cursor, a stream of events. Each takes an `AsyncIterable` — or
any ordinary collection, so one call site serves both.

| Export | Returns |
| --- | --- |
| `findAsync(source, query)` | the first match; stops reading at it |
| `filterAsync(source, query)` | every match |
| `countAsync`, `someAsync`, `everyAsync` | the same answers as their synchronous namesakes |
| `filterStream(source, query)` | an async generator of the matches; stops when the caller does |
| `searchAsync(source, request)` | a whole request |

Without a sort, `searchAsync` stops as soon as the page is full, so an endless source still
answers. With a sort it must read everything, and holds only `skip + limit` items while it
does.

### Why one item matched

```ts
const why = explain({ verdict: "bot", score: { $gt: 80 } }, row);
// { matched: false, at: "", because: "1 of 2 parts hold", parts: [
//   { matched: true,  at: "verdict", because: 'verdict is "bot"' },
//   { matched: false, at: "score",   because: "score is 70" } ] }
```

Each clause is compiled and run by the real engine, so an explanation cannot disagree with
the filter it explains. That costs a small compile per clause, which is why it is for one
item — a row somebody clicked — rather than for a collection.

### Saved filters: one shape, one name

```ts
canonical({ b: 2, a: 1, $comment: "note" });   // { a: { $eq: 1 }, b: { $eq: 2 } }
fingerprint({ a: 1, b: 2 }) === fingerprint({ b: { $eq: 2 }, a: 1 });   // true
```

Equal fingerprints mean the same query. Different ones mean only that the queries are written
differently — `{ $gt: 3 }` and `{ $gte: 4 }` agree on every integer, and nothing here notices.
The rules are in the [specification](specification.md#13-canonical-form-optional), so another
implementation can agree about which saved filters are duplicates.

A fingerprint is **stable across versions**, so it is safe as a cache key and as the way a
stored filter is recognised. A set of them is written down in the tests: changing what a query
is named would miss every cache and duplicate every saved filter in silence, so it takes a
deliberate change to those values and a line in the changelog.

### Operators of your own

```ts
const cidr: OperatorDefinition = {
  name: "$xCidr",                       // the $x prefix is required
  compile: (operand, at) => {
    if (typeof operand !== "string") throw new JqlError("takes a network as a string", at);
    return (value) => typeof value === "string" && inNetwork(value, operand);
  },
};

filter(requests, { ip: { $xCidr: "203.0.113.0/24" } }, { operators: [cidr] });
```

**A query using one is not portable JQL.** The `$x` prefix is what says so at a glance, and
an engine that was not given the operator refuses the query by name rather than ignoring the
clause. `cost` orders it against the built-in operators, and `elementwise: false` stops it
being tried against the elements of an array.

### Vocabularies

`defineVocabulary<T>()({ fields, text?, strict? })` names the fields a query may use:

```ts
const vocabulary = defineVocabulary<Request>()({
  fields: {
    ip: { path: "client.address", aliases: ["actor"], kind: "word" },
    ua: { path: "headers.user-agent" },
    outcome: { get: (request) => outcomeOf(request), kind: "exact", values: ["allow", "deny"] },
  },
  text: ["ip", "ua"],
});
```

| Field option | Meaning |
| --- | --- |
| `path` | where the value lives; default the field's own name |
| `get` | computes the value instead; it must not throw |
| `aliases` | other names for the field |
| `kind` | how the text syntax reads a value: `text`, `word`, `exact`, `number`, `date`, `boolean` |
| `values` | the closed set of values, for completion |

In a projection the two kinds of field differ, because only one of them has somewhere of its
own to go: a field with a `path` is projected into the document's shape
(`ip` gives `{ client: { address } }`), while a computed field comes back under its own name
(`outcome` gives `{ outcome }`).

`text` lists the fields a bare search word looks in. `strict: true` refuses any name that is
not in the vocabulary. Names are matched without regard to case. Two names for one field, a
field with both `path` and `get`, and a `text` entry that names nothing are refused when the
vocabulary is defined.

### Limits

`DEFAULT_LIMITS` and `UNTRUSTED_LIMITS` — see [Queries from outside](../guides/untrusted-input.md).

| Limit | Default | Untrusted |
| --- | --- | --- |
| `maxDepth` | 32 | 16 |
| `maxNodes` | 10 000 | 512 |
| `maxPatternLength` | 1 024 | 0 |
| `maxGlobLength` | 1 024 | 256 |
| `maxTextDepth` | 16 | 8 |
| `allowRegex` | `true` | `false` |
| `allowOperators` | `"all"` | `"all"` |

`allowOperators` is an allowlist: give it the operator names a query may use and the rest are
refused by name. `$options` and `$comment` are exempt, and `$field` counts as an operator,
because comparing two fields is a capability of its own. A name that is not an operator is
itself refused — an allowlist with a typo in it would allow nothing and look like it allowed
something.

```ts
const publicLimits = { ...UNTRUSTED_LIMITS, allowOperators: ["$eq", "$ne", "$in", "$gt", "$gte", "$lt", "$lte", "$and", "$or"] };
```

### Errors

`JqlError` is the one error the engine throws. `error.at` is where in the query the problem is
(`$or[1].age.$gt`), and the message starts with it: `at $or[1].age.$gt: "$gtt" is not an
operator; did you mean "$gt"?`.

## `@osqd/jql/text`

| Export | Does |
| --- | --- |
| `parseText(input, { vocabulary?, fields? })` | the search-box syntax to a JQL query; never throws |
| `toText(query, { vocabulary?, fields? })` | the reverse: `{ text, complete, unexpressed }` |
| `suggest(input, caret, vocabulary?)` | completions for the token under the caret, and the span they replace |
| `MAX_TEXT_CHARS`, `MAX_TEXT_DEPTH`, `TEXT_OPERATORS` | the caps and the operator words |

`toText` is how a stored JSON filter gets back into a search box. It is deliberately not
total — `$elemMatch`, `$glob`, `$size`, `$length` and `{ "$field": … }` have no spelling —
so it returns the text *and* what it left out. The text is exact for what it says; a caller
that ignores `unexpressed` is showing somebody a filter wider than the one that is running,
and `complete` makes that check one line.

## `@osqd/jql/mongo`

| Export | Does |
| --- | --- |
| `MONGO_CAPABILITIES` | what a MongoDB `find` filter can answer, for `plan` |
| `toMongoFilter(query, options?)` | translates the pushed part into a MongoDB filter |

What `plan` pushes already carries the names the store knows and instants rather than
durations, so `toMongoFilter(split.pushed)` needs no vocabulary. Its `vocabulary` option is
for translating a query that did not come from `plan`.

See [Pushing a query into a store](../guides/pushdown.md).

## `@osqd/jql/cli`

`main(argv, streams)` returns the exit code, and `run()` wires it to the process. The command
itself is [`jql`](cli.md).

## `@osqd/jql/global`

Importing it adds, non-enumerably:

| On | Methods |
| --- | --- |
| every array | `jqlSearch`, `jqlFilter`, `jqlCount`, `jqlSome`, `jqlEvery`, `jqlFindIndex`, `jqlPartition`, `jqlQuery` |
| `Array` itself | the same, taking the source first: `Array.jqlSearch(iterable, query)` |
| every `Map` | `jqlSearch` (a value), `jqlFilter` (a `Map`), `jqlCount` |
| every `Set` | `jqlSearch`, `jqlFilter` (a `Set`), `jqlCount` |

It also exports `install()` and `uninstall()`. `install` refuses to replace a method of the
same name that something else defined, and is a no-op when the methods are already there —
including when another copy of JQL in the same process installed them, which npm produces
whenever two dependencies want different versions. The copy that got there first keeps the
field. `uninstall` removes JQL's methods and nothing else's.

## Related

- [The specification](specification.md) — what the queries mean
- [TypeScript](../guides/typescript.md) — the types behind these signatures
