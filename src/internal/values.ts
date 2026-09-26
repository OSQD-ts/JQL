import { parseDuration } from "./duration.js";
import type { DateLiteral, FieldReference, TypeName } from "../types.js";

/** An object literal or a JSON-parsed object: what a query document is made of. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `{ $date: … }` and nothing else. */
export function isDateLiteral(value: unknown): value is DateLiteral {
  if (!isPlainObject(value) || !("$date" in value)) return false;
  for (const key in value) if (key !== "$date") return false;
  return true;
}

/** `{ $field: "path" }` and nothing else: a comparison with another field of the same item. */
export function isFieldReference(value: unknown): value is FieldReference {
  if (!isPlainObject(value) || typeof value.$field !== "string") return false;
  for (const key in value) if (key !== "$field") return false;
  return true;
}

/**
 * The instant a `$date` literal stands for, in epoch milliseconds, or `NaN`.
 *
 * `now` is passed in rather than read here, because a query holding `{ "$ago": "1h" }` has
 * to resolve against one instant for the whole run: reading the clock per comparison would
 * let the window move while a scan is in progress, so two items a second apart could be
 * judged against different hours. It is also what makes a relative filter testable without
 * waiting.
 */
export function resolveDate(value: unknown, now: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value === "now" ? now : instant(value);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1) return Number.NaN;
    const amount = keys[0] === "$ago" || keys[0] === "$ahead" ? value[keys[0] as string] : undefined;
    if (typeof amount !== "string") return Number.NaN;
    const span = parseDuration(amount);
    if (span === undefined) return Number.NaN;
    return keys[0] === "$ago" ? now - span : now + span;
  }
  return Number.NaN;
}

/**
 * A document value read as a date, in epoch milliseconds, or `NaN`.
 *
 * Only called where the query supplied a `$date`, so a string is only ever parsed as a
 * date because somebody asked for that. `NaN` compares false with everything, which is
 * what a value that is not a date should do.
 */
/**
 * The forms of a date a document may hold, per the specification: a `Date`, epoch
 * milliseconds, or an **ISO 8601** string.
 *
 * `Date.parse` accepts a great deal more than that — `"12/31/2020"`, `"Mar 5 2021"`, and
 * `"5"`, which it reads as a year — and what it accepts beyond ISO 8601 is left to the
 * implementation by the language it comes from. A document that matched here and nowhere
 * else would make the same query mean different things in different engines, which is the
 * one thing this language promises it does not do. The space instead of `T` is allowed
 * because RFC 3339 allows it and people write it.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A timestamp with a time and no offset, which is the one shape whose meaning is not fixed. */
const NO_OFFSET = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;

/**
 * An instant from a string, read the same way on every machine.
 *
 * JavaScript reads a date-only string as midnight **UTC** and a timestamp with no offset as
 * **local time** — so `"2026-01-01T12:00:00"` was a different instant in Tokyo and in London,
 * and a query and a document that both held one answered differently depending on where the
 * process happened to be running. That is the failure the language already rules out for
 * `"12/31/2020"`: the same query meaning two things. A missing offset is UTC here, which is
 * the rule the date-only form already follows.
 */
export function instant(text: string): number {
  const bare = NO_OFFSET.exec(text);
  return bare === null ? Date.parse(text) : Date.parse(`${bare[1] as string}T${bare[2] as string}Z`);
}

export function toTime(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return ISO_8601.test(value) ? instant(value) : Number.NaN;
  return Number.NaN;
}

/** The type names `$type` knows, in one list, so the error for a wrong one can offer the right one. */
export const TYPE_NAMES: readonly TypeName[] = ["string", "number", "integer", "bigint", "boolean", "null", "array", "object", "date"];

/** Whether a document value is of the named type. A missing value is of no type. */
export function isOfType(value: unknown, type: TypeName): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      // A big integer is a number for ordering, so it is one here too: `$gt` and `$type`
      // disagreeing about the same value is a distinction nobody could explain.
      return typeof value === "number" || typeof value === "bigint";
    case "integer":
      return Number.isInteger(value) || typeof value === "bigint";
    case "bigint":
      return typeof value === "bigint";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "date":
      return value instanceof Date;
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
  }
}

/**
 * A readable name for a value in an error sentence.
 *
 * Specific about what it was given, because "a query is an object, not an object" — which
 * is what a `Map`, a `Set` and a class instance all used to produce — tells the reader
 * nothing at all about the thing they passed.
 */
export function describe(value: unknown): string {
  if (value === null) return "null";
  // Named rather than written out: `String(fn)` is the function's entire source, and a
  // closure of any size turned the sentence refusing it into a listing.
  if (typeof value === "function") return "a function";
  if (Array.isArray(value)) return "an array";
  if (value instanceof RegExp) return "a RegExp object";
  if (value instanceof Date) return "a Date object";
  if (value instanceof Map) return "a Map";
  if (value instanceof Set) return "a Set";
  if (typeof value === "object") {
    if (isPlainObject(value)) return "an object";
    const name = nameOf(value);
    return name === undefined ? "an object" : `an instance of ${name}`;
  }
  if (typeof value === "string") return `the string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value)}`;
  return `${typeof value} ${String(value)}`;
}

/** The class an object came from, when it can be read without running anything of the caller's. */
function nameOf(value: object): string | undefined {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null;
  // Read from the prototype rather than through the object, so a `constructor` field of
  // the caller's own — which a document or a query read from JSON can have — is not what
  // names it.
  const name = prototype?.constructor?.name;
  return typeof name === "string" && name !== "" && name !== "Object" ? name : undefined;
}
