import { compile, type CompileOptions } from "./core.js";
import { isDateLiteral, isFieldReference, isPlainObject } from "./internal/values.js";
import type { QueryLike, UntypedQuery } from "./types.js";

/**
 * One shape per meaning, so two queries that ask the same thing look the same.
 *
 * Saved filters arrive written in whatever way somebody typed them: `{ a: 1 }` and
 * `{ a: { $eq: 1 } }`, `{ $and: [x, y] }` and `{ ...x, ...y }`, the same keys in a
 * different order. Storing them raw means a list of "saved filters" with three copies of
 * one filter in it, and a cache that misses on every one of them.
 *
 * `canonical` rewrites a query into a fixed form, and `fingerprint` names that form in
 * sixteen characters. The rewritten query is still a query, and matches exactly what the
 * original matched — a property the tests hold it to on random queries.
 *
 * What it does **not** do is decide whether two queries are equivalent in general. That
 * question has no cheap answer: `{ $gt: 3 }` and `{ $gte: 4 }` agree on every integer and
 * disagree on 3.5, and nothing here will notice. Equal fingerprints mean the same query;
 * different fingerprints mean only that the queries are written differently.
 */

/** Operators whose list of values is a set: order and repetition change nothing. */
const SETS = new Set(["$in", "$nin", "$all", "$contains", "$startsWith", "$endsWith", "$word", "$glob"]);

/** Operators whose operand is a query rather than a value. */
const QUERIES = new Set(["$elemMatch"]);
/** Operators whose list is a set of queries. */
const LOGIC = new Set(["$and", "$or", "$nor"]);

/**
 * The canonical form of a query.
 *
 * Refuses anything that is not a valid query, because a canonical form of nonsense would
 * be nonsense somebody had stored deliberately.
 */
export function canonical<T, Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): UntypedQuery {
  if (typeof query === "function") throw new TypeError("a compiled predicate has no canonical form: it is code, not a query");
  compile(query, options);
  return rewrite(query) as UntypedQuery;
}

/**
 * A short, stable name for a query's canonical form.
 *
 * For cache keys, for telling two saved filters apart, and for noticing that the filter
 * somebody is saving is one they already have. Not a cryptographic hash: it is a
 * 64-bit checksum written as hex, so two different queries can collide — rarely, and never
 * in a way that matters for a cache you can miss.
 */
export function fingerprint<T, Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): string {
  return checksum(JSON.stringify(canonical(query, options)) ?? "");
}

function rewrite(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  if (isDateLiteral(value) || isFieldReference(value)) return value;
  const out: Record<string, unknown> = {};
  // `$comment` is dropped below, so it does not count towards "is this operator the whole
  // query?" either. Counting it kept `{ $and: [x], $comment: "why" }` wrapped on the first
  // pass and unwrapped it on the second, so a canonical query was not settled.
  const keys = Object.keys(value)
    .sort()
    .filter((key) => key !== "$comment");
  // `{ $or: [x] }` is `x`, but only when the `$or` is the whole query. Unwrapping it while
  // it had siblings returned `x` for the entire object and threw the siblings away, so
  // `{ "a": 1, "$or": [x] }` canonicalised to `x` — a saved filter quietly missing a
  // constraint, and two different queries with one fingerprint.
  const alone = keys.length === 1;
  // Keys in one order, so the serialised form of two queries that say the same thing is
  // the same string.
  for (const key of keys) {
    const held = value[key];
    if (LOGIC.has(key) && Array.isArray(held)) {
      const parts = flatten(key, held).map(rewrite).sort(byText);
      // `$and` and `$or` of one part are that part; `$nor` of one is not, so it stays.
      if (parts.length === 1 && key !== "$nor" && alone) return parts[0];
      out[key] = parts;
      continue;
    }
    if (key === "$not") {
      out[key] = rewrite(held);
      continue;
    }
    if (key === "$text") {
      out[key] = text(held);
      continue;
    }
    if (key.startsWith("$")) {
      out[key] = operand(key, held);
      continue;
    }
    out[key] = condition(held);
  }
  return fold(out);
}

/**
 * `{ "$and": [x, y] }` and `{ …x, …y }` are the same filter, so they get the same form.
 *
 * This is the everyday case rather than a curiosity: the search box writes the first — every
 * multi-term search compiles to an `$and` — and a person writing JSON writes the second. Left
 * apart, the same question saved from the box and from the API had two names, which is the
 * duplicate this module exists to prevent.
 *
 * Only a part whose keys are still free can be lifted. Two conditions on one field cannot
 * become one key, and merging them would be wrong even if JSON allowed it: `$options` applies
 * to every case-aware operator beside it, so folding `{ "$eq": "X", "$options": "i" }` and
 * `{ "$contains": "y" }` together would quietly make the second ignore case too. Those parts
 * stay in the `$and`, which keeps the form idempotent — running it again lifts nothing new.
 */
function fold(out: Record<string, unknown>): Record<string, unknown> {
  const parts = out.$and;
  if (!Array.isArray(parts) || parts.length === 0) return out;
  const taken = new Set(Object.keys(out).filter((key) => key !== "$and"));
  const lifted: Record<string, unknown> = {};
  const kept: unknown[] = [];
  for (const part of parts) {
    const keys = isPlainObject(part) ? Object.keys(part) : undefined;
    if (keys === undefined || keys.length === 0 || keys.some((key) => taken.has(key))) {
      kept.push(part);
      continue;
    }
    for (const key of keys) {
      taken.add(key);
      lifted[key] = (part as Record<string, unknown>)[key];
    }
  }
  if (Object.keys(lifted).length === 0) return out;
  const merged: Record<string, unknown> = { ...lifted };
  for (const [key, value] of Object.entries(out)) if (key !== "$and") merged[key] = value;
  if (kept.length > 0) merged.$and = kept;
  // Keys in one order again, now that there are more of them.
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key];
  return sorted;
}

/** A field's value, always as a condition: `{ a: 1 }` and `{ a: { $eq: 1 } }` are one query. */
function condition(value: unknown): unknown {
  if (isPlainObject(value) && !isDateLiteral(value) && !isFieldReference(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => key.startsWith("$"))) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = key === "$not" ? condition(value[key]) : operand(key, value[key]);
    return out;
  }
  return { $eq: literal(value) };
}

function operand(key: string, value: unknown): unknown {
  if (SETS.has(key) && Array.isArray(value)) return unique(value.map(literal));
  if (QUERIES.has(key)) return rewrite(value);
  if (key === "$type" && Array.isArray(value)) {
    const types = unique(value);
    return types.length === 1 ? types[0] : types;
  }
  // `$options: "iu"` and `"ui"` are the same flags.
  if (key === "$options" && typeof value === "string") return [...value].sort().join("");
  // A condition on a length is a condition; anything else here is a value.
  if ((key === "$size" || key === "$length") && isPlainObject(value)) return condition(value);
  return literal(value);
}

/**
 * A value being compared with, rewritten only in ways that cannot change what it equals.
 *
 * Keys are sorted, because JQL compares objects without regard to key order, so two filters
 * written with the keys the other way round are one filter. Nothing else is touched — and in
 * particular a literal is **not** walked as a query. Run through the query rewriter,
 * `{ a: { x: 1 } }` became `{ a: { $eq: { x: { $eq: 1 } } } }`: a filter for a document
 * holding `{ x: 1 }` turned into a filter for one holding `{ x: { $eq: 1 } }`, which is a
 * different question with the same fingerprint.
 */
function literal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(literal);
  if (!isPlainObject(value) || isDateLiteral(value) || isFieldReference(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = literal(value[key]);
  return out;
}

function text(value: unknown): unknown {
  const search = typeof value === "string" ? { $search: value } : isPlainObject(value) ? value : undefined;
  if (search === undefined) return value;
  const out: Record<string, unknown> = { $search: search.$search };
  // A list of fields is a set, like `$in`; searching two fields is the same question in
  // either order.
  if (Array.isArray(search.$fields)) out.$fields = unique(search.$fields);
  if (search.$caseSensitive === true) out.$caseSensitive = true;
  return out;
}

/** `$and` inside `$and` is one `$and`; the same for `$or`. Not for `$nor`, which does not nest that way. */
function flatten(key: string, parts: readonly unknown[]): unknown[] {
  if (key === "$nor") return [...parts];
  const out: unknown[] = [];
  for (const part of parts) {
    const inner = isPlainObject(part) && Object.keys(part).length === 1 ? part[key] : undefined;
    if (Array.isArray(inner)) out.push(...flatten(key, inner));
    else out.push(part);
  }
  return out;
}

function byText(a: unknown, b: unknown): number {
  const left = JSON.stringify(a) ?? "";
  const right = JSON.stringify(b) ?? "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(values: readonly unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const value of values) {
    const written = JSON.stringify(value) ?? String(value);
    if (!seen.has(written)) seen.set(written, value);
  }
  return [...seen.values()].sort(byText);
}

/**
 * A 64-bit checksum as sixteen hex characters: two FNV-1a passes with different offsets.
 *
 * No dependency, no `node:crypto` — this has to run in a browser as well — and nothing
 * here is a security claim. It only needs to be stable across processes and versions,
 * which a fixed arithmetic over a fixed string is.
 */
function checksum(text: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return low.toString(16).padStart(8, "0") + high.toString(16).padStart(8, "0");
}
