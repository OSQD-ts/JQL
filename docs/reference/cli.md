# The command

`jql` — filtering JSON lines from a shell.

← [Documentation](../index.md) · [Reference](index.md)

---

The shape this library is for arrives as one JSON value per line — a log, an export, a
`kubectl` dump — more often than it arrives as an array in a program. The command is the
same engine over a stream, and everything it does is a public export used the way the
documentation says to use it.

```sh
npx jql '{"status":"open"}' orders.jsonl
jql --text 'status:open total:>100' orders.jsonl
kubectl logs -f app | jql --text 'level:error' --fields ts,msg
```

## Usage

```
jql [options] <query> [file...]
```

`<query>` is a JQL query as JSON, or the [search-box syntax](text-syntax.md) with `--text`.
Files hold one JSON value per line; with none, or with `-`, it reads standard input.

| Option | Does |
| --- | --- |
| `--text` | read the query as search-box text rather than JSON |
| `--sort <field:order>` | order by a field, `asc` or `desc`; repeatable, the first key breaks ties last |
| `--skip <n>` / `--limit <n>` | pass over the first n matches / stop after n |
| `--fields <a,b>` | keep only these paths in each result |
| `--omit <a,b>` | drop these paths from each result |
| `--count` | print how many matched instead of the matches |
| `--group <field>` | print how many matched by that field, largest first; `--limit` then says how many groups, and `--sort`, `--skip`, `--fields`, `--omit` and `--count` are refused rather than ignored |
| `--explain` | say on stderr why the first line did or did not match |
| `--canonical` | print the query in its canonical form and stop |
| `--untrusted` | compile with the untrusted limits: `$regex` off, tighter caps |
| `--pretty` | print each result over several lines |
| `-h, --help` / `-v, --version` | |

Both `--name value` and `--name=value` work.

## The two rules it is built on

**stdout is the artifact.** Matching lines and nothing else, so `jql … > kept.jsonl`
produces a file worth having. Counts, warnings and explanations go to stderr.

A matching line is written back **byte for byte as it arrived** — spacing, key order and all
— so filtering a file cannot change the data in it. That matters for numbers JavaScript
cannot hold exactly: a thirty-digit identifier read and written again comes back as
`1.2345678901234568e+29`, and `1e400` comes back as `null`. Asking for the result to be
reshaped (`--fields`, `--omit`, `--group`) or laid out again (`--pretty`) is asking for
something other than the line, and then it is written out as JSON. A leading byte-order mark
is dropped rather than treated as data.

**A value is validated, never coerced.** `--limit all` is an error, not a limit that quietly
stops limiting — `Number("all")` is `NaN`, every comparison against it is false, and the
failure would be silent in both directions. An option that cannot apply is refused for the
same reason: `--group` prints groups, so `--fields` beside it is an error rather than a flag
that goes nowhere.

**Everything streams except `--group`.** A filter, a sort with a limit and a count all read
one line at a time and hold only the page they are building, so a file larger than memory is
fine. Counting by a field is the exception: a group's total is not known until the last line,
so the matching items are held while the tally is built.

## Exit codes

| Code | Means |
| --- | --- |
| 0 | it ran; no matches is an answer, not a failure |
| 1 | a file could not be read, or nothing in the input was JSON |
| 2 | bad arguments, or a query the engine refuses |

A line that is not JSON is reported on stderr and skipped; the lines around it are still
answered. If *every* line was unreadable, that is a failure rather than an empty result.

## Examples

```sh
# the ten slowest requests, as a table of two fields
jql --text 'path:/api' --sort durationMs:desc --limit 10 --fields path,durationMs access.jsonl

# how many of each verdict, for what the query matched
jql --group verdict '{"score":{"$gte":70}}' feed.jsonl

# why a line is not matching the filter you thought it would
jql --explain --text 'status:open total:>500' orders.jsonl > /dev/null

# a filter from somewhere you do not trust
jql --untrusted "$UNTRUSTED_QUERY" events.jsonl

# a redacted copy
jql --omit customer.email,customer.phone '{}' orders.jsonl > shareable.jsonl
```

## Related

- [Text syntax](text-syntax.md) — what `--text` takes
- [Library API](api.md) — the exports the command is built from
