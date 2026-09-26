import { JqlError } from "../errors.js";
import { isDateLiteral, isPlainObject, resolveDate } from "../internal/values.js";
import { compileGlobPattern } from "../internal/glob.js";
import type { Capabilities } from "../plan.js";
import type { TypeName } from "../types.js";
import type { Vocabulary } from "../vocabulary.js";

/**
 * JQL as a MongoDB filter.
 *
 * The first target, because it is the one where the two languages nearly agree: most of
 * JQL's operators *are* MongoDB's, with the same array semantics, so the translation is
 * mostly a copy and the interesting part is the handful that differ.
 *
 * The translation is checked by *running* it, not by comparing its shape: `tests/helpers/mongo.ts`
 * is a second reading of MongoDB's matching rules, taken from its documented behaviour rather
 * than from this engine, and the split test runs both halves of every generated query through
 * it and through the engine and compares the answers.
 *
 * That check found the one difference no capability can express: **an array held directly
 * inside another array**. A path segment in MongoDB applies to an array's elements but not to
 * the elements of *those* arrays; JQL sees an array through at every level. Which rows come
 * back then differs, in either direction, and nothing in the query says so — the shape is in
 * the data. It is written down in specification §3 and in the pushdown guide, because a
 * caller with such a collection must not read `complete` as permission to skip the second
 * pass.
 *
 * What it will not do is guess. Every operator MongoDB cannot answer exactly —
 * `$word`, `$length`, a `{ "$field": … }` reference, `$text` — is left out of
 * `MONGO_CAPABILITIES`, so `plan()` keeps those clauses here and this function never sees
 * them. A translation that was *nearly* right would be the worst of both: fewer rows than
 * the query asked for, from a store that looked like it had answered.
 */

/**
 * What a MongoDB `find` filter can answer, in JQL's own names.
 *
 * Give it to `plan()` and it splits a query into the filter to send and the predicate to
 * apply to what comes back.
 */
export const MONGO_CAPABILITIES: Capabilities = Object.freeze({
  fields: "all",
  operators: Object.freeze([
    "$eq",
    "$ne",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
    "$in",
    "$nin",
    "$exists",
    "$type",
    "$regex",
    "$options",
    "$mod",
    "$size",
    "$all",
    "$elemMatch",
    "$not",
    // Translated to anchored, escaped patterns, which MongoDB runs exactly as JQL does.
    "$contains",
    "$startsWith",
    "$endsWith",
    "$glob",
  ]),
  or: true,
  not: true,
  accepts: (_field: string, condition: Readonly<Record<string, unknown>>) => pushable(condition),
});

/** Whether MongoDB answers this condition **exactly**, which some of its operators do only for some values. */
function pushable(condition: Readonly<Record<string, unknown>>): boolean {
  const flags = typeof condition.$options === "string" ? condition.$options : "";
  for (const [key, operand] of Object.entries(condition)) {
    switch (key) {
      case "$eq":
      case "$ne":
      case "$in":
      case "$nin":
      case "$all": {
        for (const value of Array.isArray(operand) && key !== "$eq" && key !== "$ne" ? operand : [operand]) {
          // JQL compares objects without regard to key order; MongoDB's embedded-document
          // equality is a byte comparison, so `{ c: 2, b: 1 }` is not `{ b: 1, c: 2 }` there.
          if (composite(value)) return false;
          // Ignoring case reaches the strings inside a list. A pattern can stand in for one
          // string, and for nothing deeper.
          if (flags.includes("i") && typeof value !== "string") return false;
        }
        break;
      }
      case "$type": {
        // JQL's `integer` is "a number with no fractional part"; MongoDB's `int`/`long` are
        // storage types, so a whole number held as a double is one and not the other.
        // `bigint` is worse: it names a run-time type JSON cannot carry at all, and what a
        // driver hands back for a stored `long` is usually an ordinary number — so the store
        // would answer with rows this engine says are not bigints, and `complete` would say
        // no second pass was needed. Both stay here.
        const names = Array.isArray(operand) ? operand : [operand];
        if (names.includes("integer") || names.includes("bigint")) return false;
        break;
      }
      case "$regex":
        // MongoDB takes `i`, `m`, `s` and `x`; JQL's `u` is not one it knows, and a filter
        // it refuses does not run at all.
        if ([...flags].some((flag) => !"ims".includes(flag))) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/** A value MongoDB compares byte for byte, where JQL compares it by its keys. */
function composite(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(composite);
  return isPlainObject(value) && !isDateLiteral(value);
}

export interface MongoOptions {
  /**
   * Resolves a vocabulary's names and aliases to the paths the collection stores.
   *
   * Only needed for a query that did not come from `plan()`: what `plan` pushes already
   * carries the stored names.
   */
  readonly vocabulary?: Vocabulary<never, object> | undefined;
  /** Where "now" comes from, for a relative date. Default the system clock, read once. */
  readonly now?: (() => number) | undefined;
}

/** A MongoDB filter document. Values may be `Date` and `RegExp` objects, which a driver expects. */
export type MongoFilter = Record<string, unknown>;

/**
 * Translates a JQL query into a MongoDB filter.
 *
 * Give it only what `plan(query, MONGO_CAPABILITIES)` pushed. Anything else is refused by
 * name rather than approximated.
 */
export function toMongoFilter(query: unknown, options: MongoOptions = {}): MongoFilter {
  const now = options.now === undefined ? Date.now() : options.now();
  return translateQuery(query, { vocabulary: options.vocabulary, now }, "");
}

interface Translating {
  readonly vocabulary: Vocabulary<never, object> | undefined;
  readonly now: number;
}

function translateQuery(query: unknown, context: Translating, at: string): MongoFilter {
  if (!isPlainObject(query)) throw new JqlError(`a query is an object, not ${typeof query}`, at);
  const parts: MongoFilter[] = [];
  for (const [key, value] of Object.entries(query)) {
    const here = at === "" ? key : `${at}.${key}`;
    switch (key) {
      case "$comment":
        break;
      case "$and":
      case "$or":
      case "$nor": {
        if (!Array.isArray(value)) throw new JqlError(`${key} takes a list of queries`, here);
        parts.push({ [key]: value.map((part, index) => translateQuery(part, context, `${here}[${index}]`)) });
        break;
      }
      case "$not":
        // MongoDB has no `$not` over a whole query; `$nor` of one is exactly it.
        parts.push({ $nor: [translateQuery(value, context, here)] });
        break;
      default: {
        if (key.startsWith("$")) throw new JqlError(`"${key}" has no MongoDB filter of its own; plan() keeps it out of what is pushed`, here);
        parts.push(translateField(key, value, context, here));
      }
    }
  }
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0] as MongoFilter;
  // Merged where the keys do not collide, and `$and` where they do — the same filter either
  // way, and the merged one is what somebody reading the query in a shell would have written.
  const merged: MongoFilter = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      if (key in merged) return { $and: parts };
      merged[key] = value;
    }
  }
  return merged;
}

function translateField(name: string, value: unknown, context: Translating, at: string): MongoFilter {
  const field = context.vocabulary?.lookup.get(name.toLowerCase());
  if (field?.get !== undefined) throw new JqlError(`"${name}" is computed here, so MongoDB has no such field`, at);
  const path = field?.path ?? name;
  if (!isPlainObject(value) || isDateLiteral(value)) return { [path]: literal(value, context, at) };
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => key.startsWith("$"))) return { [path]: literal(value, context, at) };

  const flags = typeof value.$options === "string" ? value.$options : "";
  const ignoreCase = flags.includes("i");
  const condition: Record<string, unknown> = {};
  const beside: MongoFilter[] = [];
  for (const key of keys) {
    if (key === "$options" || key === "$comment") continue;
    const operand = value[key];
    const here = `${at}.${key}`;
    switch (key) {
      case "$eq":
      case "$ne": {
        if (ignoreCase && typeof operand === "string") {
          // A bare pattern, not `{ $eq: /…/ }`. MongoDB documents the bare form as a match
          // against the pattern, while `$eq` with a regular expression is a comparison with
          // the regex *value* as often as it is a match — and a translation that rests on
          // which reading a server takes is one that returns the wrong rows on the servers
          // that take the other. `$nor` negates it without the same question.
          const match = { [path]: anchored(quoteLiteral(operand), flags, here) };
          beside.push(key === "$eq" ? match : { $nor: [match] });
          break;
        }
        condition[key] = literal(operand, context, here);
        break;
      }
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte":
        condition[key] = literal(operand, context, here);
        break;
      case "$in":
      case "$nin": {
        if (!Array.isArray(operand)) throw new JqlError(`${key} takes a list`, here);
        const members = operand.map((item) => (ignoreCase && typeof item === "string" ? anchored(quoteLiteral(item), flags, here) : literal(item, context, here)));
        // `$in` takes patterns; `$nin` with one is less clearly documented, so its
        // case-insensitive form is written as the negation of an `$in`, which is.
        if (key === "$nin" && ignoreCase && members.some((member) => member instanceof RegExp)) beside.push({ $nor: [{ [path]: { $in: members } }] });
        else condition[key] = members;
        break;
      }
      case "$all": {
        if (!Array.isArray(operand)) throw new JqlError("$all takes a list", here);
        condition[key] = operand.map((item) => literal(item, context, here));
        break;
      }
      case "$exists":
      case "$mod":
      case "$size":
        condition[key] = operand;
        break;
      case "$type":
        condition[key] = mongoTypes(operand, here);
        break;
      case "$regex":
        condition.$regex = operand;
        // Only the flags MongoDB takes; `plan` keeps back the ones it does not, and this is
        // the second lock on the same door.
        if (keep(flags, here) !== "") condition.$options = keep(flags, here);
        break;
      case "$contains":
      case "$startsWith":
      case "$endsWith":
      case "$glob": {
        const patterns = (Array.isArray(operand) ? operand : [operand]).map((item) => {
          if (typeof item !== "string") throw new JqlError(`${key} takes strings`, here);
          return pattern(key, item, flags, here);
        });
        // A list means "any of these", which MongoDB spells `$in` over the patterns.
        if (patterns.length === 1) beside.push({ [path]: patterns[0] as RegExp });
        else beside.push({ [path]: { $in: patterns } });
        break;
      }
      case "$elemMatch":
        condition.$elemMatch = translateQuery(operand, context, here);
        break;
      case "$not": {
        if (!isPlainObject(operand)) throw new JqlError("$not takes a condition", here);
        // MongoDB's field-level `$not` refuses some of what JQL allows inside it, and
        // `$nor` of the same clause is exactly the same question with none of the rules.
        beside.push({ $nor: [translateField(name, operand, context, here)] });
        break;
      }
      default:
        throw new JqlError(`"${key}" has no MongoDB filter of its own; plan() keeps it out of what is pushed`, here);
    }
  }
  const written: MongoFilter[] = [];
  if (Object.keys(condition).length > 0) written.push({ [path]: condition });
  written.push(...beside);
  if (written.length === 1) return written[0] as MongoFilter;
  return { $and: written };
}

/** A JQL literal as MongoDB would hold it: a date literal becomes a `Date`. */
function literal(value: unknown, context: Translating, at: string): unknown {
  if (isDateLiteral(value)) {
    const time = resolveDate(value.$date, context.now);
    if (Number.isNaN(time)) throw new JqlError(`${JSON.stringify(value.$date)} is not a date`, at);
    return new Date(time);
  }
  if (Array.isArray(value)) return value.map((item) => literal(item, context, at));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, held] of Object.entries(value)) out[key] = literal(held, context, at);
    return out;
  }
  return value;
}

/** JQL's type names, in MongoDB's. */
const TYPES: Readonly<Record<TypeName, readonly string[]>> = {
  string: ["string"],
  number: ["double", "int", "long", "decimal"],
  integer: ["int", "long"],
  bigint: ["long"],
  boolean: ["bool"],
  null: ["null"],
  array: ["array"],
  object: ["object"],
  date: ["date"],
};

function mongoTypes(operand: unknown, at: string): string[] {
  const names = Array.isArray(operand) ? operand : [operand];
  const out: string[] = [];
  for (const name of names) {
    const mapped = TYPES[name as TypeName];
    if (mapped === undefined) throw new JqlError(`${JSON.stringify(name)} is not a type name`, at);
    for (const alias of mapped) if (!out.includes(alias)) out.push(alias);
  }
  return out;
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

function quoteLiteral(text: string): string {
  return text.replace(SPECIAL, "\\$&");
}

function anchored(body: string, flags: string, at: string): RegExp {
  return new RegExp(`^${body}$`, keep(flags, at));
}

/**
 * The flags MongoDB takes on a pattern, and only those.
 *
 * A refusal rather than a filter: `plan` keeps a clause with any other flag here, so
 * reaching this at all means `toMongoFilter` was handed something `plan` did not push. Both
 * of the other answers are worse than saying so — dropping the flag changes what the pattern
 * means, and passing it on gives the server a filter it refuses outright, so the query fails
 * later and somewhere else.
 */
function keep(flags: string, at: string): string {
  for (const flag of flags) {
    if (!"ims".includes(flag)) throw new JqlError(`MongoDB has no "${flag}" flag on a pattern; plan() keeps a clause carrying one here rather than pushing it`, at);
  }
  return flags;
}

function pattern(operator: string, value: string, flags: string, at: string): RegExp {
  switch (operator) {
    case "$contains":
      return new RegExp(quoteLiteral(value), keep(flags, at));
    case "$startsWith":
      return new RegExp(`^${quoteLiteral(value)}`, keep(flags, at));
    case "$endsWith":
      return new RegExp(`${quoteLiteral(value)}$`, keep(flags, at));
    default:
      return new RegExp(`^${compileGlobPattern(value, quoteLiteral)}$`, keep(flags, at));
  }
}
