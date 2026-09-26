import { CASE_AWARE, compile, type CompileOptions, FIELD_OPERATORS, reachField } from "./core.js";
import { isFieldReference, isPlainObject } from "./internal/values.js";
import type { QueryLike } from "./types.js";
import type { Vocabulary } from "./vocabulary.js";

/**
 * Why one item does or does not match a query.
 *
 * A filter that returns nothing tells you nothing about which part of it was wrong. This
 * takes the query apart and answers for each piece separately, with the values it actually
 * read, so an operator looking at a row and a saved filter that disagree can see the clause
 * that decided it.
 *
 * **It runs the real engine on every piece.** Each clause is compiled on its own and tested,
 * rather than interpreted here by a second reading of the language — a second reading would
 * be a second set of semantics, and the one thing worse than a filter you cannot explain is
 * an explanation that does not match what the filter did. The cost is one small compile per
 * clause, which is why this is for one item at a time and `compile` is for the collection.
 */

export interface Explanation {
  /** Whether this clause holds for the item. */
  readonly matched: boolean;
  /** Where the clause is in the query, written as it would be reached in code: `$or[1].age.$gt`. */
  readonly at: string;
  /** The clause itself, as the JSON fragment that was evaluated. */
  readonly clause: unknown;
  /** One sentence: what was read, or how the parts came out. */
  readonly because: string;
  /** The clauses this one is made of. */
  readonly parts?: readonly Explanation[];
}

const FIELD_OPERATOR_SET = new Set(FIELD_OPERATORS);

/** Explains one item against one query. */
export function explain<T, Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, item: T, options: CompileOptions<Extra> = {}): Explanation {
  return node(query, item, "", options as CompileOptions<object>);
}

function matchedBy(clause: unknown, item: unknown, options: CompileOptions<object>): boolean {
  return compile(clause as QueryLike<unknown, object>, options)(item);
}

/**
 * Explains one clause.
 *
 * `at` is where the clause's *contents* live — the path of whatever holds it — and each
 * key appends itself. Written the other way round, with the caller appending the key and
 * the callee appending it again, every nested location came out doubled: `score.score.$gt`.
 */
function node(clause: unknown, item: unknown, at: string, options: CompileOptions<object>): Explanation {
  if (typeof clause === "function" || !isPlainObject(clause)) {
    return leaf(clause, item, at, options, typeof clause === "function" ? "a predicate of your own" : "the whole query");
  }
  const keys = Object.keys(clause);
  if (keys.length === 0) return { matched: true, at, clause, because: "an empty query matches everything" };
  if (keys.length > 1) {
    // Field operators at the top of a query are one condition on the item itself. Split a
    // key at a time they came apart, and `{ $contains: "ABC", $options: "i" }` was explained
    // as an `$options` with nothing beside it — which the engine refuses, so explaining a
    // perfectly good query threw.
    const self = keys.filter((key) => key !== "$not" && FIELD_OPERATOR_SET.has(key));
    const rest = keys.filter((key) => !self.includes(key));
    const parts = rest.map((key) => node({ [key]: clause[key] }, item, at, options));
    if (self.length > 0) {
      const whole: Record<string, unknown> = {};
      for (const key of self) whole[key] = clause[key];
      parts.push(leaf(whole, item, at, options, self[0] as string));
    }
    return branch(clause, at, parts, "and");
  }

  const key = keys[0] as string;
  const value = clause[key];
  const here = join(at, key);
  switch (key) {
    case "$and":
    case "$or":
    case "$nor": {
      if (!Array.isArray(value)) break;
      const parts = value.map((part, index) => node(part, item, `${here}[${index}]`, options));
      return branch(clause, here, parts, key === "$and" ? "and" : key === "$or" ? "or" : "nor");
    }
    case "$not": {
      const inner = node(value, item, here, options);
      return {
        matched: !inner.matched,
        at: here,
        clause,
        because: inner.matched ? "what it negates holds" : "what it negates does not hold",
        parts: [inner],
      };
    }
    default:
      break;
  }

  // A field with several operators explains one operator at a time: which of them failed is
  // the question somebody is asking.
  if (!key.startsWith("$") && isPlainObject(value) && !isFieldReference(value) && Object.keys(value).length > 1 && Object.keys(value).every((name) => name.startsWith("$"))) {
    const operators = Object.keys(value).filter((name) => name !== "$options");
    // `$options` travels with each operator it changes — and only those. Carried onto the
    // others it made a piece the engine refuses ("$options has nothing to apply to"), so a
    // valid query like `{ b: { $contains: "x", $exists: true, $options: "i" } }` threw
    // instead of being explained.
    const flags = value.$options === undefined ? {} : { $options: value.$options };
    const parts = operators.map((name) => leaf({ [key]: { [name]: value[name], ...(CASE_AWARE.has(name) ? flags : {}) } }, item, join(here, name), options, key));
    return branch(clause, here, parts, "and");
  }
  return leaf(clause, item, here, options, key);
}

function branch(clause: unknown, at: string, parts: Explanation[], kind: "and" | "or" | "nor"): Explanation {
  const held = parts.filter((part) => part.matched).length;
  const matched = kind === "and" ? held === parts.length : kind === "or" ? held > 0 : held === 0;
  const many = parts.length === 1 ? "part" : "parts";
  const because =
    kind === "nor" ? `${held} of ${parts.length} ${many} hold, and none may` : `${held} of ${parts.length} ${many} hold${kind === "or" ? ", and one is enough" : ""}`;
  return { matched, at, clause, because, parts };
}

function leaf(clause: unknown, item: unknown, at: string, options: CompileOptions<object>, key: string): Explanation {
  const matched = matchedBy(clause, item, options);
  return { matched, at, clause, because: reason(clause, item, options, key) };
}

/** What the item holds where this clause looked. */
function reason(clause: unknown, item: unknown, options: CompileOptions<object>, key: string): string {
  if (key === "$text") return matchedBy(clause, item, options) ? "the item holds that text" : "no value of the item holds that text";
  if (key === "$comment") return "a comment decides nothing";
  if (key.startsWith("$") && FIELD_OPERATOR_SET.has(key)) return `the item itself is ${values(item === undefined ? [] : [item])}`;
  if (!isPlainObject(clause)) return "the clause was run as given";
  const path = Object.keys(clause)[0];
  if (path === undefined || path.startsWith("$")) return "the clause was run as given";
  const found: unknown[] = [];
  try {
    reachField(path, options.vocabulary as Vocabulary<unknown, object> | undefined, path)(item, (value) => {
      if (found.length < 4) found.push(value);
      return false;
    });
  } catch {
    // A name the query resolves but this walk cannot is not worth failing an explanation for.
    return "the clause was run as given";
  }
  return `${path} is ${values(found)}`;
}

function values(found: readonly unknown[]): string {
  if (found.length === 0 || (found.length === 1 && found[0] === undefined)) return "missing";
  const written = found.map((value) => (value === undefined ? "missing" : shorten(value)));
  return written.length === 1 ? (written[0] as string) : `each of ${written.join(", ")}`;
}

function shorten(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // A value that will not serialise — something cyclic — still has a name worth printing.
    return "a value that cannot be written out";
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function join(at: string, key: string): string {
  return at === "" ? key : `${at}.${key}`;
}
