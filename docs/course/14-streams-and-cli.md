# Lesson 14 — Logs and streams

**Goal:** run a query over something that arrives over time, and over a file, from a shell.

← [Course](index.md) · Previous: [Saved filters](13-saved-filters.md) · Next: [Pushing into a store](15-pushdown.md)

---

## Data that arrives over time

Harbour exports its order book nightly as JSON lines. That is the shape most real data arrives
in — a log, a `kubectl` dump, a store's export — and by the time it matters it is too big to
hold in memory.

The asynchronous helpers are the same engine with an `await` in the loop. The query is
compiled once, before the first item, and **they stop reading as soon as the answer cannot
change** — which is what makes a source that never ends answerable at all.

First, write the export:

```bash
node -e "import('./orders.mjs').then(({orders}) => require('node:fs').writeFileSync('orders.jsonl', orders.map(o => JSON.stringify(o)).join('\n') + '\n'))"
```

Then save this as `harbour/exported.mjs`, so the examples can read it back a line at a time:

```js
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Every line of the nightly export, parsed, as it arrives. */
export async function* exported() {
  const reader = createInterface({
    input: createReadStream("orders.jsonl", "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of reader) if (line.trim() !== "") yield JSON.parse(line);
}
```

## Asking a source the usual questions

```js
import { countAsync, findAsync, someAsync } from "@osqd/jql";
import { exported } from "./exported.mjs";

console.log("the first open one:", (await findAsync(exported(), { status: "open" })).id);
console.log("how many paid     :", await countAsync(exported(), { status: "paid" }));
console.log("anything over £200:", await someAsync(exported(), { total: { $gt: 200 } }));
```

```
the first open one: o-1002
how many paid     : 4
anything over £200: true
```

Same names as lesson 1, same queries, `await` in front. `findAsync` and `someAsync` stop at
the first match — the rest of the file is never read.

## A page from a stream

```js
import { searchAsync } from "@osqd/jql";
import { exported } from "./exported.mjs";

const page = await searchAsync(exported(), {
  where: { status: { $ne: "cancelled" } },
  sort: { total: -1 },
  limit: 2,
  fields: ["id", "total"],
});

console.log(page);
```

```
[ { id: 'o-1005', total: 170 }, { id: 'o-1004', total: 36 } ]
```

## A stream you can walk away from

```js
import { filterStream } from "@osqd/jql";
import { exported } from "./exported.mjs";

for await (const order of filterStream(exported(), { "customer.country": "GB" })) {
  console.log(order.id, order.customer.name);
  if (order.id === "o-1003") break;
}

console.log("stopped early, and the file stopped being read");
```

```
o-1001 Ada Lovelace
o-1003 Alan Turing
stopped early, and the file stopped being read
```

`filterStream` yields matches as it finds them. Stop consuming and the source stops being
pulled — which is the whole point of the next example.

## A source that never ends

```js
import { filterStream } from "@osqd/jql";

/** A feed with no end, like a socket or a tail. */
async function* forever() {
  for (let i = 0; ; i++) yield { id: i, status: i % 3 === 0 ? "open" : "paid" };
}

const pulled = [];
for await (const item of filterStream(forever(), { status: "open" })) {
  pulled.push(item.id);
  if (pulled.length === 3) break;
}

console.log(pulled);
```

```
[ 0, 3, 6 ]
```

That program terminates. Nothing pulls from `forever()` once the loop breaks, so an endless
feed is an ordinary source as long as the question has a stopping point.

## What stops early, and what cannot

| | |
| --- | --- |
| `findAsync`, `someAsync` | stop at the first match |
| `filterStream` | yields as it goes; stop consuming and the source stops |
| `searchAsync` **without** a sort | stops once the page is full |
| `searchAsync` **with** a sort | reads everything — it has to — but holds only `skip + limit` items while it does |

That last row is the one that surprises people, and it is worth being explicit: an order over
items you have not seen yet is not an order. A sorted page needs the whole source. What it
does *not* need is the whole source in memory, and the bounded heap from lesson 7 keeps only
the page you asked for.

## The same thing from a shell

The library ships the command that does all this over a file, which is often quicker than
writing the script:

```bash
jql '{"status":"open"}' orders.jsonl | head -1
```

```
{"id":"o-1002","placed":"2026-09-03T14:02:00Z","status":"open","channel":"web","customer":{"name":"Grace Hopper","country":"US","email":"grace@example.com"},"lines":[{"sku":"pad-a5","title":"A5 pad","quantity":10,"price":3}],"total":30,"paid":0,"tags":[]}
```

```bash
jql --count '{"customer.country":"GB"}' orders.jsonl
```

```
3
```

```bash
jql --text 'status:paid total:>20' --sort total:desc --fields id,total orders.jsonl
```

```
{"id":"o-1006","total":33}
{"id":"o-1001","total":22.5}
```

```bash
jql --group status '{}' orders.jsonl
```

```
{"key":"paid","count":4}
{"key":"open","count":2}
{"key":"cancelled","count":1}
{"key":"refunded","count":1}
```

```bash
cat orders.jsonl | jql --text 'customer.country:gb' --fields id,customer.name -
```

```
{"id":"o-1001","customer":{"name":"Ada Lovelace"}}
{"id":"o-1003","customer":{"name":"Alan Turing"}}
{"id":"o-1005","customer":{"name":"Tim Berners-Lee"}}
```

Two rules shape the command, and both are worth copying into tools of your own.

### stdout is the artifact

Matching lines and nothing else, so `jql … > kept.jsonl` produces a file worth having. Counts,
warnings and explanations go to stderr, which is why `--explain` combines with anything:

```bash
jql --explain --count '{"status":"paid"}' orders.jsonl
```

```
4
```

— on stdout, with the explanation beside it on stderr.

A matching line is written back **exactly as it arrived**, byte for byte, so filtering a file
cannot change the data in it. That is not fussiness: re-serialising turns a thirty-digit
identifier into `1.2345678901234568e+29`, and `1e400` into `null`, silently. Ask for the
result to be reshaped — `--fields`, `--omit`, `--group`, `--pretty` — and you get JSON,
because then you have asked for something other than the line.

### A value is validated, never coerced

`--limit all` is an error rather than a limit that quietly stops limiting, and a query that is
not JQL is refused with the reason and exit code 2:

```bash
jql '{"total":{"$gtt":1}}' orders.jsonl; echo "exit $?"
```

```
jql: at total.$gtt: "$gtt" is not an operator; did you mean "$gt"?
exit 2
```

Note what `--text` did in the examples above: `customer.country:gb` uses the **storage path**,
because there is no vocabulary on the command line to translate a short name. Everything in
lesson 10 still applies in your own code; the command is the generic tool.

## Exercise

Find the three largest unpaid orders in the export, printing only the id and the total, from
the shell alone.

<details>
<summary>Answer</summary>

```bash
jql '{"paid":0}' --sort total:desc --limit 3 --fields id,total orders.jsonl
```

```
{"id":"o-1007","total":280}
{"id":"o-1005","total":170}
{"id":"o-1004","total":36}
```

Now try the spelling you probably reached for first:

```bash
jql --text 'paid:0' --sort total:desc --limit 3 --fields id,total orders.jsonl
```

```
```

Nothing at all. **There is no vocabulary on the command line**, so every field is `text` — and
`paid:0` becomes `{ paid: { $contains: "0", $options: "i" } }`, which asks whether a *string*
contains a zero. `paid` holds a number, and `$contains` does not match numbers.

That is the argument for lesson 10 in a single line. A `kind` is what turns `paid:0` into a
comparison; without one the text syntax can only guess from the shape of what was typed, and
it guesses conservatively rather than coercing. On the command line, prefer JSON for anything
that is not prose.
</details>

## Related

- [The command](../reference/cli.md) — every option, the exit codes, the two rules
- [Library API](../reference/api.md) — the `*Async` helpers
