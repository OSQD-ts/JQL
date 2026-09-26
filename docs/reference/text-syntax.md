# Text syntax

What people can type into a search box, and the JQL document each piece becomes.

← [Documentation](../index.md) · [Reference](index.md)

---

`parseText` from `@osqd/jql/text` turns a line of text into a JQL query. It has no matcher of
its own: the text *is* a way of writing JSON, and the engine runs the JSON. So a filter typed
into a dashboard, saved, and later run by a service that only understands JSON finds exactly
the same things.

The syntax is BotHandler's feed filter, moved here so every project shares one.

```ts
import { parseText } from "@osqd/jql/text";

parseText("actor:203.0.113.4 -path:/health score:>70", { vocabulary });
// { $and: [
//   { actor: { $word: "203.0.113.4", $options: "i" } },
//   { $not: { path: { $contains: "/health", $options: "i" } } },
//   { score: { $gt: 70 } } ] }
```

## Terms

| You type | Means | Becomes |
| --- | --- | --- |
| `checkout` | the text appears anywhere | `{ "$text": "checkout" }` |
| `"connection reset"` | a phrase, spaces and all | `{ "$text": "connection reset" }` |
| `path:/api` | the field matches the value (how depends on the field's kind, below) | `{ "path": { "$contains": "/api", "$options": "i" } }` |
| `-path:/health` or `!path:/health` | not | `{ "$not": { … } }` |
| `path:$in(/a, /b)` | any of these | `{ "path": { "$contains": ["/a", "/b"], "$options": "i" } }` |
| `path:$notin(/a, /b)` | none of these | `{ "$not": { "path": … } }` |
| `has:rule` | the field has a value | `{ "rule": { "$exists": true } }` |
| `-has:rule` | the field has none | `{ "$not": { "rule": { "$exists": true } } }` |

A phrase is matched against **one value at a time**, and values are never joined first.
`"connection reset"` finds a log line holding that text; `"GET /api/v2"` finds nothing at all
when `GET` is the `method` field and `/api/v2` is the `path` field, because no single value
holds the phrase — and naming both fields in the vocabulary's `text` list does not change
that. To make that phrase askable, give the vocabulary a field that *is* the joined value:

```ts
const REQUESTS = defineVocabulary<Request>()({
  fields: {
    method: { kind: "exact", values: ["GET", "POST"] },
    path: { kind: "word" },
    // The value the phrase is actually about. Now `"GET /api/v2"` has something to match.
    line: { kind: "word", get: (request) => `${request.method} ${request.path}` },
  },
  text: ["line"],
});
```

Any quote works — `"…"`, `'…'`, and the curly `“…”` and `‘…’` that smart punctuation produces
when a filter is pasted from chat or documentation. A single quote counts as a quote only
where a value begins, so the apostrophe in `don't` is still an apostrophe. Inside a set, a
comma separates values only outside quotes: `$in("a,b", c)` is two values.

## Operators

| You type | Means |
| --- | --- |
| `a b` or `a $and b` | both |
| `a $or b` | either |
| `$not a` | not — the same as `-a` |
| `(a $or b) $and c` | grouping |

`$not` binds tightest, then `$and`, then `$or`, so `a $or b $and c` reads as `a $or (b $and c)`.

**Operators carry a `$`.** A bare `or` is a word that appears in paths and User-Agents, and a
language where an ordinary search word silently becomes an operator lies about what it
matched. Typing `or` searches for the text `or`.

## Field kinds

How `field:value` reads the value is the field's `kind` in the [vocabulary](../guides/typescript.md#vocabularies):

| Kind | `field:value` becomes | For |
| --- | --- | --- |
| `text` (default) | `$contains`, ignoring case | prose, paths, User-Agents |
| `word` | `$word`, ignoring case — `1.2.3.4` does not find `1.2.3.45` | addresses, identifiers |
| `exact` | `$eq` (or `$in` for a set), ignoring case | closed sets: verdicts, methods, statuses |
| `number` | a comparison: `>70`, `>=70`, `<5`, `<=5`, `=42`, `42`, and ranges `10..20`, `10..`, `..20` | scores, sizes, durations |
| `date` | the same comparisons on `{ "$date": … }`: `>2026-09-01`, `2026-09-01..2026-09-30`, and the relative `>-1h`, `<+30m`, `-1h..now` | timestamps |
| `boolean` | `true`/`false`, `yes`/`no`, `1`/`0`, `on`/`off` | flags |

**A relative instant carries its sign**: `-1h` is an hour ago, `+30m` is half an hour from
now, `now` is now. The sign is what says a duration was meant — a bare `1h` is as likely to be
part of something somebody is searching for, and reading it as a time would be reading
something into what was typed. A filter written this way goes on meaning "the last hour"
whenever it is run, because the query it becomes holds `{ "$ago": "1h" }` rather than an
instant.

`has:` asks about the field rather than its value, so its value is a field name. A name the
vocabulary does not know falls through and is searched for as text, like any other.

A value that does not read as its kind — `score:high`, `certain:maybe` — matches nothing, as
does an empty set. A search box that widened while somebody was still typing would be lying
about what it found.

## Which names are fields

With a vocabulary, only its names and aliases are fields. Anything else before a colon is
searched as text, because a path, a URL or a User-Agent can contain a colon: `foo:bar` looks
for the text `foo:bar`.

Without a vocabulary there is nothing to check a name against, so any name that looks like a
path (`address.city:London`) is a field of kind `text` — except that a value written as an
explicit comparison (`age:>=30`, `age:30..40`) compares as a number, since nobody typing `>30`
means the characters. A bare `age:30` stays text. A URL then has to be quoted:
`"http://example.com"`. Pass `fields: "vocabulary"` or `fields: "any"` to choose either
behaviour explicitly.

A bare word searches the vocabulary's `text` fields when it names some, and the whole item
otherwise.

## Nothing typed is an error

`parseText` never throws. Half-written input is the normal state of a search box: an unclosed
bracket, a dangling `$or`, a `$in(` with nothing after it all parse to the best reading of what
is there. Input past 8 KB is cut, and brackets nested past 16 levels are ignored, so a hostile
link cannot overflow the stack of whoever opens it.

That is the opposite of the JSON engine, which refuses anything it does not understand — on
purpose. JSON is written by a program that can be told it is wrong; a search box is written by
a person who has not finished typing.

## Completion

`suggest(input, caret, vocabulary?, options?)` returns the completions for the token under
the caret and the span they replace. Field names come from the vocabulary; a field with a
closed set of `values` completes its values and offers `$in(` and `$notin(`; a token starting
with `$` completes to an operator.

**What is offered, inserted, means what it says.** A value holding a space or a quote comes
back quoted — `status:"in progress"`, not `status:in progress`, which would parse as
`status:in` and a loose search word. A value the syntax cannot write at all (one holding both
kinds of quote, with no escape between them) is left out rather than offered in a form that
parses as less. Completion keeps working inside a quote you have opened and inside a
`$in(…)` set, where it keeps the values already chosen.

A field that declares no `values` offers nothing, because guessing there would be inventing
options rather than completing them. When you *have* seen its values — the console has just
listed a thousand rows — hand them over and it completes:

```ts
suggest(input, caret, vocabulary, { values: { owner: ownersOnScreen } });
```

Declared values come first and the two merge, so a field may have both. Names resolve through
the vocabulary, so an alias works.

## Writing a query back out

`toText` is the other direction, for a dashboard that stores filters as JSON and has to put
one back in the box when somebody opens it to edit:

```ts
const { text, complete, unexpressed } = toText(saved, { vocabulary });
box.value = text;
if (!complete) warn(`${unexpressed.length} part(s) of this filter cannot be shown here`);
```

The text is **exact for what it says** — parsed back with the same vocabulary it means
precisely the clauses it carries — but it is not total, and the parts it cannot say are
returned rather than dropped quietly. Showing only the sayable half would be showing a filter
wider than the one that is running.

A few things have no spelling even though they look as if they should: a bare word cannot
begin with `-` or be an operator's name, because the parser strips quotes before it decides
what a word is; and a condition that cares about case cannot be written, because the box
never does.

## What the box cannot say

`$elemMatch`, `$size`, `$length`, `$glob` and `{ "$field": … }` have no spelling here. Each
would need a syntax of its own, and a search box that grew one per operator would stop being
something people can type without a manual. They are all reachable in the JSON, which is what
a saved filter stores anyway.

## Related

- [The specification](specification.md) — what the JSON each term becomes means
- [TypeScript](../guides/typescript.md#vocabularies) — defining a vocabulary
