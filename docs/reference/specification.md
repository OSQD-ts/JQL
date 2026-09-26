# The JQL specification

JSON Query Language, version 1.1: what a query means, independent of any implementation.

← [Documentation](../index.md) · [Reference](index.md)

---

This page is the standard. The TypeScript library in this repository is one implementation
of it; a service written in another language that reads the same saved filters is another,
and it must give the same answers. Where this page and the library disagree, the library has
a bug.

The executable form of this page is [`conformance/cases.json`](../../conformance/cases.json):
plain JSON documents, plain JSON queries, and the positions that must match. **An
implementation conforms when it passes every case there.** Nothing in the suite depends on
JavaScript.

The words *must*, *must not* and *may* mean what they mean in an RFC.

## 1. Documents

A query runs against one **item** at a time. An item is any JSON value: usually an object,
sometimes a string or a number (a list of tags, a column of scores).

An implementation may extend the data model with values its language has and JSON does not,
provided each maps onto this page:

| Value | Treated as |
| --- | --- |
| a date object | a date, for `$date` comparisons and `$type: "date"`; an object nowhere else |
| a map / dictionary type | an object whose keys are the map's keys |
| a big integer | a number — for equality, ordering, `$mod` and `$type: "number"`; `$type: "bigint"` names it as well |

Only a document's **own** fields are visible. Inherited properties, prototype members and the
methods of a map type are never reached by a path.

## 2. Queries

A query is a JSON **object**. Anything else — an array, a string, `null` — must be refused.

Each key is either a **field path** (§3) or an **operator** beginning with `$`. Every key must
hold: a query is the conjunction of its keys. The empty query `{}` matches every item.

```json
{ "status": "open", "total": { "$gte": 100 } }
```

A key whose value is absent (`undefined` in languages that have it) must be refused. JSON
cannot carry such a key, and an implementation that dropped it would turn a condition on
nothing into a query that matches everything.

## 3. Paths

A field path is a string of **segments** separated by `.`. A path with an empty segment
(`"a..b"`, `""`, `"a."`) must be refused: it reaches nothing.

A path is resolved against an item, producing a list of **reached values**:

1. Start with the item.
2. For each segment:
   - on an **object**, take the field of that name. A missing field reaches *missing*.
   - on an **array**, if the segment is a non-negative integer written without leading
     zeros, take the element at that position (missing if out of range). Otherwise apply the
     same segment to **every element** — the array is seen through. An empty array reaches
     *missing*.
   - on anything else (a string, a number, `null`, *missing*), reach *missing*.
3. The values left at the end are the reached values.

*Missing* is a value a condition can test (§5.3). So `{ "a.b": null }` matches an item where
`a` is absent, where `a` has no `b`, and where `a.b` is `null`.

The first segment is a segment like any other: an item that is **itself** an array is seen
through, so `{ "sku": "pen" }` matches `[{ "sku": "pen" }]`, and an array's own `length` is
not a field — `$size` asks that question.

So is an array met **inside** an array. Applying a segment to every element, and then to the
elements of an element that is itself an array, follows from the rule above and is worth
saying out loud: `{ "a.b": 1 }` matches `{ "a": [[{ "b": 1 }]]}`. A store that resolves only
one array level will answer such a document differently, which is a thing to know before
handing it half a query (§14).

An implementation may stop descending into a document past a depth of its choosing (at least
64), treating anything deeper as missing. A document is data from outside; a walk over it that
could not stop would be a way to end the process.

It may also cap the **number of segments** in a path, and must refuse a longer one rather
than shorten it. A path is the one part of a query whose size the operator count does not
bound — `{"a.a.a…": 1}` is one field however long it is — and a path longer than the depth
the implementation descends to can reach nothing in any case. Whatever the cap is, it must be
the same for a path in a query, in a sort, and in a projection: a path that matches and is
then left out of the result is one name meaning two things. The reference implementation
allows 512.

```json
{ "items": [ { "sku": "pen" }, { "sku": "ink" } ] }
```

| Path | Reaches |
| --- | --- |
| `items.sku` | `"pen"`, `"ink"` |
| `items.1.sku` | `"ink"` |
| `items.5.sku` | *missing* |
| `items` | the array itself |

## 4. Conditions on a field

The value under a field path is one of:

- **a literal**: any JSON value that is not an object with `$` keys. It means `{ "$eq": literal }`.
- **a condition**: an object whose keys all begin with `$`. Every operator in it must hold.
- **a date literal** `{ "$date": … }` (§7), which is a literal.

An object that mixes `$` keys with other keys must be refused: it is neither a condition nor a
value, and guessing which was meant would answer a different question.

### 4.1 How a condition meets an array

Each operator is evaluated against **every reached value** and, where the table in §5 says
*elementwise*, also against **every element** of a reached value that is an array. A positive
operator holds when it holds for **any** of them.

Every operator in a condition is evaluated **separately**. On an array, `{ "$gt": 5, "$lt": 10 }`
holds for `[1, 20]`: some element is above 5 and some element is below 10. To require one
element to satisfy several operators, use `$elemMatch`.

The negating operators — `$ne`, `$nin`, `$exists: false`, `$not` — hold when their positive
counterpart holds for **none** of the reached values. So they match an item where the field
is missing.

## 5. Field operators

### 5.1 Equality and membership

| Operator | Operand | Holds when | Elementwise |
| --- | --- | --- | --- |
| `$eq` | a literal | a reached value equals it (§5.1.1) | yes |
| `$ne` | a literal | `$eq` holds for none | — |
| `$in` | a list of literals | a reached value equals any of them. An empty list matches nothing | yes |
| `$nin` | a list of literals | `$in` holds for none. An empty list matches everything | — |

#### 5.1.1 Equality

- Values of different JSON types are never equal. `1` is not `"1"`, `true` is not `1`.
- Numbers compare numerically; `1` and `1.0` are equal. In a language with a separate big
  integer type, a big integer is a number here too (§1): `10` equals a stored `10n`. The
  alternative is a value that is at once `$gte: 10`, `$lte: 10` and `$ne: 10`. It matters
  only for documents held in memory, since JSON has no big integer and a query cannot carry
  one; a query may only ever name such a value with an ordinary number.
- Strings compare by code point, exactly, unless `$options` has `i` (§5.5).
- Arrays are equal when they have equal elements **in the same order**.
- Objects are equal when they have the same keys with equal values, **in any order**. A key
  whose value is absent counts as not present.
- `null` as a literal matches `null` and *missing*.
- A `$date` literal equals any value that reads as the same instant (§7).

Because `$eq` is elementwise, `{ "tags": "a" }` matches `["a", "b"]`, and because the whole
value is tried first, `{ "tags": ["a", "b"] }` matches that array exactly.

### 5.2 Ordering

| Operator | Holds when a reached value (or element) is |
| --- | --- |
| `$gt` | greater than the operand |
| `$gte` | greater than or equal to it |
| `$lt` | less than it |
| `$lte` | less than or equal to it |

The operand must be a number, a string or a `$date` literal; anything else must be refused.
**Nothing is coerced:** a number bound compares only with numbers, a string bound only with
strings (by code unit), a `$date` bound with anything that reads as a date. `{ "$gt": 5 }` never
matches `"10"`. An ordering operator never matches *missing* or `null`.

### 5.3 Existence and type

| Operator | Operand | Holds when |
| --- | --- | --- |
| `$exists` | `true` / `false` | some reached value is not *missing* / every reached value is *missing*. `null` exists |
| `$type` | a type name, or a non-empty list of them | a reached value (or element) is of one of those types |

The type names are `string`, `number`, `integer` (a number with no fractional part), `bigint`,
`boolean`, `null`, `array`, `object` and `date`. An unknown name must be refused. `object`
does not include arrays or dates. A big integer is a `number` and an `integer` as well as a
`bigint`, because it is one for ordering (§1) and a value that `$gt` treats as a number while
`$type` does not is a distinction nobody could explain.

### 5.4 Strings

| Operator | Operand | Holds when a reached string (or string element) |
| --- | --- | --- |
| `$contains` | a string, or a list meaning any of them | contains it |
| `$startsWith` | the same | starts with it |
| `$endsWith` | the same | ends with it |
| `$word` | the same | contains it as a whole component (below) |
| `$glob` | a glob, or a list of them | matches it as a whole (below) |
| `$regex` | an ECMAScript pattern, as a string | matches it |

A string operator never matches a value that is not a string: numbers are not converted.
An empty list matches nothing.

**`$word`** matches when the operand occurs in the string, and at each end of the occurrence
either the string ends or the characters on both sides of the boundary are not both letters or
digits. So `1.2.3` matches `1.2.3.4` and `1.2.3.0/24` but not `11.2.3.4`, and `1.2.3.4` does not
match `1.2.3.45`. An operand that itself ends in a separator, such as `203.0.113.`, chooses its
own boundary on that side. An empty operand matches nothing. "Letter" and "digit" are the
Unicode `L` and `N` categories.

**`$glob`** matches the **whole** value, not part of it. `*` stands for any run of characters
including none, `?` for exactly one character, and `\` escapes either of them or itself. There
are no character classes: `[a-z]` is those five characters. A glob needs no
regular-expression engine and cannot backtrack exponentially, so an implementation must keep
it available when patterns are turned off.

**`$regex`** uses ECMAScript regular-expression syntax. An implementation on another platform
must either use an ECMAScript-compatible engine or refuse patterns it cannot run faithfully;
it must not run them under a different dialect. A pattern that does not compile must be
refused.

### 5.5 `$options`

`$options` is a string of flags that changes the other operators in **the same condition**:

| Flag | Effect |
| --- | --- |
| `i` | `$eq`, `$ne`, `$in`, `$nin`, `$all`, the string operators and `$regex` ignore case |
| `m`, `s`, `u` | passed to `$regex` |

Any other flag must be refused — `g` and `y` in particular, which make an ECMAScript pattern
stateful. A condition whose `$options` has nothing to apply to must be refused, and `m`, `s` or
`u` without a `$regex` must be refused.

**Ignoring case** means comparing both sides after Unicode default lower-case mapping, with no
locale. It applies to **every string the operator compares**, including the strings inside a
list or an object being compared — `{ "$eq": ["A"], "$options": "i" }` matches `["a"]` — but
never to the *keys* of an object, which are field names rather than values. `$regex` with `i`
uses the regular-expression engine's own case folding.

### 5.6 Arrays and length

| Operator | Operand | Holds when a reached value |
| --- | --- | --- |
| `$size` | a non-negative integer, or a condition on one | is an array of that length |
| `$length` | the same | is an array of that many elements, or a string of that many UTF-16 code units |
| `$all` | a list of literals | contains each literal as an element (or equals it). An empty list matches nothing |
| `$elemMatch` | a query | is an array with at least one element that matches the whole query |

`$size` and `$length` are the only operators that are **not** tried against the elements of
an array: `{ "tags": { "$length": 1 } }` would otherwise mean both "one tag" and "a tag one
character long", and nothing in the query would say which. A string's length is counted in
UTF-16 code units, which is what JSON's own escape syntax is defined in, so a character
outside the basic plane counts as two.

`$elemMatch` takes a full query, so its operand may name fields of object elements
(`{ "name": "en", "level": { "$gte": 3 } }`) or be a condition on primitive elements
(`{ "$gte": 3, "$lt": 5 }`, see §6.2).

### 5.7 Arithmetic

| Operator | Operand | Holds when |
| --- | --- | --- |
| `$mod` | `[divisor, remainder]` | a reached number (or element) divided by `divisor` leaves `remainder`, with the sign of the dividend |

A divisor of zero must be refused. "Number" here means what it means in §5.3, so a big
integer is one; a divisor with a fraction cannot divide one, and no big integer matches it.

### 5.8 `$not` on a field

`$not` takes a **condition** and holds when that condition does not hold. `{ "score": { "$not":
{ "$gt": 50 } } }` matches a missing score. A literal operand must be refused; `$ne` is the way
to negate a value.

### 5.9 Comparing with another field

`{ "$field": "path" }` in place of a value compares the field with **another field of the same
item**:

```json
{ "bytesOut": { "$gt": { "$field": "bytesIn" } } }
{ "paidAt": { "$field": "refundedAt" } }
```

- It is accepted by `$eq`, `$ne` and the four ordering operators, and as a value on its own,
  which means `$eq`. Anywhere else — inside `$in`, `$all`, a literal object — it must be
  refused: a reference that was read as data would compare against the characters
  `{"$field":…}` and match nothing, silently.
- Both sides are reached by the rules of §3 and §4.1, so either may fan out over an array;
  the comparison holds when **some** pair of reached values satisfies it, and `$ne` when no
  pair does.
- **A reference that reaches nothing matches nothing.** A comparison with an absent field is
  not a comparison, and treating it as one would widen a filter exactly where the data is
  incomplete.
- Nothing is read as a date, and nothing is coerced. A `$date` in a query is the query saying
  what it means; a reference says only where to look, so `"5"` and `5` are still different.

It carries no expressions: a reference names a field and nothing else. There is deliberately
no arithmetic, no function, no stored code and no query operator that evaluates one. Every
operand in this language is data, which is what lets a query be stored, sent and checked
before it runs.

## 6. Query operators

### 6.1 Combining queries

| Operator | Operand | Holds when | Empty operand |
| --- | --- | --- | --- |
| `$and` | a list of queries | every one holds | matches everything |
| `$or` | a list of queries | at least one holds | matches nothing |
| `$nor` | a list of queries | none holds | matches everything |
| `$not` | a query | it does not hold | — |
| `$comment` | a string | always; it is carried and ignored | — |

A query operator inside a field condition (`{ "a": { "$or": … } }`) must be refused.

### 6.2 Conditions on the item itself

A field operator at the top level of a query is a condition on the **item itself**. It is what
lets a query filter a list of primitives:

```json
{ "$gte": 10, "$lt": 20 }
```

matches the numbers from 10 up to 20. Field paths and field operators may appear side by side;
each still has to hold.

### 6.3 `$text`

`$text` searches free text. Its operand is a phrase, or an object:

```json
{ "$text": "new york" }
{ "$text": { "$search": "Tor", "$fields": ["nick", "name"], "$caseSensitive": true } }
```

- The phrase is matched as a **substring** of **one value**, ignoring case unless
  `$caseSensitive` is `true`. Words are not split: `"new york"` does not match an item
  holding `york new`.
- Values are never joined before the phrase is matched against them, whether or not
  `$fields` names several. An item whose `method` is `GET` and whose `path` is `/api/v2`
  does not match the phrase `GET /api/v2`, because no single value holds it. A phrase that
  has to span two fields is a question about a value neither of them holds, and the way to
  ask it is to derive that value — a computed field that joins them, which is then one
  field like any other.
- Without `$fields`, every string anywhere in the item is searched, through objects and
  arrays. Keys are not searched.
- Numbers are searched too, in their shortest round-trip decimal form, when the phrase
  contains a digit.
- With `$fields`, only the values those paths reach are searched (and everything inside them).
- An empty phrase matches everything.
- `$fields` is checked whichever phrase stands beside it: a list that is not a non-empty list
  of field names must be refused even when the phrase is empty. Otherwise the same saved
  query is valid or not depending on how much of it somebody has typed.
- Any other key in the object must be refused.

An implementation must stop descending at a depth of its choosing (at least 8), so a cyclic
item cannot hang a search.

## 7. Dates

JSON has no date type, so a date is written `{ "$date": value }`, where `value` is one of:

| Value | Means |
| --- | --- |
| an ISO 8601 string | that instant |
| a number | that many milliseconds since the Unix epoch |
| `"now"` | the instant the query is compiled |
| `{ "$ago": "<duration>" }` | that long before it |
| `{ "$ahead": "<duration>" }` | that long after it |

A duration is one or more counts with a unit, in any order: `"90s"`, `"1h30m"`, `"7d"`. The
units are `ms`, `s`, `m`, `h`, `d` and `w`. Months and years are **not** units, because
neither has a fixed length and a window that changed size with the calendar is one nobody can
reason about. A `$date` that does not parse must be refused.

**Relative dates resolve once**, when the query is compiled, against an instant the caller may
supply. Resolving per comparison would let the window move while a scan was in progress, so
two items a second apart could be judged against different hours; and an implementation whose
"now" cannot be supplied cannot be tested, which is why the conformance suite gives an instant
with every relative case. A compiled query therefore keeps the instant it was compiled at:
compile it again to move the window.

When a query compares with a `$date` — as an ordering bound or as an equality literal — the
value in the item is **read as a date for that comparison**: a native date object, an ISO 8601
string or an epoch-milliseconds number. A value that does not read as a date does not match.
No value is ever read as a date unless the query said `$date`.

**Only ISO 8601**, with either `T` or a space before the time. What a host language's own date
parser accepts beyond that — `"12/31/2020"`, `"Mar 5 2021"`, a bare `"5"` — is its own
business, and a document that matched in one implementation and not another would make the
same query mean two things.

A date-only ISO string (`"2026-09-01"`) is midnight UTC, and so is a timestamp written
without an offset: `"2026-09-01T12:00:00"` means 12:00 **UTC**, not 12:00 wherever the process
happens to be running. JavaScript reads those two forms differently — the first as UTC and the
second as local time — which would make the same query and the same document answer one way in
Tokyo and another in London. A machine's location is not part of a query.

## 8. Requests

A request asks a whole question of a collection. It is an object with these keys, all optional;
any other key must be refused:

| Key | Meaning |
| --- | --- |
| `where` | a query; absent matches everything |
| `sort` | an object of field paths to directions (`1`, `-1`, `"asc"`, `"desc"`), in order of precedence |
| `skip` | how many matching items to pass over first; a non-negative integer, default 0 |
| `limit` | the most items to return; a non-negative integer, absent for all |
| `fields` | a list of paths to keep in each result; absent returns whole items |
| `omit` | a list of paths to drop from each result, applied after `fields` |

```json
{ "where": { "status": "open" }, "sort": { "total": -1, "id": 1 }, "limit": 20, "fields": ["id", "total"] }
```

The conformance suite covers requests as well as matching: its `requests` section gives each
request and the positions it must return, or — where the request projects — the objects
themselves.

### 8.1 Sort order

Values of different types sort in this fixed order, least first:

*missing* and `null` < numbers < strings < objects < booleans < dates

Numbers compare numerically, strings by UTF-16 code unit (not by locale), booleans `false`
before `true`, dates by instant. Objects compare equal to one another. A value that is a
number but not a numeric one — `NaN`, which JSON cannot carry but a document in memory can —
sorts with *missing* and `null`, because it has no place among the numbers: every comparison
with it is false.

A path reaching several values sorts by the **least** of them ascending and the **greatest**
descending, looking into arrays.

**The sort is stable:** items equal on every key keep the order they were given in. That is
what makes `skip` and `limit` page through a sorted result without repeating or dropping an
item.

### 8.2 Projection and redaction

`fields` keeps the named paths and drops everything else, in the item's own shape:
`"address.city"` returns `{ "address": { "city": … } }`. An array on the way is kept as an
array of its projected object elements; elements that are not objects are dropped.

`omit` removes the named paths from each result, through arrays as a path does, and applies
after `fields` — so `fields: ["request"]` with `omit: ["request.headers.cookie"]` keeps the
request without that header. A result with something dropped is a **copy**: a request is a
question, and a question must not edit what it is asked of.

A field is data whatever it is called. An implementation must carry a field named
`__proto__`, `constructor` or anything else its language treats specially as an ordinary
property of the result — writing it the way that language writes a field it does not trust. A missing path is left out. Naming a path and one of its
parents keeps the parent whole.

## 9. Refusals

An implementation must refuse, rather than evaluate, every query this page says must be
refused. A refusal must say what was wrong and where: the location is written the way the
value would be reached in code, with `.` between keys and `[n]` for list positions —
`$or[1].age.$gt`.

It must also refuse an unknown operator, at the top level or in a condition. Refusing is the
point: an operator that is ignored makes a query that looks restrictive and is not.

## 10. Limits

An implementation should also let a caller say **which operators** a query may use, and
refuse the rest by name. An endpoint that has no use for a whole-document text search or for
`$elemMatch` should be able to say so once, rather than discovering later which of them
somebody found.

An implementation may cap the size of a query it accepts — its depth, its number of operators,
the length of a pattern — and must refuse a query past its caps rather than truncate it. It
should document its caps. The reference implementation's defaults are a depth of 32, 10 000
fields and operators, 1 024 characters per pattern and 512 segments per path (§3), with a
stricter set for untrusted input that also turns `$regex` off.

## 11. Versions

This is version 1.1 of the language: 1.0 plus `$glob`, `$length`, `{ "$field": … }`, relative
dates and `omit`. Every query valid under 1.0 means the same thing under 1.1. Adding an
operator is a minor version, and a query valid under an earlier minor version means the same
thing under a later one. Changing what an existing query matches is a major version — as is
*narrowing* a case the specification left open, which is why the rule for a timestamp with no
offset (§7) had to be settled before 1.1 was published rather than after. The conformance
suite carries the version it tests.

## 12. Added operators

An implementation may let a project add operators of its own — an address-in-network test, a
domain-specific score — and a query using one is **not portable JQL**. To keep that visible
and to leave the language room to grow, an added operator's name must begin `$x` followed by a
capital: `$xCidr`. An engine that was not given the operator must refuse the query rather than
ignore the clause, and should say that the name is an addition it was not given.

No name beginning `$x` will ever be part of this specification.

## 13. Canonical form (optional)

Two queries can ask the same question and be written differently, which makes a list of saved
filters hold duplicates nobody can see. An implementation may offer a canonical form, and if
it does, these are the rules, so that two implementations agree on which filters are the same
one:

- Every field's value is written as a condition: `{ "a": 1 }` becomes `{ "a": { "$eq": 1 } }`.
- Object keys are sorted.
- `$comment` is dropped.
- `$and` within `$and`, and `$or` within `$or`, are flattened; a one-part `$and` or `$or` is
  replaced by that part **only when it is the whole query** (after `$comment` is dropped),
  since `{ "a": 1, "$or": [x] }` is not `x`. `$nor` is left as it is.
- A part of an `$and` is **lifted into the query beside it** when every key it holds is still
  free, so `{ "$and": [x, y] }` and `{ …x, …y }` — the same question, one written by a search
  box and one by a person — have one form. A part whose key is already taken stays in the
  `$and`: two conditions on one field cannot become one key, and merging them would change
  which operators an `$options` beside them reaches.
- `$in`, `$nin`, `$all`, `$fields` and a string operator's list are sets: sorted by their
  written form, with repeats removed. A one-name `$type` list becomes the name.
- **A value being compared with is not rewritten**, beyond sorting the keys of an object
  (which equality ignores anyway). It is data, not a query: rewritten as one, `{ "a": { "x":
  1 } }` would become a filter for a document holding `{ "x": { "$eq": 1 } }`.
- `$comment` is dropped before any of this, so it does not decide whether an operator is the
  whole query.
- `$options` flags are sorted; `$text` is written in its object form, with `$caseSensitive`
  present only when true.
- `{ "$date": … }` and `{ "$field": … }` are left as they are.

The canonical form is a query, and matches exactly what the query it was made from matches.
Rewriting a canonical query changes nothing. Equal forms mean the same query; **different
forms do not mean different answers** — `{ "$gt": 3 }` and `{ "$gte": 4 }` agree on every
integer, and no rewriting will notice.

## 14. Splitting a query

A query may be split between two engines — a store that can answer part of it, and an engine
that answers the rest — and the split is safe only along a **conjunction**:

- the keys of a query all have to hold, and so do the parts of an `$and`, so each one may be
  answered by either side;
- nothing else may be divided: a branch of an `$or`, or one operator of a condition, cannot
  be separated from the rest without changing what is asked.

For any such split,

> `pushed` ∧ `remaining` ≡ the query

and neither part is ever **narrower** than the query, so an engine that answers only the
pushed part returns too many items rather than too few.

A relative date must be resolved before it is handed to another engine: `{ "$ago": "1h" }`
means nothing to a store, and both halves of a split must be judged against one instant.

## Related

- [Text syntax](text-syntax.md) — the search-box form, which compiles into this
- [Library API](api.md) — the TypeScript implementation
- [Design decisions](../design/decisions.md) — why the language is shaped this way
