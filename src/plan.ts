import { type CompileOptions, FIELD_OPERATORS, QUERY_OPERATORS, validate } from "./core.js";
import { JqlError } from "./errors.js";
import { isDateLiteral, isFieldReference, isPlainObject, resolveDate } from "./internal/values.js";
import type { LooseQuery, QueryLike, UntypedQuery } from "./types.js";
import type { Vocabulary } from "./vocabulary.js";

/**
 * Splitting a query between a store and this engine.
 *
 * A backend can usually answer part of a question — an index on a field, an operator it has
 * natively — and nothing of the rest. The shape that works is the one HackerPot's stores
 * already use: push what the store can do, keep what it cannot, and make sure the two
 * together are exactly the question that was asked.
 *
 * That last part is the whole contract, and it is why this splits only on **conjunctions**.
 * A query's keys all have to hold, and so do the parts of an `$and`, so each one can go to
 * either side independently. Anything else — a branch of an `$or`, an operator inside a
 * condition — cannot be split without widening or narrowing what is asked, so a conjunct is
 * pushed whole or not at all:
 *
 *     pushed ∧ remaining ≡ query
 *
 * The store filters with `pushed` and this engine filters what comes back with `remaining`.
 * Neither side is ever wider than the query, so a caller that runs only `pushed` gets too
 * many items rather than too few — but `complete` says when that is safe, and it is the only
 * thing worth checking before skipping the second pass.
 */

export interface Capabilities {
  /**
   * The fields the store can filter on, as the store names them — a path, after any
   * vocabulary alias is resolved. `"all"` for a store that can filter on anything.
   *
   * A vocabulary field that is *computed* is never pushed whatever this says: the store has
   * no way to run a function that lives here.
   */
  readonly fields?: readonly string[] | "all" | undefined;
  /** The operators the store can answer, or `"all"`. Names are JQL's, not the store's. */
  readonly operators?: readonly string[] | "all" | undefined;
  /** Whether the store can answer `$or`. Default `false`: plenty of key-value stores cannot. */
  readonly or?: boolean | undefined;
  /** Whether it can answer a negation — `$not`, `$nor`, `$ne`, `$nin`, `$exists: false`. Default `false`. */
  readonly not?: boolean | undefined;
  /**
   * A last word on one field's condition, for a store whose limits depend on the values
   * rather than only on the operator names.
   *
   * MongoDB is the example this exists for: it answers `$eq` exactly, but not `$eq` against
   * an embedded document (its equality is key-order sensitive where JQL's is not), and not
   * the case-insensitive form of one. Without a say on the values, a target has to choose
   * between dropping `$eq` altogether and pushing a clause that comes back with the wrong
   * rows.
   *
   * The condition is given as written, with a bare value shown as `{ $eq: value }`, and the
   * field under the name the store knows. Returning `false` keeps the clause here.
   */
  readonly accepts?: ((field: string, condition: Readonly<Record<string, unknown>>) => boolean) | undefined;
}

export interface Kept {
  /** Where the conjunct is in the query. */
  readonly at: string;
  /** The conjunct itself. */
  readonly clause: unknown;
  /** Why the store cannot answer it. */
  readonly why: string;
}

export interface Plan {
  /** What the store should filter by, or `undefined` when it can answer nothing. */
  readonly pushed: UntypedQuery | undefined;
  /** What this engine must still filter, or `undefined` when the store answers everything. */
  readonly remaining: UntypedQuery | undefined;
  /** True when `remaining` is `undefined`: the store's answer needs no second pass. */
  readonly complete: boolean;
  /** One entry per conjunct that stayed here, and why. */
  readonly kept: readonly Kept[];
}

const KNOWN = new Set([...FIELD_OPERATORS, ...QUERY_OPERATORS, "$field"]);

/**
 * Splits a query into the part a store can answer and the part that stays here.
 *
 * Relative dates in the pushed part are resolved to instants, so what the store receives is
 * self-contained: `{ "$ago": "1h" }` means nothing to a backend, and resolving it here keeps
 * both halves of the split judged against the same moment.
 */
export function plan<T, Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, capabilities: Capabilities, options: CompileOptions<Extra> = {}): Plan {
  if (typeof query === "function") throw new TypeError("a compiled predicate cannot be split: it is code, not a query");
  // Refusing an invalid query here rather than handing half of it to a store, which would
  // find out later and with less to say about it.
  const verdict = validate(query, options as CompileOptions<object>);
  if (!verdict.valid) throw verdict.error;

  const now = options.now === undefined ? Date.now() : options.now();
  const vocabulary = options.vocabulary as Vocabulary<unknown, object> | undefined;
  const fields = capabilities.fields ?? "all";
  const operators = capabilities.operators ?? "all";
  const context: Splitting = {
    vocabulary,
    now,
    fields: fields === "all" ? "all" : new Set(fields),
    operators: operators === "all" ? "all" : new Set(operators),
    or: capabilities.or ?? false,
    not: capabilities.not ?? false,
    accepts: capabilities.accepts,
  };

  const pushed: Record<string, unknown>[] = [];
  const stays: Record<string, unknown>[] = [];
  const kept: Kept[] = [];
  for (const { clause, at } of conjuncts(query as LooseQuery, "")) {
    const why = unpushable(clause, context, at);
    if (why === undefined) pushed.push(resolve(clause, context) as Record<string, unknown>);
    else {
      stays.push(clause);
      kept.push({ at, clause, why });
    }
  }
  return {
    pushed: join(pushed),
    remaining: join(stays),
    complete: stays.length === 0,
    kept,
  };
}

interface Splitting {
  readonly vocabulary: Vocabulary<unknown, object> | undefined;
  readonly now: number;
  readonly fields: ReadonlySet<string> | "all";
  readonly operators: ReadonlySet<string> | "all";
  readonly or: boolean;
  readonly not: boolean;
  readonly accepts: ((field: string, condition: Readonly<Record<string, unknown>>) => boolean) | undefined;
}

/** The parts of a query that all have to hold: its keys, and the parts of any `$and`. */
function conjuncts(query: LooseQuery, at: string): { clause: Record<string, unknown>; at: string }[] {
  const out: { clause: Record<string, unknown>; at: string }[] = [];
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    const here = at === "" ? key : `${at}.${key}`;
    // A comment asks nothing, so neither side needs it.
    if (key === "$comment") continue;
    if (key === "$and" && Array.isArray(value)) {
      value.forEach((part, index) => {
        if (isPlainObject(part)) out.push(...conjuncts(part as LooseQuery, `${here}[${index}]`));
      });
      continue;
    }
    out.push({ clause: { [key]: value }, at: here });
  }
  return out;
}

function join(parts: readonly Record<string, unknown>[]): UntypedQuery | undefined {
  if (parts.length === 0) return undefined;
  const query = parts.length === 1 ? (parts[0] as Record<string, unknown>) : { $and: parts };
  return query as unknown as UntypedQuery;
}

/** Why the store cannot answer this conjunct, or `undefined` when it can. */
function unpushable(clause: Record<string, unknown>, context: Splitting, at: string): string | undefined {
  for (const [key, value] of Object.entries(clause)) {
    const here = at === "" ? key : `${at}.${key}`;
    if (key.startsWith("$")) {
      const why = unpushableOperator(key, value, context, here);
      if (why !== undefined) return why;
      continue;
    }
    const why = unpushableField(key, value, context, here);
    if (why !== undefined) return why;
  }
  return undefined;
}

function unpushableOperator(key: string, value: unknown, context: Splitting, at: string): string | undefined {
  switch (key) {
    case "$and":
      if (!Array.isArray(value)) return "the clause is malformed";
      for (const part of value) {
        if (!isPlainObject(part)) return "the clause is malformed";
        const why = unpushable(part as Record<string, unknown>, context, at);
        if (why !== undefined) return why;
      }
      return undefined;
    case "$or":
    case "$nor": {
      if (!context.or && key === "$or") return "the store cannot answer an $or";
      if (!context.not && key === "$nor") return "the store cannot answer a negation";
      if (!context.or && key === "$nor") return "the store cannot answer an $or";
      if (!Array.isArray(value) || value.length === 0) return "the clause is malformed";
      for (const part of value) {
        if (!isPlainObject(part)) return "the clause is malformed";
        // Every branch, because a branch left here would widen the other half.
        const why = unpushable(part as Record<string, unknown>, context, at);
        if (why !== undefined) return why;
      }
      return undefined;
    }
    case "$not": {
      if (!context.not) return "the store cannot answer a negation";
      if (!isPlainObject(value)) return "the clause is malformed";
      return unpushable(value as Record<string, unknown>, context, at);
    }
    case "$text":
      return allows(context, "$text") ? undefined : "the store cannot answer a text search";
    default:
      // A field operator at the top of a query tests the item itself, which no store does.
      return `the store cannot test the item itself with "${key}"`;
  }
}

function unpushableField(name: string, value: unknown, context: Splitting, at: string): string | undefined {
  const field = context.vocabulary?.lookup.get(name.toLowerCase());
  if (field?.get !== undefined) return `"${name}" is computed here, so the store has no such field`;
  // The same resolution the pushed clause gets, so what is checked against the capabilities
  // is the name the store will actually be asked about. Checked one way and pushed another,
  // `city.zone` was tested as itself and sent as `address.city.zone`.
  const stored = storedName(name, context);
  if (context.fields !== "all" && !context.fields.has(stored)) return `the store cannot filter on "${stored}"`;

  if (isFieldReference(value)) return allows(context, "$field") ? undefined : "the store cannot compare two fields";
  if (!isPlainObject(value) || isDateLiteral(value)) {
    if (!allows(context, "$eq")) return 'the store cannot answer "$eq"';
    return accepted(context, stored, { $eq: value });
  }
  const keys = Object.keys(value);
  if (!keys.every((key) => key.startsWith("$"))) {
    if (!allows(context, "$eq")) return 'the store cannot answer "$eq"';
    return accepted(context, stored, { $eq: value });
  }

  for (const key of keys) {
    if (key === "$options" || key === "$comment") continue;
    if (!KNOWN.has(key)) return `"${key}" is an added operator, which only this engine has`;
    if (!allows(context, key)) return `the store cannot answer "${key}"`;
    if ((key === "$ne" || key === "$nin" || key === "$not" || (key === "$exists" && value[key] === false)) && !context.not) {
      return "the store cannot answer a negation";
    }
    const operand = value[key];
    if (isFieldReference(operand) && !allows(context, "$field")) return "the store cannot compare two fields";
    if (key === "$elemMatch") {
      if (!isPlainObject(operand)) return "the clause is malformed";
      const why = unpushable(operand as Record<string, unknown>, context, at);
      if (why !== undefined) return why;
    }
    if (key === "$not") {
      if (!isPlainObject(operand)) return "the clause is malformed";
      const why = unpushableField(name, operand, context, at);
      if (why !== undefined) return why;
    }
  }
  return accepted(context, stored, value);
}

/** The store's own last word on a condition it could otherwise answer. */
function accepted(context: Splitting, field: string, condition: Readonly<Record<string, unknown>>): string | undefined {
  if (context.accepts === undefined || context.accepts(field, condition)) return undefined;
  return "the store cannot answer this condition's values";
}

function allows(context: Splitting, operator: string): boolean {
  return context.operators === "all" || context.operators.has(operator);
}

/**
 * The clause as the store should receive it: field names it knows, and instants rather than
 * durations.
 *
 * Both rewrites exist for the same reason — what is pushed has to stand on its own. A store
 * cannot read `{ "$ago": "1h" }`, and resolving it here, once, from the same clock the
 * engine uses, keeps both halves of the split talking about the same hour.
 *
 * And a **vocabulary name is local to this process.** The capability check asks whether the
 * store can filter on `customer.country`; handing it `{ "cc": "GB" }` afterwards asks about
 * a field the store has never heard of, which answers nothing — while `complete` says no
 * second pass is needed. That combination is a filter that looks answered and returns an
 * empty page, so the names go out resolved.
 */
function resolve(value: unknown, context: Splitting): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) {
    switch (key) {
      case "$and":
      case "$or":
      case "$nor":
        out[key] = Array.isArray(held) ? held.map((part) => resolve(part, context)) : held;
        break;
      case "$not":
        out[key] = resolve(held, context);
        break;
      case "$text":
        out[key] = resolveText(held, context);
        break;
      default:
        // A field key is renamed to what the store calls it; anything else at this level is
        // an operator testing the item itself, whose operand is a condition's like any other.
        if (key.startsWith("$")) out[key] = resolveOperand(key, held, context);
        else out[storedName(key, context)] = resolveCondition(held, context);
        break;
    }
  }
  return out;
}

/** A field's condition, with its operands resolved and its *literals* left alone. */
function resolveCondition(value: unknown, context: Splitting): unknown {
  if (!isPlainObject(value)) return resolveLiteral(value, context);
  if (isDateLiteral(value) || isFieldReference(value)) return resolveOperand("$eq", value, context);
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => key.startsWith("$"))) return resolveLiteral(value, context);
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = resolveOperand(key, value[key], context);
  return out;
}

function resolveOperand(key: string, operand: unknown, context: Splitting): unknown {
  // A query, not a value.
  if (key === "$elemMatch") return resolve(operand, context);
  if (key === "$not") return resolveCondition(operand, context);
  // The one place a field name stands where a value would: it names a field, so it is
  // resolved like one. Left as written, the store was asked to compare with a field it has
  // no name for, and matched nothing.
  if (isFieldReference(operand)) return { $field: storedName(operand.$field, context) };
  if (Array.isArray(operand)) return operand.map((item) => (isFieldReference(item) ? { $field: storedName(item.$field, context) } : resolveLiteral(item, context)));
  return resolveLiteral(operand, context);
}

/** A text search: the fields it names are fields, and are resolved as such. */
function resolveText(value: unknown, context: Splitting): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.$fields)) return value;
  return { ...value, $fields: value.$fields.map((name) => (typeof name === "string" ? storedName(name, context) : name)) };
}

/**
 * A value being compared with: dates become instants, and nothing else is touched.
 *
 * Its keys in particular are **not** renamed. Walked as though it were a query,
 * `{ name: { $eq: { city: "Paris" } } }` was pushed as a comparison with
 * `{ "address.city": "Paris" }` — an object no document holds — while `complete` said the
 * store had answered.
 */
function resolveLiteral(value: unknown, context: Splitting): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveLiteral(item, context));
  if (!isPlainObject(value)) return value;
  if (isDateLiteral(value)) {
    const time = resolveDate(value.$date, context.now);
    if (Number.isNaN(time)) throw new JqlError(`${JSON.stringify(value.$date)} is not a date`);
    return { $date: time };
  }
  const out: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) out[key] = resolveLiteral(held, context);
  return out;
}

/** A field name as the store knows it: the vocabulary's path, or the name as written. */
function storedName(key: string, context: Splitting): string {
  if (key.startsWith("$") || context.vocabulary === undefined) return key;
  const field = context.vocabulary.lookup.get(key.toLowerCase());
  if (field !== undefined) return field.path;
  // A path that begins with a vocabulary name — `country.region` — is that field's path and
  // the rest of the walk.
  const dot = key.indexOf(".");
  if (dot > 0) {
    const head = context.vocabulary.lookup.get(key.slice(0, dot).toLowerCase());
    if (head !== undefined && head.get === undefined) return `${head.path}${key.slice(dot)}`;
  }
  return key;
}
