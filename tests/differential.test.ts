import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { makeCondition, makeQuery, makeRoot, type Query, random, scalar, show } from "./helpers/generate.js";

/**
 * The engine against a reference that is slow on purpose.
 *
 * The engine has fast paths: an equality inlined into one closure, the operators of a
 * condition fused into one read, a nested path probed straight and walked only when it meets
 * an array. Every one of them is a second implementation of something the language already
 * says, and a second implementation is a place for the two to disagree. So this file holds a
 * third: the specification's rules written out as directly as they read — collect every
 * value a path reaches, test each operator against every one of them — and thousands of
 * seeded random documents and queries on which the engine must give the same answer.
 *
 * A failure prints the seed, the document and the query, which is all it takes to turn it
 * into an ordinary test.
 */

type Doc = unknown;

/* ------------------------------------------------------------------------------------ */
/* The reference                                                                        */
/* ------------------------------------------------------------------------------------ */

function reached(value: unknown, keys: readonly string[]): unknown[] {
  if (keys.length === 0) return [value];
  if (value === null || typeof value !== "object") return [undefined];
  const [key, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(value)) {
    if (/^(0|[1-9]\d*)$/.test(key)) return reached(value[Number(key)], rest);
    if (value.length === 0) return [undefined];
    return value.flatMap((element) => reached(element, keys));
  }
  if (value instanceof Map) return reached(value.get(key), rest);
  return reached(Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined, rest);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b) && !(a instanceof Map)) {
    const ka = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
    const kb = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
    return ka.length === kb.length && kb.every((key) => Object.hasOwn(a, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function equalsLiteral(value: unknown, literal: unknown): boolean {
  if (literal === null) return value === null || value === undefined;
  return deepEqual(value, literal);
}

/** Two values of one item, compared: same type only, and missing is not comparable. */
function comparePair(name: string, a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  if (name === "$eq") return deepEqual(a, b);
  const sameKind = (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
  if (!sameKind) return false;
  switch (name) {
    case "$gt":
      return (a as number) > (b as number);
    case "$gte":
      return (a as number) >= (b as number);
    case "$lt":
      return (a as number) < (b as number);
    default:
      return (a as number) <= (b as number);
  }
}

/** Tried on the value, then on each element if it is an array. */
function either(value: unknown, test: (item: unknown) => boolean): boolean {
  return test(value) || (Array.isArray(value) && value.some(test));
}

/** A glob, read a second way: as a regular expression. The engine never builds one. */
function globAsRegex(pattern: string): RegExp {
  let out = "";
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      out += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "*") out += "[\\s\\S]*";
    else if (character === "?") out += "[\\s\\S]";
    else out += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (escaped) out += "\\\\";
  return new RegExp(`^${out}$`, "u");
}

/**
 * `$word`, read a second way: as lookarounds rather than as a scan.
 *
 * The engine walks the string and inspects the characters either side of each occurrence.
 * This asks a regular-expression engine the same question, which is the point — two ways of
 * saying "a whole component" that have to agree.
 */
function wordAsRegex(actual: string, wanted: string): boolean {
  if (wanted === "") return false;
  const alphanumeric = /[\p{L}\p{N}]/u;
  const quoted = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = alphanumeric.test(wanted[0] as string) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = alphanumeric.test(wanted[wanted.length - 1] as string) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${quoted}${after}`, "u").test(actual);
}

/** The name of a value's type, as `$type` uses it. */
function typeNameOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value === "object") return "object";
  return typeof value;
}

function operator(name: string, operand: unknown, value: unknown, document: Doc, ignoreCase = false): boolean {
  // "Ignoring case" is defined as comparing after lower-casing, so the reference does
  // exactly that and hands the operators values that already agree.
  if (ignoreCase) {
    const fold = (item: unknown): unknown => (typeof item === "string" ? item.toLowerCase() : Array.isArray(item) ? item.map(fold) : item);
    return operator(name, fold(operand), fold(value), document, false);
  }
  // A reference can stand wherever a value can, so it is handled before the operators that
  // would otherwise compare against the object `{ "$field": … }` itself.
  if (isFieldReference(operand) && (name === "$eq" || name === "$gt" || name === "$gte" || name === "$lt" || name === "$lte")) {
    const others = reached(document, operand.$field.split("."));
    return either(value, (one) => others.some((two) => either(two, (other) => comparePair(name, one, other))));
  }
  switch (name) {
    case "$eq":
      return either(value, (item) => equalsLiteral(item, operand));
    case "$gt":
      return either(value, (item) => typeof item === "number" && item > (operand as number));
    case "$gte":
      return either(value, (item) => typeof item === "number" && item >= (operand as number));
    case "$lt":
      return either(value, (item) => typeof item === "number" && item < (operand as number));
    case "$lte":
      return either(value, (item) => typeof item === "number" && item <= (operand as number));
    case "$in":
      return either(value, (item) => (operand as unknown[]).some((literal) => equalsLiteral(item, literal)));
    case "$exists":
      return value !== undefined;
    case "$contains":
      return either(value, (item) => typeof item === "string" && item.includes(operand as string));
    case "$startsWith":
      return either(value, (item) => typeof item === "string" && item.startsWith(operand as string));
    case "$size":
      return Array.isArray(value) && value.length === operand;
    case "$elemMatch":
      return Array.isArray(value) && value.some((element) => reference(operand as Query, element));
    case "$glob":
      return either(value, (item) => typeof item === "string" && globAsRegex(operand as string).test(item));
    case "$endsWith":
      return either(value, (item) => typeof item === "string" && item.endsWith(operand as string));
    case "$word":
      return either(value, (item) => typeof item === "string" && wordAsRegex(item, operand as string));
    case "$mod":
      return either(value, (item) => typeof item === "number" && item % (operand as number[])[0]! === (operand as number[])[1]);
    case "$type": {
      const names = Array.isArray(operand) ? operand : [operand];
      return either(value, (item) => names.some((name) => (name === "integer" ? Number.isInteger(item) : typeNameOf(item) === name)));
    }
    case "$all": {
      const wanted = operand as unknown[];
      if (wanted.length === 0) return false;
      return wanted.every((one) => operator("$eq", one, value, document));
    }
    case "$length":
      return (typeof value === "string" || Array.isArray(value)) && value.length === operand;
    case "$field": {
      // A bare reference, written where a value would be: the same comparison as `$eq`.
      const others = reached(document, (operand as string).split("."));
      return either(value, (one) => others.some((two) => either(two, (other) => comparePair("$eq", one, other))));
    }
    default:
      throw new Error(`the reference does not know ${name}`);
  }
}

/** Positive operators hold for some reached value; their negations hold for none. */
function fieldHolds(values: unknown[], name: string, operand: unknown, document: Doc, ignoreCase = false): boolean {
  switch (name) {
    case "$ne":
      return !values.some((value) => operator("$eq", operand, value, document, ignoreCase));
    case "$nin":
      return !values.some((value) => operator("$in", operand, value, document, ignoreCase));
    case "$exists":
      return operand === values.some((value) => value !== undefined);
    case "$not":
      return !conditionHolds(values, operand as Record<string, unknown>, document);
    default:
      return values.some((value) => operator(name, operand, value, document, ignoreCase));
  }
}

function conditionHolds(values: unknown[], condition: Record<string, unknown>, document: Doc): boolean {
  const ignoreCase = condition.$options === "i";
  return Object.entries(condition)
    .filter(([name]) => name !== "$options")
    .every(([name, operand]) => fieldHolds(values, name, operand, document, ignoreCase));
}

function isFieldReference(value: unknown): value is { $field: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { $field?: unknown }).$field === "string";
}

function isCondition(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).some((key) => key.startsWith("$"));
}

function reference(query: Query, document: Doc): boolean {
  // Field operators at the top of a query are one condition on the item itself. Read one
  // key at a time they would come apart — `$options` would be split from the operator whose
  // meaning it changes — so they are gathered first and asked together.
  const self: Record<string, unknown> = {};
  const rest = Object.entries(query).filter(([key, value]) => {
    if (!key.startsWith("$") || ["$and", "$or", "$nor", "$not"].includes(key)) return true;
    self[key] = value;
    return false;
  });
  const holds = rest.every(([key, value]) => {
    switch (key) {
      case "$and":
        return (value as Query[]).every((part) => reference(part, document));
      case "$or":
        return (value as Query[]).some((part) => reference(part, document));
      case "$nor":
        return !(value as Query[]).some((part) => reference(part, document));
      case "$not":
        return !reference(value as Query, document);
      default: {
        const values = reached(document, key.split("."));
        if (isFieldReference(value)) return fieldHolds(values, "$field", value.$field, document);
        return isCondition(value) ? conditionHolds(values, value, document) : fieldHolds(values, "$eq", value, document);
      }
    }
  });
  if (!holds) return false;
  return Object.keys(self).length === 0 || conditionHolds([document], self, document);
}

/* ------------------------------------------------------------------------------------ */

describe("the engine against the reference", () => {
  it("agrees on random documents and queries", () => {
    const documents = 40;
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const query = makeQuery(next);
      const test = compile(query as never);
      for (let i = 0; i < documents; i++) {
        const document = makeRoot(next);
        const expected = reference(query, document);
        const actual = test(document);
        if (actual !== expected) {
          expect.fail(`seed ${seed}, document ${i}: the engine said ${actual}, the reference ${expected}\n  query:    ${show(query)}\n  document: ${show(document)}`);
        }
      }
    }
  });

  it("agrees on conditions over arrays of primitives", () => {
    for (let seed = 1000; seed < 1300; seed++) {
      const next = random(seed);
      const condition = makeCondition(next, 1);
      const test = compile(condition as never);
      for (let i = 0; i < 20; i++) {
        const item = next() < 0.3 ? Array.from({ length: Math.floor(next() * 3) }, () => scalar(next)) : scalar(next);
        const expected = reference(condition, item);
        if (test(item) !== expected) expect.fail(`seed ${seed}: condition ${show(condition)} on ${show(item)} should be ${expected}`);
      }
    }
  });
});
