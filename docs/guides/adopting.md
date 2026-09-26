# Adopting JQL in a project

How a project in this family moves its filtering onto JQL.

← [Documentation](../index.md)

---

JQL exists so that every project here filters data the same way: one language for a
dashboard's search box, a service's query parameter, a saved filter and an export. Moving a
project onto it has three parts.

## 1. Write the vocabulary

The vocabulary is the one place that says what the project's data is called. BotHandler's feed
filter, for instance, becomes:

```ts
const ENTRY_VOCABULARY = defineVocabulary<DashboardEntry>()({
  fields: {
    path: { aliases: ["url"] },
    actor: { aliases: ["ip"], kind: "word", get: (entry) => withLabel(entry.actor) },
    ua: { path: "userAgent", aliases: ["useragent", "agent"] },
    verdict: { kind: "exact", values: ["confirmed-bot", "verified-bot", "suspected-bot", "human", "unknown"] },
    class: { path: "botClass", aliases: ["botclass"] },
    action: {},
    outcome: { get: outcome, kind: "exact", values: ["allow", "mitigate", "deny", "pending"] },
    rule: {},
    detector: { get: (entry) => entry.evidence.map((item) => item.detector) },
    identity: {},
    method: { kind: "exact" },
    certain: { kind: "boolean" },
    bypass: {},
    id: { path: "requestId", aliases: ["request"], kind: "word" },
    score: { kind: "number" },
  },
  text: ["method", "path", "actor", "ua", "verdict", "class", "identity", "action", "rule", "id"],
});
```

Computed fields (`outcome`, `detector`, an actor's name given after the fact) are `get`
functions, looked up when the query runs — which is what lets a name given to an actor reach
requests that arrived before it was given.

## 2. Swap the matcher

Where the project parsed text and matched it itself:

```ts
const filter = parseFilter(input);
rows.filter((row) => matches(filter, row, searchableText(row), labelOf(row.actor)));
```

it now parses into JQL and compiles:

```ts
const test = compile(parseText(input, { vocabulary: ENTRY_VOCABULARY }), { vocabulary: ENTRY_VOCABULARY });
rows.filter(test);
```

The text syntax is BotHandler's, and `tests/text.test.ts` in this repository is BotHandler's
feed-search suite run through JQL, so the answers are the same.

## 3. Take JSON wherever text was the only option

Anything that accepted a filter as text — an export endpoint, a saved filter, a URL — can now
also accept the JSON document. Store the JSON rather than the text when you can: the text is
for people typing, the JSON is what the query *is*, and a stored JSON query survives a change
to the text syntax.

## What to test

- Port the project's own filter cases and run them through `compile(parseText(…))`.
- Keep a case per computed field, because those are the ones the project wrote itself.
- If the project has a service that receives queries, test that an invalid one is answered
  with a 400 and the refusal's sentence, not a 500.

## Related

- [Text syntax](../reference/text-syntax.md) — what people can type
- [TypeScript](typescript.md#vocabularies) — vocabularies in full
