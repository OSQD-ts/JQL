import { JqlError } from "./errors.js";
import { alsoBig, equalsLiteral, type Equals } from "./internal/equal.js";
import { compileGlob } from "./internal/glob.js";
import { DURATION_UNITS } from "./internal/duration.js";
import { describe, isDateLiteral, isFieldReference, isOfType, isPlainObject, resolveDate, TYPE_NAMES, toTime } from "./internal/values.js";
import { didYouMean } from "./internal/closest.js";
import type { TypeName } from "./types.js";

/**
 * What each field operator means, as a test on one value.
 *
 * Every builder here runs once, when a query is compiled, and returns the smallest
 * closure that answers its question: the operand is validated, normalised and, where it
 * helps, turned into a `Set` or a lower-cased copy before any document is seen. The
 * returned test only ever does the part that depends on the document.
 *
 * None of these knows about arrays or paths. Whether a test is also tried against each
 * element of an array, and how a field is reached, is `core.ts`'s business — so each
 * operator's meaning is written exactly once.
 */
export type Test = (value: unknown) => boolean;

export const NEVER: Test = () => false;

/** Lower-cases the way the specification defines "ignoring case": Unicode default case mapping, no locale. */
function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * Equality with one literal.
 *
 * `null` also matches a missing field, because "has no value" is what
 * people mean by it far more often than "has the value null". `$exists` is there for
 * the times the difference matters.
 */
export function equalsTest(literal: unknown, ignoreCase: boolean, at: string, now: number): Test {
  checkLiteral(literal, at);
  if (literal === null) return (value) => value === null || value === undefined;
  return equalsLiteral(literal, now, ignoreCase);
}

/** Membership. A `Set` for the primitives, and a walk only for the object and array literals. */
export function inTest(list: unknown, ignoreCase: boolean, at: string, now: number): Test {
  if (!Array.isArray(list)) throw new JqlError(`takes a list of values, not ${describe(list)}`, at);
  if (list.length === 0) return NEVER;
  const primitives = new Set<unknown>();
  const complex: Equals[] = [];
  // A whole number is the only way a query can name a big integer — JSON has no literal for
  // one — but the two forms are kept in *separate* sets. Holding both in one made every
  // lookup 1.17× the cost of a set of plain numbers, on every `$in` ever written, to serve a
  // kind of value almost no document holds; this way the common path is the set it always
  // was, and a big integer costs one comparison more, after that set has already said no.
  let bigints: Set<bigint> | undefined;
  let matchesMissing = false;
  list.forEach((item, index) => {
    checkLiteral(item, `${at}[${index}]`);
    if (item === null) matchesMissing = true;
    else if (typeof item === "object") complex.push(equalsLiteral(item, now, ignoreCase));
    else {
      primitives.add(ignoreCase && typeof item === "string" ? lower(item) : item);
      const big = alsoBig(item);
      if (big !== undefined) (bigints ??= new Set()).add(big);
    }
  });
  const fold = ignoreCase;
  const whole = bigints;
  return (value) => {
    if (value === undefined || value === null) return matchesMissing;
    if (primitives.has(fold && typeof value === "string" ? lower(value) : value)) return true;
    if (whole !== undefined && typeof value === "bigint" && whole.has(value)) return true;
    for (let i = 0; i < complex.length; i++) if ((complex[i] as Equals)(value)) return true;
    return false;
  };
}

type Ordering = "$gt" | "$gte" | "$lt" | "$lte";

/**
 * An ordering comparison.
 *
 * Only like with like: a number against numbers (and bigints), a string against strings
 * in code-unit order, a `$date` against anything that reads as a date. Nothing is
 * coerced, so `"10"` is not greater than `9` — a comparison that converted would give a
 * different answer depending on which side happened to be a string, and a query that
 * means different things on different documents is not one anybody can reason about.
 */
export function orderTest(operator: Ordering, bound: unknown, at: string, now: number): Test {
  if (typeof bound === "number") {
    if (Number.isNaN(bound)) throw new JqlError("NaN compares false with everything, so this would match nothing", at);
    switch (operator) {
      case "$gt":
        return (value) => (typeof value === "number" || typeof value === "bigint") && value > bound;
      case "$gte":
        return (value) => (typeof value === "number" || typeof value === "bigint") && value >= bound;
      case "$lt":
        return (value) => (typeof value === "number" || typeof value === "bigint") && value < bound;
      case "$lte":
        return (value) => (typeof value === "number" || typeof value === "bigint") && value <= bound;
    }
  }
  if (typeof bound === "string") {
    switch (operator) {
      case "$gt":
        return (value) => typeof value === "string" && value > bound;
      case "$gte":
        return (value) => typeof value === "string" && value >= bound;
      case "$lt":
        return (value) => typeof value === "string" && value < bound;
      case "$lte":
        return (value) => typeof value === "string" && value <= bound;
    }
  }
  if (isDateLiteral(bound)) {
    const time = resolveDate(bound.$date, now);
    if (Number.isNaN(time)) throw new JqlError(`${JSON.stringify(bound.$date)} is not a date, so every comparison with it would be false`, at);
    // A value in the document is only a date for the length of this comparison. A `Date`
    // object is not a JSON value, so the engine does not assume one: strings and epoch
    // numbers are read as dates here because the query said "$date".
    switch (operator) {
      case "$gt":
        return (value) => value !== null && value !== undefined && toTime(value) > time;
      case "$gte":
        return (value) => value !== null && value !== undefined && toTime(value) >= time;
      case "$lt":
        return (value) => value !== null && value !== undefined && toTime(value) < time;
      case "$lte":
        return (value) => value !== null && value !== undefined && toTime(value) <= time;
    }
  }
  throw new JqlError(`compares with a number, a string, a {"$date": …} or a {"$field": …}, not ${describe(bound)}`, at);
}

type StringOperator = "$contains" | "$startsWith" | "$endsWith" | "$word" | "$glob";

/**
 * The string operators, each taking one value or a list meaning "any of these".
 *
 * A list is there because "the path starts with any of `/health`, `/metrics`" is a single
 * thought, and spelling it as an `$or` of three conditions makes it three.
 */
export function stringTest(operator: StringOperator, operand: unknown, ignoreCase: boolean, at: string, maxGlobLength = Number.POSITIVE_INFINITY): Test {
  const list = typeof operand === "string" ? [operand] : operand;
  if (!Array.isArray(list)) throw new JqlError(`takes a string or a list of strings, not ${describe(operand)}`, at);
  if (list.length === 0) return NEVER;
  const wanted = list.map((item, index) => {
    if (typeof item !== "string") throw new JqlError(`takes strings, not ${describe(item)}`, `${at}[${index}]`);
    return ignoreCase ? lower(item) : item;
  });
  if (operator === "$glob") {
    for (const pattern of wanted) {
      if (pattern.length > maxGlobLength) throw new JqlError(`the glob is ${pattern.length} characters, past the limit of ${maxGlobLength}`, at);
    }
    // Taken apart once, into the narrowest matcher the pattern allows.
    const globs = wanted.map(compileGlob);
    if (globs.length === 1) {
      const only = globs[0] as (text: string) => boolean;
      return ignoreCase ? (value) => typeof value === "string" && only(lower(value)) : (value) => typeof value === "string" && only(value);
    }
    return (value) => {
      if (typeof value !== "string") return false;
      const actual = ignoreCase ? lower(value) : value;
      for (let i = 0; i < globs.length; i++) if ((globs[i] as (text: string) => boolean)(actual)) return true;
      return false;
    };
  }
  const one = (actual: string, value: string): boolean => {
    switch (operator) {
      case "$contains":
        return actual.includes(value);
      case "$startsWith":
        return actual.startsWith(value);
      case "$endsWith":
        return actual.endsWith(value);
      case "$word":
        return containsWord(actual, value);
    }
  };
  if (wanted.length === 1) {
    const only = wanted[0] as string;
    // The common single-value `$contains` gets its own closure: no inner call, no loop.
    if (operator === "$contains") return ignoreCase ? (value) => typeof value === "string" && lower(value).includes(only) : (value) => typeof value === "string" && value.includes(only);
    return (value) => typeof value === "string" && one(ignoreCase ? lower(value) : value, only);
  }
  return (value) => {
    if (typeof value !== "string") return false;
    const actual = ignoreCase ? lower(value) : value;
    for (let i = 0; i < wanted.length; i++) if (one(actual, wanted[i] as string)) return true;
    return false;
  };
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * The value as a whole component of the text: bounded on each side by the start or end of
 * the text, or by a character that is not a letter or digit.
 *
 * Ported from BotHandler's actor matching, where it replaced a substring test that let
 * `1.2.3.4` match `1.2.3.45` and `11.2.3.4` — so excluding one address excluded its
 * neighbours too. A side of the value that is itself a separator has chosen its own
 * boundary: `203.0.113.` finds the whole network.
 */
export function containsWord(actual: string, wanted: string): boolean {
  if (wanted === "") return false;
  const characters = [...wanted];
  const startsAlphanumeric = ALPHANUMERIC.test(characters[0] as string);
  const endsAlphanumeric = ALPHANUMERIC.test(characters[characters.length - 1] as string);
  let from = 0;
  for (;;) {
    const at = actual.indexOf(wanted, from);
    if (at === -1) return false;
    const end = at + wanted.length;
    const startsClean = at === 0 || !startsAlphanumeric || !ALPHANUMERIC.test(before(actual, at));
    const endsClean = end >= actual.length || !endsAlphanumeric || !ALPHANUMERIC.test(after(actual, end));
    if (startsClean && endsClean) return true;
    from = at + 1;
  }
}

/**
 * The character on either side of a boundary — a whole one.
 *
 * Read a code unit at a time, half of a letter outside the basic plane is a lone surrogate,
 * which is in no Unicode category at all, so `𝐀𝐁` looked like two words rather than one.
 */
function before(text: string, at: number): string {
  const code = text.charCodeAt(at - 1);
  return code >= 0xdc00 && code <= 0xdfff && at >= 2 ? text.slice(at - 2, at) : (text[at - 1] as string);
}

function after(text: string, end: number): string {
  const code = text.charCodeAt(end);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(end, end + 2) : (text[end] as string);
}

/** Flags `$options` may carry. `g` and `y` are refused: they make `RegExp.test` stateful, so a pattern would match on alternate calls. */
const OPTION_FLAGS = new Set(["i", "m", "s", "u"]);

export function parseOptions(options: unknown, at: string): string {
  if (typeof options !== "string") throw new JqlError(`takes a string of flags such as "i", not ${describe(options)}`, at);
  for (const flag of options) {
    if (!OPTION_FLAGS.has(flag)) {
      const why = flag === "g" || flag === "y" ? ": it makes a pattern stateful, so it would match on every other document" : "";
      throw new JqlError(`"${flag}" is not a flag this language takes (i, m, s, u)${why}`, at);
    }
  }
  if (new Set(options).size !== options.length) throw new JqlError(`"${options}" repeats a flag`, at);
  return options;
}

export function regexTest(pattern: unknown, flags: string, limits: { allowRegex: boolean; maxPatternLength: number }, at: string): Test {
  if (!limits.allowRegex) throw new JqlError("patterns are turned off for this query; $contains, $startsWith, $endsWith and $word cover most of what one is for", at);
  if (typeof pattern !== "string") throw new JqlError(`takes the pattern as a string, not ${describe(pattern)}`, at);
  if (pattern.length > limits.maxPatternLength) throw new JqlError(`the pattern is ${pattern.length} characters, past the limit of ${limits.maxPatternLength}`, at);
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flags);
  } catch (error) {
    throw new JqlError(`the pattern does not compile: ${error instanceof Error ? error.message : String(error)}`, at);
  }
  return (value) => typeof value === "string" && expression.test(value);
}

export function typeTest(operand: unknown, at: string): Test {
  const list = typeof operand === "string" ? [operand] : operand;
  if (!Array.isArray(list) || list.length === 0) throw new JqlError(`takes a type name or a non-empty list of them, not ${describe(operand)}`, at);
  const types = list.map((name, index) => {
    if (typeof name !== "string" || !(TYPE_NAMES as readonly string[]).includes(name)) {
      throw new JqlError(`${describe(name)} is not a type name (${TYPE_NAMES.join(", ")})${typeof name === "string" ? didYouMean(name, TYPE_NAMES) : ""}`, `${at}[${index}]`);
    }
    return name as TypeName;
  });
  if (types.length === 1) {
    const only = types[0] as TypeName;
    return (value) => isOfType(value, only);
  }
  return (value) => types.some((type) => isOfType(value, type));
}

export function modTest(operand: unknown, at: string): Test {
  if (!Array.isArray(operand) || operand.length !== 2 || typeof operand[0] !== "number" || typeof operand[1] !== "number") {
    throw new JqlError(`takes [divisor, remainder], not ${describe(operand)}`, at);
  }
  const [divisor, remainder] = operand as [number, number];
  if (divisor === 0 || !Number.isFinite(divisor)) throw new JqlError("a divisor of zero leaves no remainder to compare, so this would match nothing", at);
  // A big integer is a number everywhere else in the language — for ordering, and for
  // `$type` (specification §5.3) — so it is one here. `%` refuses to mix a big integer with
  // an ordinary one, so the divisor is converted once, when the query compiles; a divisor
  // with a fraction cannot divide a big integer at all, and no value matches it.
  const big = Number.isInteger(divisor) ? BigInt(divisor) : undefined;
  return (value) => {
    if (typeof value === "number") return value % divisor === remainder;
    if (typeof value === "bigint") return big !== undefined && Number(value % big) === remainder;
    return false;
  };
}

/** `$all`: every literal is equal to the value or to one of its elements. An empty list matches nothing. */
export function allTest(list: unknown, ignoreCase: boolean, at: string, now: number): Test {
  if (!Array.isArray(list)) throw new JqlError(`takes a list of values, not ${describe(list)}`, at);
  if (list.length === 0) return NEVER;
  const tests = list.map((item, index) => {
    if (isPlainObject(item) && Object.keys(item).some((key) => key.startsWith("$")) && !isDateLiteral(item)) {
      throw new JqlError("takes values, not conditions; use $elemMatch inside $and for that", `${at}[${index}]`);
    }
    return equalsTest(item, ignoreCase, `${at}[${index}]`, now);
  });
  return (value) => {
    for (const test of tests) {
      if (test(value)) continue;
      if (!Array.isArray(value)) return false;
      let found = false;
      for (let i = 0; i < value.length; i++) {
        if (test(value[i])) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  };
}

/**
 * The order of two values that both came out of a document, or `undefined` when they
 * cannot be compared.
 *
 * Only like with like, as everywhere else in the language: numbers with numbers, strings
 * with strings, dates with dates. Nothing is read as a date here, because neither side is
 * a query saying it is one — `{ "$field": … }` compares what the item holds.
 */
export function orderOf(a: unknown, b: unknown): number | undefined {
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) {
    if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date && b instanceof Date) {
    const left = a.getTime();
    const right = b.getTime();
    return Number.isNaN(left) || Number.isNaN(right) ? undefined : left - right;
  }
  return undefined;
}

/**
 * Refuses a literal JSON cannot carry.
 *
 * A `RegExp`, a `Date`, a function or `undefined` in a query would work in the process
 * that wrote it and mean something else — or nothing — once the query was serialised.
 * The language is the JSON, so the engine holds to it even when handed an object that
 * could have been more.
 */
export function checkLiteral(value: unknown, at: string, depth = 0): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JqlError(`${String(value)} is not a JSON number`, at);
    return;
  }
  if (depth > 64) throw new JqlError("the literal nests deeper than 64 levels", at);
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkLiteral(item, `${at}[${index}]`, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    if (isFieldReference(value)) {
      throw new JqlError(
        `a {"$field": …} reference compares with another field, which $eq, $ne and the ordering operators do; it is not a value that can be held here`,
        at,
      );
    }
    if (isDateLiteral(value)) {
      const date = value.$date;
      if (Number.isNaN(resolveDate(date, 0))) {
        const relative = isPlainObject(date) ? `; a relative date is {"$ago": "1h"} or {"$ahead": "1h"}, with a count and one of ${DURATION_UNITS.join(", ")}` : "";
        throw new JqlError(`${JSON.stringify(date)} is not a date${relative}`, `${at}.$date`);
      }
      return;
    }
    for (const key in value) checkLiteral(value[key], `${at}.${key}`, depth + 1);
    return;
  }
  const hint = value instanceof RegExp ? '; write {"$regex": "…"} instead' : value instanceof Date ? '; write {"$date": "…"} instead' : "";
  throw new JqlError(`${describe(value)} is not JSON, so a query holding it could not be stored or sent${hint}`, at);
}
