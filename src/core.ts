import { JqlError } from "./errors.js";
import { didYouMean } from "./internal/closest.js";
import { FANOUT, needsGuard, PLAIN, type Probe, probeFrom, probePath, type Read, type Reach, reachFrom, reachPath, readOwn, readSelf, splitPath } from "./internal/path.js";
import { describe, isDateLiteral, isFieldReference, isPlainObject } from "./internal/values.js";
import { DEFAULT_LIMITS, type Limits } from "./limits.js";
import { alsoBig, valuesEqual } from "./internal/equal.js";
import {
  allTest,
  checkLiteral,
  orderOf,
  equalsTest,
  inTest,
  modTest,
  orderTest,
  parseOptions,
  regexTest,
  stringTest,
  type Test,
  typeTest,
} from "./operators.js";
import type { Matcher, QueryLike, UntypedQuery } from "./types.js";
import { checkVocabulary, type Vocabulary, type VocabularyField } from "./vocabulary.js";

/**
 * The engine: a query document in, a predicate out.
 *
 * **Compile once, test many.** Everything that depends only on the query — validating it,
 * resolving field names, splitting paths, building sets for `$in`, lower-casing for `$options:
 * "i"`, compiling patterns — happens here, once. What comes back is a tree of small closures
 * that does only the part that depends on the document. Filtering a million items with one
 * query parses that query once, not a million times.
 *
 * **No code generation.** Emitting JavaScript source and calling `new Function` would be
 * faster still, and it would also be refused by every page with a Content-Security-Policy
 * worth having — including the dashboards in this project, whose build fails on a
 * `new Function`. Closures run everywhere.
 *
 * **Cheapest first.** The parts of an `$and` are reordered so an equality test runs before a
 * pattern and a pattern before a free-text walk, because the first part to fail decides the
 * answer and the rest never run. Every operator is a pure test, so the order changes the
 * cost and never the result.
 *
 * **No implicit cache.** A cache keyed on the query object would hand back a stale predicate
 * the moment somebody edited the object they had already queried with — a filter that looks
 * updated and is not. Compiling a small query costs about as much as testing a handful of
 * documents, so the helpers compile per call, and a hot loop calls `compile` once and keeps
 * the result.
 */

export interface CompileOptions<Extra extends object = {}> {
  /** The field names, aliases and computed fields a query may use. Its fields become names a typed query may use. */
  readonly vocabulary?: Vocabulary<never, Extra> | undefined;
  /** How much of a query to accept. Default `DEFAULT_LIMITS`; use `UNTRUSTED_LIMITS` for queries from outside. */
  readonly limits?: Partial<Limits> | undefined;
  /**
   * Where "now" comes from, for the relative dates in `{ "$date": { "$ago": "1h" } }`.
   * Default the system clock, read **once**, when the query compiles.
   *
   * Read once because a window that moved while a scan was in progress would judge two
   * items a second apart against different hours. It also means a long-lived compiled
   * query keeps the instant it was compiled at: recompile to move the window, which costs
   * well under a microsecond.
   */
  readonly now?: (() => number) | undefined;
  /**
   * Operators this project adds to the language, such as an address-in-network test that
   * no amount of JSON could express.
   *
   * **A query using one is no longer portable JQL**, which is why their names must begin
   * `$x`: somebody reading a stored filter can see at a glance that it needs more than a
   * standard engine, and a future version of the language cannot collide with one.
   */
  readonly operators?: readonly OperatorDefinition[] | undefined;
}

/** An operator a project adds to the language. Its name must match `$x` followed by a capital: `$xCidr`. */
export interface OperatorDefinition {
  readonly name: string;
  /**
   * Builds the test, once, when the query compiles. Throw `JqlError` for an operand this
   * operator cannot use; the message reaches whoever wrote the query.
   */
  readonly compile: (operand: unknown, at: string) => (value: unknown) => boolean;
  /** Roughly what it costs against the others, so an `$and` can run the cheap parts first. Default 4. */
  readonly cost?: number | undefined;
  /** Whether it is also tried against each element of an array value. Default true, like the built-in operators. */
  readonly elementwise?: boolean | undefined;
}

const EXTENSION_NAME = /^\$x[A-Z][A-Za-z0-9]*$/;

/** A predicate with its estimated cost, so an `$and` can run the cheap parts first. */
interface Compiled {
  readonly test: (document: unknown) => boolean;
  readonly cost: number;
}

/**
 * How a field is reached. `read` is present only when the path cannot fan out over an
 * array; `probe` when it can, but usually will not, so the straight read is worth trying
 * first.
 */
interface Field {
  readonly read: Read | undefined;
  readonly probe: Probe | undefined;
  readonly reach: Reach;
  /** A plain own-property name, for the fastest equality path. */
  readonly key: string | undefined;
  readonly cost: number;
}

interface Context {
  readonly vocabulary: Vocabulary<unknown, object> | undefined;
  readonly limits: Limits;
  readonly operators: ReadonlyMap<string, OperatorDefinition>;
  /** The operators this query may use, or `undefined` when it may use all of them. */
  readonly allowed: ReadonlySet<string> | undefined;
  /** The instant every relative date in this query resolves against. */
  readonly now: number;
  nodes: number;
}

const ALWAYS: Compiled = { test: () => true, cost: 0 };
const NOTHING: Compiled = { test: () => false, cost: 0 };

/** The operators that combine queries. */
export const QUERY_OPERATORS: readonly string[] = ["$and", "$or", "$nor", "$not", "$text", "$comment"];

/** The operators that test a field. At the top of a query they test the item itself. */
export const FIELD_OPERATORS: readonly string[] = [
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
  "$contains",
  "$startsWith",
  "$endsWith",
  "$word",
  "$glob",
  "$regex",
  "$options",
  "$mod",
  "$size",
  "$length",
  "$all",
  "$elemMatch",
  "$not",
];

const FIELD_OPERATOR_SET = new Set(FIELD_OPERATORS);
const EVERY_OPERATOR = [...new Set([...QUERY_OPERATORS, ...FIELD_OPERATORS])];

/**
 * Operators whose meaning `$options: "i"` changes.
 *
 * Not in the barrel — this is the language's own list (specification §5.5), shared with
 * `explain`, which has to know which pieces of a condition the flag travels with.
 */
export const CASE_AWARE = new Set(["$eq", "$ne", "$in", "$nin", "$all", "$contains", "$startsWith", "$endsWith", "$word", "$glob", "$regex"]);

/**
 * Compiles a query into a predicate.
 *
 * Throws `JqlError` for anything that is not a valid query, naming where in the query the
 * problem is. A function passed in is returned as it is, so every helper that takes a
 * query also takes a predicate somebody already has.
 */
export function compile<T = unknown, Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options: CompileOptions<Extra> = {}): Matcher<T> {
  if (typeof query === "function") return query as Matcher<T>;
  const limits = options.limits === undefined ? DEFAULT_LIMITS : { ...DEFAULT_LIMITS, ...options.limits };
  const added = extensions(options.operators);
  const context: Context = {
    vocabulary: checkVocabulary(options.vocabulary) as Vocabulary<unknown, object> | undefined,
    limits,
    now: options.now === undefined ? Date.now() : options.now(),
    operators: added,
    allowed: allowlist(limits.allowOperators, added),
    nodes: 0,
  };
  const { test } = compileQuery(query, context, "", 0);
  // The shared constants are never handed out, so a caller that attaches something to
  // the predicate it was given cannot reach every other query's.
  if (test === ALWAYS.test) return () => true;
  if (test === NOTHING.test) return () => false;
  return test as Matcher<T>;
}

/** Whether one value matches a query. For a one-off; in a loop, `compile` once instead. */
export function matches<T, Extra extends object = {}>(value: T, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean {
  return compile(query, options)(value);
}

/**
 * Checks a query, and hands back the predicate when it is a good one.
 *
 * What a service calls on a query it has just received, so it can answer 400 with the
 * sentence rather than 500 with a stack. The predicate comes with it because the caller
 * needs one next, and the two ways of getting it separately are both worse: compiling
 * again costs a second compile, and — the reason this returns it rather than only a
 * verdict — it is compiled from a second set of options, which is how a query gets
 * checked against the untrusted limits and then run without them.
 */
export function validate<T = unknown>(query: unknown, options?: CompileOptions<object>): { valid: true; test: Matcher<T> } | { valid: false; error: JqlError } {
  try {
    return { valid: true, test: compile<T>(query as QueryLike<T, object>, options) };
  } catch (error) {
    if (error instanceof JqlError) return { valid: false, error };
    throw error;
  }
}

/**
 * Marks a query from outside the type system — parsed JSON, a URL parameter — as one to be
 * checked when it is compiled rather than by the compiler. Returns the same object.
 */
export function untyped(query: unknown): UntypedQuery {
  return query as UntypedQuery;
}

/**
 * How a field name is reached, by the same rules a query uses. For sorting and projection,
 * which must name fields exactly as the query beside them does. Not part of the public
 * surface.
 */
export function reachField(name: string, vocabulary: Vocabulary<unknown, object> | undefined, at: string): Reach {
  return resolveField(name, { vocabulary, limits: DEFAULT_LIMITS, now: 0, operators: NO_EXTENSIONS, allowed: undefined, nodes: 0 }, at).reach;
}

/**
 * Operators that modify or annotate rather than ask anything, and so are never what an
 * allowlist is about.
 */
const ALWAYS_ALLOWED = new Set(["$options", "$comment"]);

/** `$field` is not an operator key, but comparing two fields is a capability, so it is gateable by name. */
const GATEABLE = new Set([...FIELD_OPERATORS, ...QUERY_OPERATORS, "$field"]);

function allowlist(names: readonly string[] | "all", added: ReadonlyMap<string, OperatorDefinition>): ReadonlySet<string> | undefined {
  if (names === "all") return undefined;
  if (!Array.isArray(names)) throw new JqlError(`is a list of operator names or "all", not ${describe(names)}`, "limits.allowOperators");
  const out = new Set<string>();
  for (const name of names) {
    // A name nobody has is a list that does not say what its author meant: it would allow
    // nothing and look like it allowed something.
    if (typeof name !== "string" || (!GATEABLE.has(name) && !added.has(name))) {
      throw new JqlError(`"${String(name)}" is not an operator, so allowing it allows nothing${typeof name === "string" ? didYouMean(name, [...GATEABLE]) : ""}`, "limits.allowOperators");
    }
    out.add(name);
  }
  return out;
}

/** Refuses an operator this query was not allowed to use. */
function permit(key: string, context: Context, at: string): void {
  const allowed = context.allowed;
  if (allowed === undefined || ALWAYS_ALLOWED.has(key) || allowed.has(key)) return;
  const listed = [...allowed];
  const shown = listed.length > 8 ? `${listed.slice(0, 8).join(", ")}, …` : listed.join(", ");
  throw new JqlError(`"${key}" is not an operator this query may use (${shown === "" ? "none" : shown})`, at);
}

const NO_EXTENSIONS: ReadonlyMap<string, OperatorDefinition> = new Map();

function extensions(given: readonly OperatorDefinition[] | undefined): ReadonlyMap<string, OperatorDefinition> {
  if (given === undefined || given.length === 0) return NO_EXTENSIONS;
  const out = new Map<string, OperatorDefinition>();
  for (const definition of given) {
    if (!EXTENSION_NAME.test(definition.name)) {
      throw new JqlError(`"${definition.name}" cannot name an added operator: the name is $x and a capital, such as "$xCidr", so a query that needs more than standard JQL says so`, "operators");
    }
    if (out.has(definition.name)) throw new JqlError(`"${definition.name}" is given twice, and the two could not both be it`, "operators");
    if (typeof definition.compile !== "function") throw new JqlError(`"${definition.name}" has no compile function, so there is nothing for it to do`, "operators");
    out.set(definition.name, definition);
  }
  return out;
}

/* ------------------------------------------------------------------------------------ */

function count(context: Context, at: string): void {
  context.nodes++;
  if (context.nodes > context.limits.maxNodes) throw new JqlError(`the query holds more than ${context.limits.maxNodes} fields and operators`, at);
}

function join(at: string, key: string): string {
  return at === "" ? key : `${at}.${key}`;
}

function compileQuery(query: unknown, context: Context, at: string, depth: number): Compiled {
  if (depth > context.limits.maxDepth) throw new JqlError(`the query nests deeper than ${context.limits.maxDepth} levels`, at);
  if (!isPlainObject(query)) throw new JqlError(`a query is an object, not ${describe(query)}`, at);
  const parts: Compiled[] = [];
  let self: Record<string, unknown> | undefined;
  for (const key in query) {
    const value = query[key];
    const here = join(at, key);
    if (value === undefined) {
      throw new JqlError("the value is undefined; JSON has no undefined, and a condition on nothing would match everything", here);
    }
    count(context, here);
    if (!key.startsWith("$")) {
      parts.push(compileField(resolveField(key, context, here), value, context, here, depth));
      continue;
    }
    permit(key, context, here);
    switch (key) {
      case "$and":
        parts.push(allOf(queryList(value, context, here, depth)));
        break;
      case "$or":
        parts.push(anyOf(queryList(value, context, here, depth)));
        break;
      case "$nor":
        parts.push(negate(anyOf(queryList(value, context, here, depth))));
        break;
      case "$not":
        parts.push(negate(compileQuery(value, context, here, depth + 1)));
        break;
      case "$text":
        parts.push(compileText(value, context, here));
        break;
      case "$comment":
        if (typeof value !== "string") throw new JqlError(`a comment is a string, not ${describe(value)}`, here);
        break;
      default:
        if (!FIELD_OPERATOR_SET.has(key)) throw new JqlError(`"${key}" is not an operator${didYouMean(key, EVERY_OPERATOR)}`, here);
        // A field operator at the top of a query is a condition on the item itself, which
        // is what lets `[3, 8, 1].jqlFilter({ $gt: 2 })` work on an array of numbers.
        self ??= {};
        self[key] = value;
    }
  }
  if (self !== undefined) parts.push(compileCondition(SELF, self, context, at, depth));
  return allOf(parts);
}

function queryList(value: unknown, context: Context, at: string, depth: number): Compiled[] {
  if (!Array.isArray(value)) throw new JqlError(`takes a list of queries, not ${describe(value)}`, at);
  return value.map((item, index) => compileQuery(item, context, `${at}[${index}]`, depth + 1));
}

/* ------------------------------------------------------------------------------------ */
/* Fields                                                                               */
/* ------------------------------------------------------------------------------------ */

const SELF: Field = { read: readSelf, probe: undefined, reach: (document, test) => test(document), key: undefined, cost: 0 };

/**
 * What a field name reaches: a vocabulary field, a vocabulary field followed by a path into
 * it, or a plain path.
 */
function resolveField(name: string, context: Context, at: string): Field {
  const vocabulary = context.vocabulary;
  if (vocabulary !== undefined) {
    const direct = vocabulary.lookup.get(name.toLowerCase());
    if (direct !== undefined) return fieldOf(direct, [], at);
    const dot = name.indexOf(".");
    if (dot > 0) {
      const head = vocabulary.lookup.get(name.slice(0, dot).toLowerCase());
      if (head !== undefined) {
        const rest = splitPath(name.slice(dot + 1));
        if (typeof rest === "string") throw new JqlError(rest, at);
        return fieldOf(head, rest, at);
      }
    }
    if (vocabulary.strict) throw new JqlError(`"${name}" is not a field here${didYouMean(name, vocabulary.names)}`, at);
  }
  const keys = splitPath(name);
  if (typeof keys === "string") throw new JqlError(keys, at);
  return pathField(keys);
}

function fieldOf(field: VocabularyField, rest: readonly string[], at: string): Field {
  if (field.get !== undefined) {
    const get = field.get as Read;
    if (rest.length === 0) return { read: get, probe: undefined, reach: (document, test) => test(get(document)), key: undefined, cost: 3 };
    return { read: undefined, probe: probeFrom(get, rest), reach: reachFrom(get, rest), key: undefined, cost: 3 + rest.length };
  }
  const keys = splitPath(field.path);
  if (typeof keys === "string") throw new JqlError(keys, at);
  return pathField([...keys, ...rest]);
}

function pathField(keys: readonly string[]): Field {
  // Even one segment can reach several values: an item that is itself an array is seen
  // through, exactly as an array met further down a path is. So a single key is probed like
  // any other path — quickly, and with the fan-out behind it when the probe meets an array.
  if (keys.length === 1) {
    const key = keys[0] as string;
    return { read: undefined, probe: probePath(keys), reach: reachPath(keys), key, cost: 0 };
  }
  return { read: undefined, probe: probePath(keys), reach: reachPath(keys), key: undefined, cost: keys.length };
}

/** `{ field: literal }`, `{ field: { $field: … } }`, or `{ field: { $op: … } }`. */
function compileField(field: Field, value: unknown, context: Context, at: string, depth: number): Compiled {
  // A reference is a value to compare with, like a date literal, rather than a condition.
  if (isFieldReference(value)) {
    permit("$field", context, at);
    permit("$eq", context, at);
    return compareFields(field, "$eq", value.$field, false, context, at);
  }
  if (isPlainObject(value) && !isDateLiteral(value)) {
    let operators = 0;
    let names = 0;
    // A value written plainly still asks for equality, so it is gated as `$eq` is.
    for (const key in value) {
      if (key.startsWith("$")) operators++;
      else names++;
    }
    if (operators > 0 && names > 0) {
      throw new JqlError("mixes operators with field names; an object here is either a condition ({ $gt: 1 }) or a value to compare with ({ a: 1 }), not both", at);
    }
    if (operators > 0) return compileCondition(field, value, context, at, depth + 1);
  }
  permit("$eq", context, at);
  return equality(field, value, false, at, context.now);
}

/* ------------------------------------------------------------------------------------ */
/* Conditions                                                                           */
/* ------------------------------------------------------------------------------------ */

/** One operator of a condition, as a test on the field's value. */
interface ValueTest {
  readonly test: Test;
  readonly cost: number;
  readonly negated: boolean;
  /** The test before it was made to look into arrays, when it was; lets a lone operator inline that loop. */
  readonly any: Test | undefined;
}

/**
 * Every operator of one condition object.
 *
 * On a field with a single value — a plain property, or a path that meets no array — the
 * operators are fused into one test over one read: `{ age: { $gte: 30, $lt: 50 } }` reads
 * `age` once and compares twice. That fusion is only sound when the field has one value.
 * On a path that fans out over an array each operator has to be tested separately, because
 * "some element is at least 30 and some element is under 50" is what the language says
 * there, and one element satisfying both is `$elemMatch`.
 */
function compileCondition(field: Field, condition: Record<string, unknown>, context: Context, at: string, depth: number): Compiled {
  const { values, whole } = conditionParts(field, condition, context, at, depth);
  return combine(field, values, whole);
}

/** The value tests and the document-level tests of one condition, as a single predicate. */
function combine(field: Field, values: readonly ValueTest[], whole: readonly Compiled[]): Compiled {
  const parts = [...whole];
  if (values.length > 0) {
    const cost = values.reduce((sum, value) => sum + value.cost, 0);
    if (field.read !== undefined) {
      const only = values.length === 1 ? (values[0] as ValueTest) : undefined;
      parts.push(only !== undefined && only.any !== undefined ? holdsAny(field, only.any, only.negated, cost) : holds(field, allOfValues(values), cost));
    } else {
      const separate = allOf(values.map((value) => (value.negated ? negate(holds(field, value.test, value.cost)) : holds(field, value.test, value.cost))));
      const probe = field.probe;
      if (probe === undefined) parts.push(separate);
      else {
        // One value, fused; an array on the way, each operator on its own.
        const fused = allOfValues(values);
        const fallback = separate.test;
        parts.push({ test: (document) => {
          const value = probe(document);
          return value === FANOUT ? fallback(document) : fused(value);
        }, cost: separate.cost });
      }
    }
  }
  return allOf(parts);
}

function conditionParts(field: Field, condition: Record<string, unknown>, context: Context, at: string, depth: number): { values: ValueTest[]; whole: Compiled[] } {
  if (depth > context.limits.maxDepth) throw new JqlError(`the query nests deeper than ${context.limits.maxDepth} levels`, at);
  let flags = "";
  if (condition.$options !== undefined) {
    flags = parseOptions(condition.$options, join(at, "$options"));
    const usesCase = Object.keys(condition).some((key) => CASE_AWARE.has(key));
    if (!usesCase) throw new JqlError("$options has nothing to apply to: it changes $regex and the equality and string operators beside it", join(at, "$options"));
    if (/[msu]/.test(flags) && condition.$regex === undefined) throw new JqlError(`the flags "${flags.replace("i", "")}" only mean something to $regex, and there is none here`, join(at, "$options"));
  }
  const ignoreCase = flags.includes("i");
  const values: ValueTest[] = [];
  const whole: Compiled[] = [];
  const add = (test: Test, cost: number, negated = false): void => {
    values.push({ test, cost, negated, any: undefined });
  };
  const addAny = (test: Test, cost: number, negated = false): void => {
    values.push({ test: elementwise(test), cost, negated, any: test });
  };
  for (const key in condition) {
    const operand = condition[key];
    const here = join(at, key);
    if (operand === undefined) throw new JqlError("the value is undefined; JSON has no undefined, and a condition on nothing would match everything", here);
    count(context, here);
    permit(key, context, here);
    switch (key) {
      case "$options":
        break;
      case "$eq":
      case "$ne": {
        const negated = key === "$ne";
        const reference = referencePath(operand, here);
        if (reference !== undefined) {
          permit("$field", context, here);
          whole.push(compareFields(field, "$eq", reference, negated, context, here));
          break;
        }
        add(equalsValue(operand, ignoreCase, here, context.now), operand !== null && typeof operand === "object" ? 3 : 0, negated);
        break;
      }
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte": {
        const reference = referencePath(operand, here);
        if (reference !== undefined) {
          permit("$field", context, here);
          whole.push(compareFields(field, key, reference, false, context, here));
          break;
        }
        addAny(orderTest(key, operand, here, context.now), 1);
      }
        break;
      case "$in":
        addAny(inTest(operand, ignoreCase, here, context.now), 1);
        break;
      case "$nin":
        addAny(inTest(operand, ignoreCase, here, context.now), 1, true);
        break;
      case "$exists":
        if (typeof operand !== "boolean") throw new JqlError(`takes true or false, not ${describe(operand)}`, here);
        add(isPresent, 0, !operand);
        break;
      case "$type":
        addAny(typeTest(operand, here), 1);
        break;
      case "$contains":
      case "$startsWith":
      case "$endsWith":
      case "$word":
      case "$glob":
        addAny(stringTest(key, operand, ignoreCase, here, context.limits.maxGlobLength), key === "$word" || key === "$glob" ? 4 : 2);
        break;
      case "$regex":
        addAny(regexTest(operand, flags, context.limits, here), 5);
        break;
      case "$mod":
        addAny(modTest(operand, here), 1);
        break;
      case "$size":
        add(sizeTest(operand, context, here, depth, "array"), 1);
        break;
      case "$length":
        add(sizeTest(operand, context, here, depth, "anything with a length"), 1);
        break;
      case "$all":
        add(allTest(operand, ignoreCase, here, context.now), 4);
        break;
      case "$elemMatch": {
        if (!isPlainObject(operand)) throw new JqlError(`takes a query for one element, not ${describe(operand)}`, here);
        const element = compileQuery(operand, context, here, depth + 1);
        const test = element.test;
        add((value) => {
          if (!Array.isArray(value)) return false;
          for (let i = 0; i < value.length; i++) if (test(value[i])) return true;
          return false;
        }, 4 + element.cost);
        break;
      }
      case "$not": {
        if (!isPlainObject(operand) || isDateLiteral(operand) || !Object.keys(operand).every((name) => name.startsWith("$"))) {
          throw new JqlError(`takes a condition such as { "$gt": 5 }, not ${describe(operand)}; to negate a value, use $ne`, here);
        }
        const inner = conditionParts(field, operand, context, here, depth + 1);
        // Only when every part of it is a test on the value can the negation be one too.
        // A `$not` holding something that needs the whole document — a `{ "$field": … }`
        // reference — used to have that part quietly left out of the negation, so
        // `{ a: { $not: { $exists: false, $eq: { $field: "b" } } } }` was answered without
        // ever looking at `b`: a query that reads as restrictive and was not.
        if (field.read !== undefined && inner.whole.length === 0) {
          add(allOfValues(inner.values), inner.values.reduce((sum, value) => sum + value.cost, 0), true);
          break;
        }
        whole.push(negate(combine(field, inner.values, inner.whole)));
        break;
      }
      default: {
        const extension = context.operators.get(key);
        if (extension !== undefined) {
          const test = extension.compile(operand, here);
          if (typeof test !== "function") throw new JqlError(`"${key}" did not build a test, so there is nothing to run`, here);
          const cost = extension.cost ?? 4;
          if (extension.elementwise === false) add(test, cost);
          else addAny(test, cost);
          break;
        }
        const reason = QUERY_OPERATORS.includes(key)
          ? `"${key}" combines whole queries, so it belongs beside field names rather than inside a field's condition`
          : EXTENSION_NAME.test(key)
            ? `"${key}" is an added operator, and this query was compiled without it; pass it in \`operators\``
            : `"${key}" is not an operator${didYouMean(key, [...FIELD_OPERATORS, ...context.operators.keys()])}`;
        throw new JqlError(reason, here);
      }
    }
  }
  return { values, whole };
}

/** Every value test, cheapest first, with negation applied. */
function allOfValues(values: readonly ValueTest[]): Test {
  const tests = [...values].sort((a, b) => a.cost - b.cost).map(({ test, negated }): Test => (negated ? (value) => !test(value) : test));
  if (tests.length === 0) return () => true;
  if (tests.length === 1) return tests[0] as Test;
  if (tests.length === 2) {
    const [a, b] = tests as [Test, Test];
    return (value) => a(value) && b(value);
  }
  return (value) => {
    for (let i = 0; i < tests.length; i++) if (!(tests[i] as Test)(value)) return false;
    return true;
  };
}

const isPresent: Test = (value) => value !== undefined;

/**
 * A test that also holds when it holds for any element of an array value.
 *
 * The whole array is tried first, so `{ tags: ["a", "b"] }` can match the array exactly
 * and `{ tags: "a" }` can match one of its elements.
 */
function elementwise(test: Test): Test {
  return (value) => {
    if (test(value)) return true;
    if (!Array.isArray(value)) return false;
    for (let i = 0; i < value.length; i++) if (test(value[i])) return true;
    return false;
  };
}

/**
 * Applies a value test to whatever the field reaches.
 *
 * A plain property is read inline rather than through its accessor: one call per document
 * instead of two, which on a filter over a large array is most of the engine's own cost.
 */
function holds(field: Field, test: Test, cost: number): Compiled {
  const key = field.key;
  if (key !== undefined) {
    const reach = field.reach;
    const plain = !needsGuard(key);
    return {
      test: (document) => {
        if (document === null || typeof document !== "object") return test(undefined);
        if (Array.isArray(document)) return reach(document, test);
        return test(plain && (document as { __proto__?: unknown }).__proto__ === PLAIN ? (document as Record<string, unknown>)[key] : readOwn(document, key));
      },
      cost: field.cost + cost,
    };
  }
  const read = field.read;
  // A condition on the item itself — what `$size` and `$length` compile their inner
  // condition against — is already a test on the value: wrapping it would call the identity
  // once per document to arrive back where it started.
  if (read === readSelf) return { test, cost: field.cost + cost };
  if (read !== undefined) return { test: (document) => test(read(document)), cost: field.cost + cost };
  const reach = field.reach;
  const probe = field.probe;
  if (probe !== undefined) {
    return {
      test: (document) => {
        const value = probe(document);
        return value === FANOUT ? reach(document, test) : test(value);
      },
      cost: field.cost + cost,
    };
  }
  return { test: (document) => reach(document, test), cost: field.cost + cost };
}

/**
 * A lone operator on a single-valued field, with the look into arrays written inline, so a
 * document costs one call to the operator rather than one to a wrapper and one to it.
 */
function holdsAny(field: Field, test: Test, negated: boolean, cost: number): Compiled {
  const key = field.key;
  if (key === undefined) {
    const read = field.read as Read;
    const single = (value: unknown): boolean => {
      if (test(value)) return true;
      if (!Array.isArray(value)) return false;
      for (let i = 0; i < value.length; i++) if (test(value[i])) return true;
      return false;
    };
    return { test: negated ? (document) => !single(read(document)) : (document) => single(read(document)), cost: field.cost + cost };
  }
  const reach = field.reach;
  const plain = !needsGuard(key);
  const any = (value: unknown): boolean => {
    if (test(value)) return true;
    if (!Array.isArray(value)) return false;
    for (let i = 0; i < value.length; i++) if (test(value[i])) return true;
    return false;
  };
  const hit = (document: unknown): boolean => {
    if (document === null || typeof document !== "object") return test(undefined);
    if (Array.isArray(document)) return reach(document, any);
    return any(plain && (document as { __proto__?: unknown }).__proto__ === PLAIN ? (document as Record<string, unknown>)[key] : readOwn(document, key));
  };
  return { test: negated ? (document) => !hit(document) : hit, cost: field.cost + cost };
}

/** Equality with one literal, looking into arrays. A primitive gets a closure with no inner call. */
function equalsValue(literal: unknown, ignoreCase: boolean, at: string, now: number): Test {
  if (!ignoreCase && (typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean")) {
    checkLiteral(literal, at);
    const wanted = literal;
    // A whole number is also asking about the big integer of the same value (§5.1); every
    // other literal is a single comparison, exactly as before.
    const big = alsoBig(literal);
    if (big !== undefined) return (value) => value === wanted || value === big || (Array.isArray(value) && (value.includes(wanted) || value.includes(big)));
    return (value) => value === wanted || (Array.isArray(value) && value.includes(wanted));
  }
  return elementwise(equalsTest(literal, ignoreCase, at, now));
}

/**
 * Equality, with the case that dominates real use written out in full.
 *
 * `{ id: 2 }` on a plain property compiles to one closure with the read, the comparison and
 * the array fallback inline: no accessor call, no test call. It is the one query that runs
 * as fast as the loop somebody would have written by hand, because it is that loop.
 */
function equality(field: Field, literal: unknown, ignoreCase: boolean, at: string, now: number): Compiled {
  const key = field.key;
  if (key !== undefined && !ignoreCase && (typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean")) {
    checkLiteral(literal, at);
    const wanted = literal;
    const reach = field.reach;
    const plain = !needsGuard(key);
    const test = equalsValue(literal, false, at, now);
    const big = alsoBig(literal);
    // Two closures rather than one with a branch in it: a whole number also stands for the
    // big integer of the same value, and every other literal must not pay for that — nor
    // compare against an `undefined` standing in for "there is no such big integer", which
    // is what a missing field reads as. The read is written out in both, rather than shared
    // through a helper: `{ "id": 2 }` takes this path, and a call per document is most of
    // what this closure costs.
    if (big !== undefined) {
      return {
        test: (document) => {
          if (document === null || typeof document !== "object") return false;
          if (Array.isArray(document)) return reach(document, test);
          const value = plain && (document as { __proto__?: unknown }).__proto__ === PLAIN ? (document as Record<string, unknown>)[key] : readOwn(document, key);
          return value === wanted || value === big || (Array.isArray(value) && (value.includes(wanted) || value.includes(big)));
        },
        cost: 0,
      };
    }
    return {
      test: (document) => {
        if (document === null || typeof document !== "object") return false;
        // An item that is itself an array is seen through, so the walk answers for it.
        if (Array.isArray(document)) return reach(document, test);
        const value = plain && (document as { __proto__?: unknown }).__proto__ === PLAIN ? (document as Record<string, unknown>)[key] : readOwn(document, key);
        return value === wanted || (Array.isArray(value) && value.includes(wanted));
      },
      cost: 0,
    };
  }
  const probe = field.probe;
  if (probe !== undefined && !ignoreCase && (typeof literal === "string" || typeof literal === "number" || typeof literal === "boolean")) {
    checkLiteral(literal, at);
    const wanted = literal;
    const test = equalsValue(literal, false, at, now);
    const reach = field.reach;
    const big = alsoBig(literal);
    if (big !== undefined) {
      return {
        test: (document) => {
          const value = probe(document);
          if (value === wanted || value === big) return true;
          if (value === FANOUT) return reach(document, test);
          return Array.isArray(value) && (value.includes(wanted) || value.includes(big));
        },
        cost: field.cost,
      };
    }
    return {
      test: (document) => {
        const value = probe(document);
        if (value === wanted) return true;
        if (value === FANOUT) return reach(document, test);
        return Array.isArray(value) && value.includes(wanted);
      },
      cost: field.cost,
    };
  }
  return holds(field, equalsValue(literal, ignoreCase, at, now), literal !== null && typeof literal === "object" ? 3 : 0);
}

/**
 * `$size` and `$length`, which differ only in what they will measure.
 *
 * Neither is tried against the elements of an array, unlike the string operators:
 * `{ tags: { $length: 1 } }` would otherwise mean both "one tag" and "a tag one character
 * long", and nothing in the query would say which. A string's length is counted in UTF-16
 * code units — what a cap on an incoming value is counted in, and what JSON's own escape
 * syntax is defined in.
 */
function sizeTest(operand: unknown, context: Context, at: string, depth: number, measures: "array" | "anything with a length"): Test {
  const strings = measures !== "array";
  let length: (size: number) => boolean;
  if (typeof operand === "number") {
    if (!Number.isInteger(operand) || operand < 0) throw new JqlError(`a length is a whole number, not ${operand}`, at);
    length = (size) => size === operand;
  } else if (isPlainObject(operand)) {
    length = compileCondition(SELF, operand, context, at, depth + 1).test;
  } else throw new JqlError(`takes a number or a condition on one, not ${describe(operand)}`, at);
  if (strings) return (value) => (typeof value === "string" || Array.isArray(value)) && length(value.length);
  return (value) => Array.isArray(value) && length(value.length);
}

/**
 * A comparison between two fields of the same item.
 *
 * Both sides are reached the way any path is, so either can fan out over an array, and the
 * comparison holds when **some** pair of values satisfies it — the same "any of them" the
 * rest of the language uses. `$ne` is the negation of that: no pair does.
 *
 * Nothing here reads a value as a date. A `{ "$date": … }` in a query is the query saying
 * what it means; a reference says only where to look, and the item's own values decide.
 */
function compareFields(field: Field, operator: "$eq" | "$gt" | "$gte" | "$lt" | "$lte", path: string, negated: boolean, context: Context, at: string): Compiled {
  const other = resolveField(path, context, at);
  // Settled once: the operator is known here, and asking it again per pair of values was
  // most of what a reference cost.
  const compare = comparer(operator);
  const leftRead = field.read;
  const rightRead = other.read;
  let holdsPair: (document: unknown) => boolean;
  if (leftRead !== undefined && rightRead !== undefined) {
    // Both sides are single-valued — a plain property on each — which is what a reference
    // nearly always is. No walk, no callback: two reads and a comparison.
    holdsPair = (document) => eachOf(leftRead(document), (one) => eachOf(rightRead(document), (two) => compare(one, two)));
  } else {
    const left = field.reach;
    const right = other.reach;
    holdsPair = (document) => left(document, (one) => eachOf(one, (a) => right(document, (two) => eachOf(two, (b) => compare(a, b)))));
  }
  return { test: negated ? (document) => !holdsPair(document) : holdsPair, cost: field.cost + other.cost + 4 };
}

/** One comparison, chosen when the query compiles rather than per pair of values. */
function comparer(operator: "$eq" | "$gt" | "$gte" | "$lt" | "$lte"): (a: unknown, b: unknown) => boolean {
  if (operator === "$eq") return (a, b) => a !== undefined && b !== undefined && valuesEqual(a, b);
  return (a, b) => {
    if (a === undefined || b === undefined) return false;
    const order = orderOf(a, b);
    if (order === undefined) return false;
    switch (operator) {
      case "$gt":
        return order > 0;
      case "$gte":
        return order >= 0;
      case "$lt":
        return order < 0;
      default:
        return order <= 0;
    }
  };
}

/**
 * The path in a `{ "$field": … }` reference, or `undefined` when the operand is not one.
 *
 * A malformed reference is refused here rather than falling through to "compares with a
 * number, a string or a date, not an object", which is a true sentence that tells somebody
 * who wrote `{ "$field": 5 }` nothing about what they got wrong.
 */
function referencePath(operand: unknown, at: string): string | undefined {
  if (!isPlainObject(operand) || !("$field" in operand)) return undefined;
  if (typeof operand.$field !== "string") throw new JqlError(`a {"$field": …} reference takes the path as a string, not ${describe(operand.$field)}`, at);
  const beside = Object.keys(operand).filter((key) => key !== "$field");
  if (beside.length > 0) throw new JqlError(`a {"$field": …} reference holds nothing but the path, and "${beside[0]}" is beside it`, at);
  return operand.$field;
}

/** A value, and then each of its elements when it is an array. */
function eachOf(value: unknown, test: (item: unknown) => boolean): boolean {
  if (test(value)) return true;
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i++) if (test(value[i])) return true;
  return false;
}

/* ------------------------------------------------------------------------------------ */
/* Free text                                                                            */
/* ------------------------------------------------------------------------------------ */

function compileText(value: unknown, context: Context, at: string): Compiled {
  let search: unknown;
  let fields: unknown;
  let caseSensitive: unknown = false;
  if (typeof value === "string") search = value;
  else if (isPlainObject(value)) {
    for (const key in value) {
      if (key !== "$search" && key !== "$fields" && key !== "$caseSensitive") {
        throw new JqlError(`"${key}" is not part of a text search ($search, $fields, $caseSensitive)${didYouMean(key, ["$search", "$fields", "$caseSensitive"])}`, join(at, key));
      }
    }
    search = value.$search;
    fields = value.$fields;
    // Read as written, not defaulted: `?? false` turned an explicit `null` into "no", and
    // `?? vocabulary.text` turned `$fields: null` into a search of the whole item — a
    // narrower question silently becoming a wider one.
    caseSensitive = "$caseSensitive" in value ? value.$caseSensitive : false;
  } else throw new JqlError(`takes a phrase or { "$search": … }, not ${describe(value)}`, at);
  if (typeof search !== "string") throw new JqlError(`the phrase is a string, not ${describe(search)}`, join(at, "$search"));
  if (typeof caseSensitive !== "boolean") throw new JqlError(`takes true or false, not ${describe(caseSensitive)}`, join(at, "$caseSensitive"));

  // The fields are resolved before the phrase is read, because whether a query is a good one
  // cannot depend on how much of it somebody has typed. An empty phrase returned "matches
  // everything" first, so `{ "$search": "", "$fields": 42 }` compiled, and a dashboard that
  // validated its saved filter while the box was empty was told it was fine — until the
  // first letter, when the same filter was refused.
  const names = fields === undefined ? context.vocabulary?.text : fields;
  const reaches = names === undefined ? undefined : textFields(names, context, at);

  const needle = caseSensitive ? search : search.toLowerCase();
  // An empty search box is a question nobody has asked yet, and the answer to that is
  // everything — the same as an empty query.
  if (needle === "") return ALWAYS;
  const found: (text: string) => boolean = caseSensitive ? (text) => text.includes(needle) : (text) => text.toLowerCase().includes(needle);
  // Numbers are searched only when the phrase could be part of one. Formatting every
  // number in every document to look for a word with no digits in it is pure cost.
  const numeric = /\d/.test(needle);
  const maxDepth = context.limits.maxTextDepth;
  const inValue: Test = (item) => containsText(item, found, numeric, maxDepth);

  if (reaches === undefined) return { test: inValue, cost: 20 };
  return {
    test: (document) => {
      for (let i = 0; i < reaches.length; i++) if ((reaches[i] as Reach)(document, inValue)) return true;
      return false;
    },
    cost: 6 + reaches.length * 2,
  };
}

/** The fields a text search looks in, as walks. Refuses a list that could never name any. */
function textFields(names: unknown, context: Context, at: string): Reach[] {
  if (!Array.isArray(names) || names.length === 0) throw new JqlError(`takes a non-empty list of field names, not ${describe(names)}`, join(at, "$fields"));
  return names.map((name, index) => {
    if (typeof name !== "string") throw new JqlError(`a field name is a string, not ${describe(name)}`, `${join(at, "$fields")}[${index}]`);
    return resolveField(name, context, `${join(at, "$fields")}[${index}]`).reach;
  });
}

/**
 * Whether the phrase appears in any string (or number) inside a value.
 *
 * Bounded by depth rather than by tracking what it has visited: a depth cap is free on
 * every document without a cycle, which is almost all of them, and still ends the walk on
 * one that has.
 */
function containsText(value: unknown, found: (text: string) => boolean, numeric: boolean, depth: number): boolean {
  if (typeof value === "string") return found(value);
  if (typeof value === "number" || typeof value === "bigint") return numeric && found(String(value));
  if (value === null || typeof value !== "object" || depth <= 0 || value instanceof Date) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (containsText(value[i], found, numeric, depth - 1)) return true;
    return false;
  }
  if (value instanceof Map || value instanceof Set) {
    for (const item of value.values()) if (containsText(item, found, numeric, depth - 1)) return true;
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) if (Object.hasOwn(record, key) && containsText(record[key], found, numeric, depth - 1)) return true;
  return false;
}

/* ------------------------------------------------------------------------------------ */
/* Combinators                                                                          */
/* ------------------------------------------------------------------------------------ */

/** Every part, cheapest first. Two and three parts get closures of their own rather than a loop. */
function allOf(parts: Compiled[]): Compiled {
  const real = parts.filter((part) => part !== ALWAYS);
  if (real.includes(NOTHING)) return NOTHING;
  if (real.length === 0) return ALWAYS;
  if (real.length === 1) return real[0] as Compiled;
  // Stable, so parts of equal cost keep the order they were written in.
  real.sort((a, b) => a.cost - b.cost);
  const cost = real.reduce((sum, part) => sum + part.cost, 0);
  const tests = real.map((part) => part.test);
  if (tests.length === 2) {
    const [a, b] = tests as [Compiled["test"], Compiled["test"]];
    return { test: (document) => a(document) && b(document), cost };
  }
  if (tests.length === 3) {
    const [a, b, c] = tests as [Compiled["test"], Compiled["test"], Compiled["test"]];
    return { test: (document) => a(document) && b(document) && c(document), cost };
  }
  return {
    test: (document) => {
      for (let i = 0; i < tests.length; i++) if (!(tests[i] as Compiled["test"])(document)) return false;
      return true;
    },
    cost,
  };
}

/** Any part, cheapest first. An empty list matches nothing, as an empty `$in` does. */
function anyOf(parts: Compiled[]): Compiled {
  const real = parts.filter((part) => part !== NOTHING);
  if (real.includes(ALWAYS)) return ALWAYS;
  if (real.length === 0) return NOTHING;
  if (real.length === 1) return real[0] as Compiled;
  real.sort((a, b) => a.cost - b.cost);
  const cost = real.reduce((sum, part) => sum + part.cost, 0);
  const tests = real.map((part) => part.test);
  if (tests.length === 2) {
    const [a, b] = tests as [Compiled["test"], Compiled["test"]];
    return { test: (document) => a(document) || b(document), cost };
  }
  return {
    test: (document) => {
      for (let i = 0; i < tests.length; i++) if ((tests[i] as Compiled["test"])(document)) return true;
      return false;
    },
    cost,
  };
}

function negate(part: Compiled): Compiled {
  if (part === ALWAYS) return NOTHING;
  if (part === NOTHING) return ALWAYS;
  const test = part.test;
  return { test: (document) => !test(document), cost: part.cost };
}

