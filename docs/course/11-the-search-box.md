# Lesson 11 — The search box

**Goal:** let people type, and get back the same JQL you would have written yourself.

← [Course](index.md) · Previous: [A vocabulary](10-vocabulary.md) · Next: [Queries from outside](12-untrusted.md)

---

## Nobody types JSON into a search box

`@osqd/jql/text` is the syntax people *do* type:

```
status:open total:>100 -has:note
```

It has no matcher of its own. It **compiles into a JQL document**, and the engine you have
been using for ten lessons runs that. There is one set of semantics, and the text is a second
way of writing it.

That matters more than it sounds. A search box with its own matcher drifts from the JSON one
within a week, and then a saved filter means one thing on the screen and another in the
export.

## Typing into it

```js
import { filter } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

// A fixed clock, so "the last week" means the same thing every time this runs.
const options = { vocabulary: ORDERS, now: () => Date.parse("2026-09-25T12:00:00Z") };

const box = (typed) => {
  const query = parseText(typed, { vocabulary: ORDERS });
  const found = filter(orders, query, options).map((o) => o.id).join(" ") || "(none)";
  console.log(typed.padEnd(28), found);
};

box("status:open");
box("status:open country:gb");
box("-status:paid");
box("status:$in(open, cancelled)");
```

```
status:open                  o-1002 o-1005
status:open country:gb       o-1005
-status:paid                 o-1002 o-1004 o-1005 o-1007
status:$in(open, cancelled)  o-1002 o-1005 o-1007
```

Adjacent terms are **and**, which is what narrowing means to the person typing. `-` is not,
and `$in(…)` is one of a set.

### Numbers and dates

```js
import { filter } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const options = { vocabulary: ORDERS, now: () => Date.parse("2026-09-25T12:00:00Z") };

const box = (typed) => {
  const found = filter(orders, parseText(typed, { vocabulary: ORDERS }), options);
  console.log(typed.padEnd(28), found.map((o) => o.id).join(" ") || "(none)");
};

box("total:>100");
box("total:10..40");
box("at:>2026-09-18");
box("at:>-7d");
```

```
total:>100                   o-1005 o-1007
total:10..40                 o-1001 o-1002 o-1004 o-1006 o-1008
at:>2026-09-18               o-1006 o-1007 o-1008
at:>-7d                      o-1006 o-1007 o-1008
```

`total` and `placed` were declared `number` and `date` in the vocabulary, which is what lets
`>100` and `>-7d` be read as comparisons rather than searched for as text. That is the whole
job of `kind`.

### Presence, alternatives and bare words

```js
import { filter } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const box = (typed) => {
  const found = filter(orders, parseText(typed, { vocabulary: ORDERS }), { vocabulary: ORDERS });
  console.log(typed.padEnd(28), found.map((o) => o.id).join(" ") || "(none)");
};

box("has:note");
box("-has:note");
box("sku:desk-lamp $or tag:gift");
box("ada");
box('"gift wrap"');
```

```
has:note                     o-1001 o-1003 o-1004 o-1006 o-1007
-has:note                    o-1002 o-1005 o-1008
sku:desk-lamp $or tag:gift   o-1001 o-1005 o-1007
ada                          o-1001 o-1008
"gift wrap"                  o-1006
```

A bare word searches the `text` fields the vocabulary listed — `id`, `who`, `email`, `sku` and
`note` — so `ada` finds both Adas without anybody naming a field. A quoted phrase is one term.

## The syntax, in one table

| Typed | Means |
| --- | --- |
| `status:open` | the field, read according to its `kind` |
| `status:open country:gb` | adjacent terms are **and** |
| `-status:paid`, `!status:paid` | not |
| `status:$in(open, cancelled)` | one of a set; `$notin(…)` for none of them |
| `total:>100`, `total:>=100`, `total:10..20` | comparisons and ranges, on a `number` or `date` field |
| `at:>2026-09-18`, `at:>-7d` | an instant, or a signed duration from now |
| `has:note`, `-has:note` | the field is set, or is not |
| `a $or b`, `$not a`, `(a $or b) c` | precedence: `$not` tightest, then and, then `$or` |
| `ada`, `"gift wrap"` | a bare word or phrase, in the vocabulary's `text` fields |

Operators carry a `$` on purpose. A bare `or` is a word that appears in notes and addresses,
and a language where an ordinary search word silently becomes an operator is a language that
lies about what it matched.

## What it compiles to

```js
import { parseText } from "@osqd/jql/text";
import { ORDERS } from "./vocabulary.mjs";

console.log(JSON.stringify(parseText("status:open total:>100", { vocabulary: ORDERS }), null, 2));
```

```
{
  "$and": [
    {
      "status": {
        "$eq": "open",
        "$options": "i"
      }
    },
    {
      "total": {
        "$gt": 100
      }
    }
  ]
}
```

Nothing exotic: it is the query you would have written by hand. `$options: "i"` is there
because `status` was declared `exact`, which means "equals it, ignoring case".

## The parser never throws

It runs on **every keystroke**, so half-typed input is the normal state rather than an error:

```js
import { count } from "@osqd/jql";
import { parseText } from "@osqd/jql/text";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const halfTyped = parseText("status:open $and (total:>", { vocabulary: ORDERS });

console.log(JSON.stringify(halfTyped));
console.log("matches", count(orders, halfTyped, { vocabulary: ORDERS }), "of 8");
```

```
{"$and":[{"status":{"$eq":"open","$options":"i"}},{"total":{"$in":[]}}]}
matches 0 of 8
```

An unclosed bracket, a dangling `$or`, a `$in(` with nothing after it: each parses to the best
reading available. Look at what the unfinished half became — `{ "$in": [] }`, a term that
matches **nothing**.

That direction is chosen deliberately. A half-typed filter that quietly *widened* to everything
would show the operator a screen full of rows that are not the ones they are looking for, and
nothing on the screen would say the filter was incomplete.

## Putting a saved filter back in the box

A dashboard that stores filters as JSON has to show one in the box when somebody opens it to
edit. That is `toText`:

```js
import { toText } from "@osqd/jql/text";
import { ORDERS } from "./vocabulary.mjs";

const stored = [
  { status: { $eq: "open", $options: "i" } },
  { $and: [{ country: { $eq: "GB", $options: "i" } }, { total: { $gt: 100 } }] },
  { placed: { $gte: { $date: { $ago: "7d" } } } },
  { $not: { tag: { $eq: "gift", $options: "i" } } },
  { total: { $gte: 10, $lte: 40 } },
];

for (const query of stored) console.log(JSON.stringify(toText(query, { vocabulary: ORDERS }).text));
```

```
"status:open"
"country:GB total:>100"
"placed:>=-7d"
"-tag:gift"
"total:10..40"
```

Parsed back with the same vocabulary, each of those means precisely the clauses it carries —
a property the test suite holds the writer to on thousands of generated queries.

### When the box cannot say it

`toText` is deliberately **not** total. The text syntax is smaller than JQL, and some queries
have no spelling in it:

```js
import { toText } from "@osqd/jql/text";
import { ORDERS } from "./vocabulary.mjs";

const hard = { status: { $eq: "open", $options: "i" }, tag: { $size: 2 } };
const form = toText(hard, { vocabulary: ORDERS });

console.log("text       :", JSON.stringify(form.text));
console.log("complete   :", form.complete);
console.log("unexpressed:", JSON.stringify(form.unexpressed, null, 2));
```

```
text       : "status:open"
complete   : false
unexpressed: [
  {
    "at": "tag.$size",
    "clause": {
      "$size": 2
    },
    "why": "\"$size\" has no spelling in the text syntax"
  }
]
```

This is the contract, and it is worth reading twice. The text holds only the part the box
*could* express — `status:open` — and says nothing at all about the `$size` constraint that is
still in force. So `complete` is `false`, and `unexpressed` names the clause that got left
behind and why.

A caller that shows `form.text` and ignores `form.complete` has just shown somebody a filter
**wider than the one that is running**. The signature returns all three so that the check is
one line:

```js
import { toText } from "@osqd/jql/text";
import { ORDERS } from "./vocabulary.mjs";

const show = (query) => {
  const form = toText(query, { vocabulary: ORDERS });
  console.log(form.complete ? "shows it all " : "⚠ incomplete  ", JSON.stringify(form.text));
};

show({ status: { $eq: "open", $options: "i" } });
show({ status: { $eq: "open", $options: "i" }, tag: { $size: 2 } });
```

```
shows it all  "status:open"
⚠ incomplete   "status:open"
```

## Completions

```js
import { suggest } from "@osqd/jql/text";
import { ORDERS } from "./vocabulary.mjs";

const caretAt = [["stat", 4], ["status:", 7], ["status:op", 9], ["-co", 3], ["status:open c", 13], ["$", 1]];

for (const [typed, caret] of caretAt) {
  const { options, from, to } = suggest(typed, caret, ORDERS);
  console.log(`${JSON.stringify(typed).padEnd(16)} replace [${from},${to}] with: ${options.join(" ") || "(nothing)"}`);
}
```

```
"stat"           replace [0,4] with: status:
"status:"        replace [0,7] with: status:open status:paid status:refunded status:cancelled
"status:op"      replace [0,9] with: status:open
"-co"            replace [0,3] with: -country:
"status:open c"  replace [12,13] with: channel: country:
"$"              replace [0,1] with: $and $or $not $in $notin
```

`from` and `to` are the span to replace, so inserting a completion does not disturb the rest
of the input.

What comes back is written the way the parser reads it back. That matters the moment a value
has a space in it:

```js
import { defineVocabulary } from "@osqd/jql";
import { parseText, suggest } from "@osqd/jql/text";

const STATES = defineVocabulary()({ fields: { status: { kind: "exact", values: ["open", "in progress"] } } });

const [option] = suggest("status:in", 9, STATES).options;

console.log("offered:", option);
console.log("means  :", JSON.stringify(parseText(option, { vocabulary: STATES })));
```

```
offered: status:"in progress"
means  : {"status":{"$eq":"in progress","$options":"i"}}
```

Quoted, because `status:in progress` would parse as `status:in` **and** a loose search word —
a different question, with nothing on screen to say so. A completion is text somebody presses
Tab on without reading it, so one that changes the query is worse than no completion at all.

### Values you only know at run time

The values above came from the `values` you listed in the vocabulary — a closed set, decided
when the vocabulary was written. Harbour's `who` field has no such set, and yet a console that
has just drawn a table knows exactly which customers are on it:

```js
import { suggest } from "@osqd/jql/text";
import { orders } from "./orders.mjs";
import { ORDERS } from "./vocabulary.mjs";

const onScreen = [...new Set(orders.map((order) => order.customer.name))];

console.log("with nothing given:", suggest("who:Ada", 7, ORDERS).options);
console.log("with what we saw  :", suggest("who:Ada", 7, ORDERS, { values: { who: onScreen } }).options);
```

```
with nothing given: []
with what we saw  : [ 'who:"Ada Lovelace"', 'who:"Ada Byron"' ]
```

Without the values it offers nothing, because guessing there would be inventing options rather
than completing them. Given them, it completes — and quotes the ones that need it. Declared
values come first and the two merge, so a field can have both.

## Exercise

Harbour's console has a saved filter: `{ status: { $eq: "open", $options: "i" }, outstanding: { $gt: 100 } }`.
Put it in the box and say what the operator sees.

<details>
<summary>Answer</summary>

```js
import { toText } from "@osqd/jql/text";
import { ORDERS } from "./vocabulary.mjs";

const form = toText({ status: { $eq: "open", $options: "i" }, outstanding: { $gt: 100 } }, { vocabulary: ORDERS });

console.log(form);
```

```
{
  text: 'status:open outstanding:>100',
  complete: true,
  unexpressed: []
}
```

A computed field is a name like any other here — the box neither knows nor cares that
`outstanding` is worked out rather than stored. Type that text back in and you get the same
query.
</details>

## Related

- [Text syntax](../reference/text-syntax.md) — every term, and what each `kind` does with it
- [Library API](../reference/api.md) — `parseText`, `toText`, `suggest`
