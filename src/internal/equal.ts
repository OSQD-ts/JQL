import { isDateLiteral, isPlainObject, resolveDate, toTime } from "./values.js";

/**
 * Equality between a document value and a query literal.
 *
 * Built once per literal rather than called generically, because the literal is known at
 * compile time and the document value is the only thing that changes: a primitive
 * literal becomes one `===`, and only an object or array literal pays for a walk.
 *
 * The rules, which the specification states and every implementation must share:
 * objects are equal when they have the same keys with equal values, **in any order**
 * (JSON does not promise key order, so a comparison that depended on it would depend on
 * whoever serialised the query); a key whose value is `undefined` counts as absent;
 * arrays are equal element by element, in order; a `$date` literal equals any value that
 * reads as the same instant.
 */
export type Equals = (value: unknown) => boolean;

/** Whether a big integer and an ordinary number are the same whole number. */
function sameInteger(a: unknown, b: unknown): boolean {
  const big = typeof a === "bigint" ? a : typeof b === "bigint" ? b : undefined;
  const other = typeof a === "bigint" ? b : a;
  if (big === undefined) return false;
  if (typeof other === "bigint") return big === other;
  return typeof other === "number" && Number.isInteger(other) && big === BigInt(other);
}

/** How deep an object literal comparison walks. Past this the two are treated as different. */
const MAX_EQUAL_DEPTH = 64;

/**
 * The same whole number as a big integer, when a literal is one and could be written either
 * way.
 *
 * Settled once, when the query compiles, so the comparison stays a single `===` against a
 * value prepared in advance. Only a whole number gets one: nothing is a big integer and a
 * fraction, and a string or a boolean can never be one either.
 */
export function alsoBig(literal: unknown): bigint | undefined {
  return typeof literal === "number" && Number.isInteger(literal) ? BigInt(literal) : undefined;
}

export function equalsLiteral(literal: unknown, now: number, ignoreCase = false): Equals {
  if (literal === null) return (value) => value === null;
  if (typeof literal !== "object") {
    if (ignoreCase && typeof literal === "string") {
      const wanted = literal.toLowerCase();
      return (value) => typeof value === "string" && value.toLowerCase() === wanted;
    }
    // A big integer is a number everywhere else in the language: ordering puts `10n` and
    // `10` in the same place, `$type` calls both numbers. Equality alone compared the two
    // kinds with `===` and said no — so a document holding `10n` was at once `$gte: 10`,
    // `$lte: 10` and `$ne: 10`, which is not a thing any value can be. A query cannot carry
    // a big integer of its own (JSON has none, and one is refused), so a number is the only
    // way to ask about such a value at all.
    const big = alsoBig(literal);
    if (big !== undefined) return (value) => value === literal || value === big;
    return (value) => value === literal;
  }
  if (isDateLiteral(literal)) {
    const time = resolveDate(literal.$date, now);
    return (value) => toTime(value) === time;
  }
  return (value) => deepEqual(value, literal, 0, ignoreCase, now);
}

/**
 * Equality between two values that both came out of a document, for `$field` references.
 *
 * The same rules as equality with a literal — same type, arrays in order, objects in any
 * key order — but neither side is known when the query compiles, so nothing can be
 * prepared. Missing is not equal to anything, including itself: a reference that reaches
 * nothing matches nothing.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    const left = toTime(a);
    const right = toTime(b);
    return a instanceof Date && b instanceof Date && left === right && !Number.isNaN(left);
  }
  return deepEqual(a, b, 0);
}

function deepEqual(actual: unknown, wanted: unknown, depth: number, ignoreCase = false, now = 0): boolean {
  if (actual === wanted) return true;
  // The two kinds of number, one level down — and on both sides, because `valuesEqual`
  // brings two document values here and either of them may be the big one.
  if (typeof actual === "bigint" || typeof wanted === "bigint") return sameInteger(actual, wanted);
  if (actual instanceof Date && wanted instanceof Date) return actual.getTime() === wanted.getTime();
  if (depth > MAX_EQUAL_DEPTH) return false;
  // Ignoring case is a rule about comparing strings, so it holds wherever a string is
  // compared — including the ones inside a list or an object. Applied only to the literal's
  // own top level, `{ $eq: "A", $options: "i" }` matched `"a"` while `{ $eq: ["A"], … }` did
  // not match `["a"]`, and nothing said why.
  if (ignoreCase && typeof actual === "string" && typeof wanted === "string") return actual.toLowerCase() === wanted.toLowerCase();
  if (wanted === null || typeof wanted !== "object") return false;
  // `resolveDate`, not `toTime`: a `{ "$ago": … }` or `"now"` nested inside a list or an
  // object was read by a function that knows neither, came out `NaN`, and quietly matched
  // nothing — while the same literal written on its own worked.
  if (isDateLiteral(wanted)) return toTime(actual) === resolveDate(wanted.$date, now);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(wanted)) {
    if (!Array.isArray(actual) || actual.length !== wanted.length) return false;
    for (let i = 0; i < wanted.length; i++) if (!deepEqual(actual[i], wanted[i], depth + 1, ignoreCase, now)) return false;
    return true;
  }
  if (Array.isArray(actual) || !isPlainObject(wanted)) return false;
  if (actual instanceof Map) {
    let size = 0;
    for (const key in wanted) {
      const expected = wanted[key];
      if (expected === undefined) continue;
      size++;
      if (!actual.has(key) || !deepEqual(actual.get(key), expected, depth + 1, ignoreCase, now)) return false;
    }
    let present = 0;
    for (const value of actual.values()) if (value !== undefined) present++;
    return present === size;
  }
  const record = actual as Record<string, unknown>;
  let size = 0;
  for (const key in wanted) {
    const expected = wanted[key];
    if (expected === undefined) continue;
    size++;
    if (!Object.hasOwn(record, key) || !deepEqual(record[key], expected, depth + 1, ignoreCase, now)) return false;
  }
  let present = 0;
  for (const key in record) if (Object.hasOwn(record, key) && record[key] !== undefined) present++;
  return present === size;
}
