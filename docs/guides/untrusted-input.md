# Queries from outside

Accepting a query from a URL, a request body or somebody else's saved filter.

← [Documentation](../index.md)

---

A JQL query is data, which is why it can travel. It is also why a query can arrive from
somebody you do not trust. Five things to do with one.

## 1. Compile it with the untrusted limits

```ts
import { UNTRUSTED_LIMITS, validate } from "@osqd/jql";

const checked = validate<Order>(JSON.parse(body), { limits: UNTRUSTED_LIMITS });
if (!checked.valid) return respond(400, { error: checked.error.message });
const matches = orders.filter(checked.test);
```

`validate` returns the predicate it compiled, rather than only a verdict, so the query that
was checked is the query that runs. Calling `compile` again afterwards works, but it is the
one place where the limits can quietly differ between the check and the run.

`UNTRUSTED_LIMITS` caps nesting at 16 levels and the query at 512 fields and operators, and
**turns `$regex` off**. No engine can tell a pattern that backtracks for a minute — `(a+)+$`
against a long run of `a`s — from one that does not without running it. The string operators
(`$contains`, `$startsWith`, `$endsWith`, `$word`) answer almost everything a pattern would,
in linear time, and stay available.

Every limit refuses rather than truncates: a query cut short answers a different question from
the one that was asked, and nobody could tell.

## 2. Answer the refusal, do not crash on it

`validate` never throws for an invalid query, and its error names the place:
`at $or[1].age.$gtt: "$gtt" is not an operator; did you mean "$gt"?`. That sentence is safe to
return to the caller — it quotes only the query they sent.

## 3. Bound what arrives before it is parsed

The limits apply to the parsed query. The body itself is yours to bound: a `$in` of a million
ids is a legitimate query and costs a million set entries, so cap the request size where you
read it. `$in` lists are deliberately not counted against `maxNodes`, because looking up an
item in one costs the same however long it is.

## 4. Say which operators are on the menu

```ts
const limits = { ...UNTRUSTED_LIMITS, allowOperators: ["$eq", "$ne", "$in", "$gt", "$gte", "$lt", "$lte", "$and", "$or"] };
```

`UNTRUSTED_LIMITS` turns `$regex` off, because no engine can tell a pattern that backtracks
for a minute from one that does not. Which of the *rest* an endpoint wants is a decision only
that endpoint can make: `$text` walks a whole document, `$elemMatch` carries a query of its
own, and an endpoint that needs neither should say so once, here, rather than find out later
which of them somebody used.

An operator outside the list is refused by name. A name in the list that is not an operator
is refused too — an allowlist with a typo would allow nothing while looking like it allowed
something.

## 5. Give it a strict vocabulary for a public API

```ts
const vocabulary = defineVocabulary<Order>()({ fields: { status: {}, total: {}, placed: {} }, strict: true });
```

With `strict`, a query may name only those fields. Documents tend to grow fields nobody promised
to keep, and a public query language that can reach every one of them turns every internal
field into part of the API.

## What a query cannot do

A JQL query is JSON, so it cannot carry code: there is no `$where`, no `$function`, nothing
that is evaluated. Paths read only an item's own fields, so `constructor`, `__proto__` and
inherited members are unreachable, and nothing a query does writes to anything. The text
syntax never throws for anything anybody types, and caps its input at 8 KB and 16 levels
of brackets — no deeper than the tightest limit the engine is asked to compile under, so the
box cannot produce a query the engine would refuse.

## Related

- [Library API](../reference/api.md#limits) — the limits in full
- [The specification](../reference/specification.md#10-limits) — what the standard says about caps
