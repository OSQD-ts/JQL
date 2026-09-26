# Contributing

## Scripts

| Script | Does |
| --- | --- |
| `npm run check` | typecheck, lint, test and the link check, in that order — run before a pull request |
| `npm run typecheck` | `tsc` over the source, the tests, the examples and the scripts |
| `npm run lint` / `npm run format` | Biome, linter only |
| `npm test` | Vitest, including the conformance suite and the example run as a process |
| `npm run docs:check` | every local markdown link and anchor resolves |
| `npm run build` | tsup for ESM and CJS, `tsc` for declarations |
| `npm run check:package` | pack, install into an empty project, import and require every entry, type-check a consumer under each of the four resolutions a real project uses, and run every lesson of the course against its printed checkpoint |
| `npm run bench` | the performance report, JQL beside hand-written loops |
| `npm run bench:guard` | fails if a case got materially slower |
| `npm run example` | runs `examples/basic.ts` |
| `npm run cli` | the `jql` command from source, for trying it without building |

The package supports Node >= 20 and, for the types, TypeScript >= 5.4, because the
declarations use `NoInfer` — the thing that keeps a vocabulary's field names from being
inferred from the query instead of from the vocabulary. Dropping below 5.4 means writing a
`NoInfer` of our own and exporting it, which is a name in the public surface; say so in the
changelog if that trade is ever made.

Installing with the npm that ships with some Linux distributions (9.2) fails with
`Cannot read properties of null (reading 'edgesOut')`; `npm install --legacy-peer-deps` works
around that bug in npm itself.

## Layout

```
src/
  types.ts          the query shapes, typed; the specification in TypeScript
  core.ts           compile: validation, field resolution, conditions, combinators
  operators.ts      what each field operator means, as a test on one value
  collections.ts    find, filter, count and the rest, over every kind of collection
  search.ts         requests: sort, skip, limit, fields; the bounded heap
  vocabulary.ts     named, aliased and computed fields
  limits.ts         the caps, and the untrusted set
  errors.ts         JqlError
  array.ts          install / uninstall of the built-in methods
  global.ts         the side-effect entry: installs them and declares their types
  text/             the search-box syntax: parse.ts, suggest.ts
  internal/         path resolution, equality, sort order, "did you mean"
conformance/        the language's test suite, as JSON, for any implementation
tests/              one suite per module, plus conformance, differential, fuzz, examples, entry points
  helpers/          the seeded generators every generated suite shares
  corpus/           the checked-in inputs the text fuzzer starts from
docs/               one page per question, plus `course/`: sixteen lessons over one example
scripts/            bench, bench guard, package check, link check, the CommonJS declarations
```

## Adding an operator

1. Say what it means in `docs/reference/specification.md`, including what it does on an array,
   on a missing field, and what makes it refuse its operand.
2. Add cases to `conformance/cases.json`: matches, non-matches, and each refusal.
3. Write its test in `operators.ts`, wire it into `conditionParts` in `core.ts`, add it to
   `FIELD_OPERATORS`, and give it a place in `Condition<V>` in `types.ts`.
4. Add it to `tests/helpers/generate.ts` and to the reference in `tests/differential.test.ts`.
   Every generated suite draws from that one place — the engine against a naive reference,
   the split, the canonical form, the explanation, the text writer, the grouping tally and the
   asynchronous helpers — so an operator added there is checked by all of them. Several of the
   bugs found so far were in shapes no hand-written list held.
5. Note it under `[Unreleased]` in `CHANGELOG.md`. A new operator is a minor version of the
   language.

## Rules that keep it honest

- **Refuse, never ignore.** Anything the engine does not understand is a `JqlError` naming where
  it is. A silently ignored part of a query is a filter that looks applied and is not.
- **The text parser never throws.** It runs on every keystroke.
- **Every fast path is checked against the reference** in `tests/differential.test.ts`, and
  every rewriting — the canonical form, the text writer, the store split — is checked by
  running the rewritten query and comparing answers, never by comparing shapes.
- **No runtime dependencies**, and nothing that needs `new Function`.
- **A change to what an existing query matches is a major version of the language**, and needs
  the specification, the conformance suite and the changelog changed together.

## Commits

Conventional prefixes with a scope (`feat(text):`, `fix(core):`, `docs(spec):`), lowercase
subjects that say what changed, and a body that says what was wrong and what happens now. No
attribution trailers. Documentation lands in the same commit as the behaviour.

## Licensing

JQL is released under the OSQD Non-Resale License by its single copyright holder, Michał
Płatosz. A contribution is made under the same license.
