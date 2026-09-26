# Changelog

## [Unreleased]

### Added

- **The JSON Query Language, version 1.1.** A specification in `docs/reference/specification.md`
  and a conformance suite in `conformance/cases.json` of 156 matching cases and 27 request
  cases that any implementation, in any language, must pass. The operator names are the
  conventional ones, and the array rules are written out in full rather than left to a
  reader's memory of another system. 1.1 is 1.0 plus `$glob`, `$length`, `{ "$field": … }`, relative dates and `omit`;
  since nothing has been released yet, both arrive together here.
- **An engine that compiles each query once into closures.** Within about 1.1–1.5× of a
  hand-written loop for most queries, with no code generation, so it runs under any
  Content-Security-Policy.
- **Collection helpers** — `find`, `filter`, `count`, `some`, `every`, `partition`, `findIndex`,
  `filterMap`, `filterRecord`, `findEntry` — over arrays, array-likes, iterables, `Map`s by value
  and plain objects.
- **`search`**, which runs a whole request — `where`, `sort`, `skip`, `limit`, `fields` — with a
  bounded heap for top-k and an early exit for unsorted pages.
- **Typed queries.** `Query<T>` checks paths five levels deep, through arrays, and offers each
  operator only where it fits.
- **`validate` returns the predicate it compiled**, so a service checks and runs one query
  rather than compiling twice — and cannot check against the untrusted limits and then run
  without them.
- **`@osqd/jql/global`**, which adds `jqlSearch`, `jqlFilter` and the rest to `Array`, `Map` and
  `Set`, with their types, only when imported.
- **Vocabularies** of named, aliased and computed fields, shared by the engine and the text
  syntax.
- **`@osqd/jql/text`**, BotHandler's feed-filter syntax, compiling into JQL documents, with
  numeric ranges, `>=` and `<=`, date comparisons, boolean fields, `has:field` and signed
  durations (`at:>-1h`) added.
- **Comparing one field with another**, written `{ "bytesOut": { "$gt": { "$field": "bytesIn" } } }`.
  A reference is a path, not an expression, so a query holding one still stores, travels and
  validates like any other — and unlike `$expr`, it brings no expression language with it.
- **`$glob`** — `*`, `?` and `\` — for the pattern people mean when they reach for one. It
  needs no regular-expression engine, cannot backtrack exponentially, and stays available
  when `$regex` is turned off for untrusted callers.
- **`$length`**, for the length of a string (UTF-16 code units) or an array, so a cap on an
  incoming value no longer needs a pattern to express.
- **Relative dates.** `{ "$date": { "$ago": "1h" } }`, `{ "$ahead": … }` and `"now"`, resolved
  once when the query compiles against a clock the caller may supply. A saved filter that
  means "the last hour" goes on meaning it.
- **`omit` in a request**, applied after `fields`, so a server's redaction is data like the
  rest of the request. Results are copies; the items are never touched.
- **`group`**, which counts the matches by a field — what every dashboard in this family was
  writing for itself, with the three awkward questions (an item with two values, items with
  none, and the order of the groups) answered once.
- **`explain`**, which says why one item does or does not match, clause by clause, with the
  values it read. It runs the real engine on each clause, so an explanation cannot disagree
  with the filter it explains.
- **`canonical` and `fingerprint`**, one shape and one short name per meaning, for storing
  saved filters without duplicates and for cache keys.
- **Asynchronous sources** — `findAsync`, `filterAsync`, `countAsync`, `someAsync`,
  `everyAsync`, `filterStream` and `searchAsync` — for a log read line by line or a cursor
  over a store. They stop reading as soon as the answer cannot change, so an endless source
  still answers "the first twenty matches".
- **Operators a project can add**, named `$x…` so a query that needs more than a standard
  engine says so, and refused by name when the engine was not given them.
- **An operator allowlist.** `limits.allowOperators` names what a query may use, so an
  endpoint that has no use for `$text` or `$elemMatch` says so once rather than finding out
  later which of them somebody used. A name in the list that is not an operator is refused
  too: an allowlist with a typo in it would allow nothing while looking like it allowed
  something.
- **`toText`**, the reverse of the search-box syntax, for a dashboard that stores filters as
  JSON and has to put one back in the box. Deliberately not total: it returns the text *and*
  what it could not say, because showing only the sayable half would show a filter wider than
  the one running.
- **`plan(query, capabilities)`**, which splits a query into the part a store can answer and
  the part that stays here, with `pushed ∧ remaining ≡ query` as the contract, and
  **`@osqd/jql/mongo`** as the first target. Operators MongoDB cannot answer exactly are left
  out of its capabilities, so they are never approximated.
- **`jql`, a command**, for filtering JSON lines from a shell: `jql --text 'status:open'
  app.jsonl`. stdout is the artifact and stderr is the conversation, `--limit all` is an
  error rather than a limit that stops limiting, and it is built from the package's own
  exports.
- **A course**: sixteen lessons in `docs/course/`, building one order desk from a first query
  to a filter behind a public endpoint — the language, typed queries, requests, grouping,
  explanations, vocabularies, the search box both ways, untrusted input, saved filters,
  streams and the command line, store pushdown, and operators of your own. Every checkpoint in
  it was produced by running the code, and `check:package` runs all fifteen runnable lessons
  against the packed tarball so they cannot drift from what the library does. Writing it found
  two defects, both listed below.

### Fixed

- **A path longer than 64 segments matched but was left out of the result.** The engine
  followed a path to any depth while `fields` walked its own tree and stopped at sixty-four,
  silently, so a request could match an item on `a.b.c…` and hand back a copy without it —
  one name meaning two things inside one request. Matching, sorting, projection and redaction
  now share one limit of 512 segments (specification §3), and a longer path is refused rather
  than half-applied. A field name is also the one part of a query the operator count does not
  bound, so the cap bounds it.
- **A refusal quoted the whole field name back.** A location is built from the query's own
  names, so a long one buried the sentence explaining it; the message now shortens it, while
  `JqlError.at` still carries the whole path for a program to read.
- **`toText` turned the narrowest query in the language into the widest.** `{ "$not": {} }`
  matches nothing, the empty query matches everything, and a negation holding nothing sayable
  was written as no text at all — which reads back as the empty query — while reporting
  `complete: true`. It is reported now, like the `$or` of nothing it mirrors.

- **`--group` accepted five options and then dropped them.** `--sort`, `--skip`, `--fields`,
  `--omit` and `--count` were read and never looked at again, because the grouping path
  builds its own answer: `jql --group status --fields id` printed exactly what
  `jql --group status` printed, with nothing to say the option had gone nowhere. They are
  refused now, and `--limit` — the one that has an obvious meaning beside groups — says how
  many groups to print.
- **A vocabulary that was not one crashed with a `TypeError` from inside the engine.**
  `defineVocabulary` is curried, so the empty parentheses are easy to forget, and a
  definition looks enough like a vocabulary to pass by eye; either arrived as "Cannot read
  properties of undefined (reading 'get')". It is refused by name now, which also means
  `validate` answers with a verdict rather than re-throwing, and `parseText` refuses the
  mistake in the code rather than failing later on the text.
- **The MongoDB target dropped a pattern flag it could not use and pushed `$type: "bigint"`.**
  `keep` filtered out the flags MongoDB does not take while calling itself the lock that
  stops them, and a dropped flag is a different pattern; `bigint` names a run-time type JSON
  cannot carry, so the store answered with rows the engine says are not bigints while
  `complete` said no second pass was needed.
- **A text search checked its `$fields` only when the phrase was not empty.** So
  `{ "$search": "", "$fields": 42 }` compiled, and a dashboard that validated its saved
  filter while the search box was empty was told it was a good one — until somebody typed a
  letter and the same filter was refused. Whether a query is valid cannot depend on how much
  of it has been typed (specification §6.3).
- **The MongoDB target was the one rewriting checked by its shape rather than by its
  answers.** Its tests asserted what the filter looked like, which cannot catch a filter that
  is *nearly* right — the failure the module exists to avoid. It is now run against a second
  reading of MongoDB's matching rules, written from that database's documented behaviour, over
  generated queries and documents. The first thing that found: **an array held directly inside
  another array** is traversed by JQL at every level and by MongoDB only one level down, so
  the two answer differently in either direction and no capability can say so, because the
  shape is in the data rather than in the query. Written down in specification §11, in the
  pushdown guide and beside the code.
- **The same filter had two names depending on who wrote it.** `canonical` promised that
  `{ "$and": [x, y] }` and `{ …x, …y }` are one filter and did not deliver it, so a search
  typed into the box — which compiles to an `$and` for every multi-term query — and the same
  filter written as JSON by hand were saved as two, with two fingerprints, which is the
  duplicate the whole module exists to prevent. A part of an `$and` is now lifted beside its
  siblings when every key it holds is free; one whose field is already spoken for stays put,
  because merging two conditions on one field would change which operators an `$options`
  beside them reaches. **This changes the fingerprint of any filter written with a top-level
  `$and`** — stored keys of that shape are invalidated, and the rule is in specification §14.
  Found while writing the course.
- **`group` left a row out of the tally when its value was an empty list.** Every other value
  that cannot name a group — a missing field, a `null`, an object — already shared `null`, and
  an empty array fell through both: counting by a tag quietly omitted every untagged row, so
  the numbers above a table did not add up to the number of rows in it and nothing said which
  had gone. It was also inconsistent with the same shape met *on the way* down a path, which
  had always counted as `null`. Found while writing the course.
- **A timestamp with no offset meant a different instant on every machine.** JavaScript reads
  a date-only string as midnight UTC and `"2026-01-01T12:00:00"` as *local* time, so the same
  query over the same document answered one way in Tokyo and another in London — the failure
  the language already rules out for `"12/31/2020"`, reached by a shape that looks entirely
  ordinary. A missing offset is UTC now, on both sides of a comparison, which is the rule the
  date-only form already followed (specification §7). Three conformance cases pin it: they
  pass in every zone with the fix and fail in Tokyo without it.
- **TypeScript told every CommonJS consumer the package could not be required.** It ships a
  `.cjs` build for each entry that has one, and `require("@osqd/jql")` works — but a single
  `types` condition pointed at declarations that `"type": "module"` marks as an ES module, so
  under `node16` resolution a CommonJS project got `TS1479` on every import of a package it
  could actually load. The declarations are now published twice, the second copy under
  `dist/cjs` with a `package.json` saying what it is, and each `exports` entry carries the
  `types` for its own condition. `check:package` type-checks a consumer both ways round, which
  is what would have caught it.
- **The subpath entries could not be found under the legacy TypeScript resolution.**
  `moduleResolution: "node"` ignores the `exports` map, so `@osqd/jql/text`, `/global`,
  `/mongo` and `/cli` had no declarations for a project still on that setting, although Node
  itself loads them either way. A `typesVersions` map points each one at its declarations;
  `check:package` now type-checks a consumer under all four resolutions a real project uses —
  `node16` as an ES module and as CommonJS, a bundler's, and the legacy one.
- **A projected request was typed as whole items.** `search(rows, { fields: ["id"] })` returns
  new objects holding only those paths, and said it returned `Row[]`: the overload's
  intersection asked for `readonly string[]` where `Request` says `readonly FieldName<T>[]`,
  and with `T` inferred from the source the two could not agree, so the candidate was dropped
  and the plain overload answered. The same for `omit`, on `search`, `searchAsync` and the
  `jqlQuery` methods — where it hid for longer, because `Row[]` *is* assignable to
  `Partial<Row>[]`, so the obvious assertion passed either way.
- **`node dist/cli.js` did nothing while carrying a shebang that said it would.** The file is
  the module behind `@osqd/jql/cli`; `bin/jql.mjs` is the executable.
- **`jql` rewrote the lines it was asked to filter.** Each match was re-serialised rather
  than written back out, so `jql '{}' file.jsonl > copy.jsonl` did not reproduce the file:
  `1e400` came back as `null` and a thirty-digit identifier as `1.2345678901234568e+29`, both
  silently. A matching line is now written byte for byte as it arrived; asking for it to be
  reshaped or laid out again is asking for something other than the line, and that is still
  written as JSON.
- **A leading byte-order mark cost a file its first record.** It is what a Windows editor and
  a PowerShell redirect put at the front of a UTF-8 file; it made the first line "not JSON,
  skipped" while every other line came through. It is dropped now.
- **The conformance suite had no case for `omit`.** The suite is the language as data — what
  another implementation checks itself against — and every part of a request had cases except
  the one that drops fields, which is the part a server redacts with. Six cases now cover the
  rules in §8.2: what it drops, through an array, that it applies after `fields`, that a path
  the item does not have drops nothing, and the refusal.
- **`$in` held its values in one set with both kinds of number in it**, which measured 1.17×
  the cost of a set of plain numbers — paid by every `$in` ever written, to serve a kind of
  value almost no document holds. The big integers have a set of their own now, consulted
  only after the first has said no.
- **A big integer was equal to no number a query could write.** Ordering put `10n` and `10`
  in the same place and `$type` called both numbers, while `$eq` compared the two kinds with
  `===` and said no — so one document was at once `$gte: 10`, `$lte: 10` and `$ne: 10`, which
  nothing can be, and the types pointed straight at it by offering `number` as the literal
  for such a field. Equality, `$in`, `$nin`, `$all` and `{ "$field": … }` now treat a big
  integer as the number it is (specification §5.1.1). JSON has no big integer, so no portable
  query changes meaning.
- **`$mod` matched nothing against a big integer.** The specification defines it over "a
  reached number", and a big integer is one there — `%` refuses to mix the two kinds in
  JavaScript, so the operator quietly answered false for every such value. The types offered
  it on those fields too, and now do.
- **`jqlQuery` typed a request with `omit` as whole items.** `search` has always said
  `Partial<T>` for one; the methods on `Array` carried only the `fields` overload, so the
  compiler promised fields the result no longer had.
- **An error quoted a whole function back.** A function where a value belongs is refused, and
  `String(fn)` is its entire source, so the sentence refusing it was a listing.

- **The text parser could produce a query that would not run.** `score:1e309` became
  `{ "$eq": Infinity }`, which the engine refuses and `JSON.stringify` turns into `null`, so
  a search box could hand somebody a filter that could neither run nor be saved; the same for
  a duration too large to size (`at:>-99999999999999999999d`), and `-0` did not survive being
  written out. All three are now values that match nothing, which is what an unreadable value
  means everywhere else in the box. Found by the parser fuzzer, which is now part of the
  suite.
