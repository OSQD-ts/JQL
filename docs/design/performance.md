# Performance

How fast JQL is, how that is measured, and what makes it so.

← [Documentation](../index.md)

---

## The numbers

Every figure is a **ratio** against the loop somebody would have written by hand for the same
answer, measured in the same process seconds apart. A number of milliseconds is a statement
about the machine that produced it; a ratio holds still across machines and moves only when the
engine does. From `npm run bench`, 100 000 documents, median of seven calibrated rounds:

| Case | JQL ÷ hand-written |
| --- | --- |
| `{ id: … }` — find by id, walking everything | 1.02–1.11× |
| `{ age: { $gte, $lt }, active: true }` | 1.30–1.47× |
| `{ "address.city": … }` | 1.07–1.21× |
| `{ id: { $in: [100 ids] } }` against a hand-built `Set` | 0.96–1.03× |
| `{ tags: "billing" }` — a value in an array | 1.14–1.26× |
| `{ name: { $contains, $options: "i" } }` | 1.12–1.18× |
| `$or` of a nested path and a range | 1.07–1.27× |
| `{ name: { $glob: "Person 1*" } }` against a hand-written `startsWith` | 0.78–0.91× |
| `{ notes: { $length: { $gt: 20 } } }` | 1.79–2.36× |
| `{ visits: { $gt: { $field: "purchases" } } }` | 2.15–2.86× |
| `$text` over the whole document, against checking four known fields | 2.29–2.43× |
| `search` top 10 by a field, against filter-sort-slice | 0.39–0.51× |

`$text` is the one that stays above 2×, because it does more than the hand-written loop: it
walks every value in the document rather than the four fields the loop already knows about.
Give it `$fields`, or a vocabulary with `text` fields, and it reads only those.

A `{ "$field": … }` comparison will not reach parity either: it reads two fields per item and
compares values whose types neither side knew when the query compiled, where the hand-written
`p.visits > p.purchases` is one machine comparison. It is still a filter over a million items
in a few milliseconds.

A glob is *faster* than the loop it replaces, because a pattern is taken apart once into the
narrowest matcher that fits it — `startsWith` for `prefix*`, `includes` for `*middle*`, a run
of `indexOf` calls for the rest — and only a pattern holding `?` walks character by
character.

For comparison, the same queries through the two most used query-document matchers for
JavaScript, measured once on the same machine (sift 17.1.3, mingo 7.2.4), took 2× to 130× as
long as JQL. The widest gap is `$in`, where JQL looks each item up in a set rather than
comparing it with every value in the list. These are not in the benchmark suite, because the
guard measures JQL against the code it replaces, not against other libraries.

## What makes it fast

- **Everything that depends only on the query happens once**, in `compile`: validation, field
  resolution, path splitting, a `Set` for `$in`, lower-casing for `$options: "i"`, compiling
  patterns. What runs per document is only the part that depends on the document.
- **The headline case is written out.** `{ id: 2 }` compiles to one closure with the read, the
  comparison and the array fallback inline — the loop you would have written.
- **One read per field.** `{ age: { $gte: 30, $lt: 50 } }` reads `age` once and compares twice.
- **Nested paths are read straight** — two property reads for `address.city` — and walked with
  the fan-out machinery only when an array is actually in the way.
- **Cheapest first.** The parts of an `$and` are reordered so equality runs before a pattern
  and a pattern before a text walk; the first to fail decides the answer.
- **Early exits everywhere.** `find`, `some`, `every` and an unsorted `search` stop as soon as
  the answer is known, including on generators, which are not consumed past it.
- **A bounded heap for top-k.** `search` with a sort and a limit keeps only the best
  `skip + limit` items: O(n log k), and memory for k.
- **Arrays are walked by index**, not through the iterator protocol, which allocates per step.

## Compile once in a hot loop

Every helper compiles the query it is given. Compiling a small query takes well under a
microsecond, which is nothing against a large array and everything against a tiny one:

```ts
// Compiles a thousand times.
for (const batch of batches) batch.jqlFilter({ status: "open" });

// Compiles once.
const open = compile<Order>({ status: "open" });
for (const batch of batches) batch.filter(open);
```

There is deliberately no cache that would do this for you; [Decisions](decisions.md#no-implicit-cache)
says why.

## The guard

`npm run bench:guard` fails when a case's ratio passes its budget. The budgets sit at about
twice the top of each measured range: tight enough to catch a real regression, loose enough
that noise never fires them, because a guard that fires on noise gets raised until it guards
nothing. When one fails, either something got slower, or the budget is wrong for a change that
was worth making — in which case raise it and say why in the commit.

The differential test (`tests/differential.test.ts`) is the other half: every fast path above is
a second implementation of something the specification already says, so thousands of random
documents and queries are run through the engine and through a deliberately naive reference,
and the two must agree.

## Related

- [Decisions](decisions.md) — the closures-not-codegen and no-cache trades
- [Library API](../reference/api.md) — `compile`, `search`
