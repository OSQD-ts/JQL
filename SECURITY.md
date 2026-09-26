# Security

## Reporting

Report a vulnerability privately to Michał Płatosz <platosz.michal@gmail.com> rather than in a
public issue. Say what you found, how to reproduce it, and what it lets somebody do.

## Supported versions

The latest release. Fixes are not backported while the package is at 0.x.

## What this is, in security terms

JQL evaluates queries that may come from people you do not trust. What it promises:

- **A query cannot run code.** It is JSON; there is no `$where`, no function, nothing evaluated.
- **A query reads only an item's own fields.** `constructor`, `__proto__` and inherited members
  are unreachable, and nothing a query does writes anywhere.
- **Its cost is bounded by limits you choose.** Depth, size, pattern length and glob length are
  capped, and a query past a cap is refused, never truncated. `UNTRUSTED_LIMITS` also turns
  `$regex` off. A field name is capped too, at 512 path segments — it is the one part of a
  query the operator count does not bound, since a path of any length is a single field.
- **What a caller may ask is a list you write.** `limits.allowOperators` names the operators a
  query may use, and anything outside it is refused by name — so an endpoint that has no use
  for a whole-document `$text` search or for `$elemMatch` says so once, rather than finding
  out later which of them somebody used.
- **The text parser never throws on what somebody types**, and caps its input and bracket
  depth, so a hostile link cannot break the page that opens it. (A vocabulary that is not one
  is refused by name — that is a mistake in the calling code, not in the box.)

What it is not:

- **Not a defence against a pattern you allowed.** With `$regex` on, a pattern can backtrack
  for as long as the input lets it. Turn patterns off for queries from outside — see
  [Queries from outside](docs/guides/untrusted-input.md).
- **Not an access-control layer.** A query can reach every field of every item it is run over.
  Filter what a caller may see before running their query, or give them a strict vocabulary.
- **Not a bound on the request.** A `$in` of a million values is valid; cap the body where you
  read it.
