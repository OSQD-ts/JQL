/**
 * Reaching a field inside a document.
 *
 * A path is dot-separated: `address.city`, `items.id`, `items.0.id`. Three rules:
 *
 * - **An array is seen through.** `items.id` reaches the `id` of every element, and a
 *   condition on it holds when it holds for any of them.
 * - **A numeric segment on an array is a position.** `items.0.id` is the first element's.
 * - **A `Map` is read by key**, so a document that keeps a lookup table in a `Map` can be
 *   queried the same way as one that keeps it in an object.
 *
 * Only own properties are read. `{ constructor: { $exists: true } }` would otherwise match
 * every object ever made, and `__proto__` would reach somewhere a query has no business
 * being. The check costs a `hasOwn` call, so it is paid only for the handful of names
 * `Object.prototype` and `Map.prototype` actually have — every other name is read
 * directly. `Map.prototype` is on the list because a `Map` document read directly would
 * answer `size` or `get` with its own method rather than with the entry of that name.
 */

/**
 * Calls `test` with each value the path reaches, stopping at the first `true`.
 *
 * A path that reaches nothing calls `test(undefined)` once, so "missing" is a value a
 * condition can ask about: that is how `{ field: null }` and `$exists: false` see it.
 */
export type Reach = (document: unknown, test: (value: unknown) => boolean) => boolean;

/** A single-valued read, for paths that cannot fan out. Absent when the path can. */
export type Read = (document: unknown) => unknown;

/** What a probe returns when the path met an array before its last segment, and so may reach several values. */
export const FANOUT: unique symbol = Symbol("jql.fanout");

/**
 * A straight read of a multi-segment path: the one value it reaches, or `FANOUT` if an
 * array stood in the way and only `Reach` can answer.
 *
 * The point is the common case. `address.city` on a record with no arrays on the way has
 * exactly one value, and reading it directly lets the engine test it the way a hand-written
 * `p.address.city === "x"` would — one read, one comparison — instead of through a walk and
 * a callback. A missing or primitive step reads as `undefined`, the same as `Reach` sees it.
 */
export type Probe = (document: unknown) => unknown;

interface Segment {
  readonly key: string;
  /** The position this segment names on an array, or -1. */
  readonly index: number;
}

const INDEX = /^(?:0|[1-9]\d{0,8})$/;

/**
 * The names a plain object inherits, which are therefore the only ones a direct read can
 * find on one by accident.
 */
const INHERITED = new Set<string>([...Object.getOwnPropertyNames(Object.prototype), ...Object.getOwnPropertyNames(Map.prototype), "__proto__"]);

/** Whether a name could be found on a plain object's prototype, and so must always be asked for carefully. */
export function needsGuard(key: string): boolean {
  return INHERITED.has(key);
}

/**
 * What a plain object's prototype is, for the cheapest plainness test there is.
 *
 * `document.__proto__ === PLAIN` is a map check — about as fast as reading a field — where
 * `Object.getPrototypeOf` is a call and `Object.hasOwn` is a second lookup. Reading it is
 * safe in both directions: a document carrying its own `__proto__` field (which is what
 * `JSON.parse` makes of one) simply fails the test and takes the careful path, and so does
 * anything with a prototype of its own.
 */
export const PLAIN = Object.prototype;

function segment(key: string): Segment {
  return { key, index: INDEX.test(key) ? Number(key) : -1 };
}

/**
 * One field of one value: own properties and `Map` entries, nothing else.
 *
 * Ownership is checked **before** the read, not after, and for every name rather than for a
 * list of known-inherited ones. The list was only ever `Object.prototype` and
 * `Map.prototype`, so a document that was a class instance answered `{ role: "admin" }` from
 * its prototype — and `{ secret: … }` by *running* an inherited getter, which is a query
 * executing code the document's author wrote. Asking first is also why no accessor outside
 * the item can run at all.
 */
export function readOwn(value: object, key: string): unknown {
  if (value instanceof Map) return value.get(key);
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function readOne(value: object, step: Segment): unknown {
  return readOwn(value, step.key);
}

/**
 * The value at a single-segment path.
 *
 * The overwhelmingly common case — `{ id: 2 }` — so it is written out: a direct property
 * read, with the `Map` check paid only when the read found nothing, which a plain object
 * with the field never does.
 */
export function readKey(key: string): Read {
  return (document) => (document !== null && typeof document === "object" ? readOwn(document, key) : undefined);
}

/** The whole document, for queries that are conditions on the value itself. */
export const readSelf: Read = (document) => document;

/**
 * Builds the walk for a multi-segment path.
 *
 * A loop while the path meets only objects, which is nearly always, and the recursive
 * fan-out only from the first array it meets. `address.city` on a record with no arrays in
 * it costs two property reads and one call.
 */
export function reachPath(keys: readonly string[]): Reach {
  const steps = keys.map(segment);
  return (document, test) => {
    let value = document;
    for (let at = 0; at < steps.length; at++) {
      if (value === null || typeof value !== "object") return test(undefined);
      if (Array.isArray(value)) return walk(value, steps, at, test);
      value = readOne(value, steps[at] as Segment);
    }
    return test(value);
  };
}

/** Builds the straight read for a multi-segment path. */
export function probePath(keys: readonly string[]): Probe {
  const steps = keys.map(segment);
  const last = steps.length - 1;
  const [first, second] = steps as [Segment, Segment];
  if (steps.length === 1 && first.index === -1) {
    // One segment, which is nearly every query: one read, and `FANOUT` where the item is
    // itself an array, because an array is seen through at every segment including the first.
    const only = first.key;
    const guarded = needsGuard(only);
    return (document) => {
      if (document === null || typeof document !== "object") return undefined;
      if (Array.isArray(document)) return FANOUT;
      // Written out rather than calling `readOwn`: the call costs about as much as the work
      // it does, and this runs once per document per field.
      if (!guarded && (document as { __proto__?: unknown }).__proto__ === PLAIN) return (document as Record<string, unknown>)[only];
      return readOwn(document, only);
    };
  }
  if (steps.length === 2 && first.index === -1 && second.index === -1) {
    // `a.b`, the shape nearly every nested field has, written out: two reads, no loop.
    const outer = first.key;
    const inner = second.key;
    const outerGuarded = needsGuard(outer);
    const innerGuarded = needsGuard(inner);
    return (document) => {
      if (document === null || typeof document !== "object") return undefined;
      if (Array.isArray(document)) return FANOUT;
      const value =
        !outerGuarded && (document as { __proto__?: unknown }).__proto__ === PLAIN ? (document as Record<string, unknown>)[outer] : readOwn(document, outer);
      if (value === null || typeof value !== "object") return undefined;
      if (Array.isArray(value)) return FANOUT;
      return !innerGuarded && (value as { __proto__?: unknown }).__proto__ === PLAIN ? (value as Record<string, unknown>)[inner] : readOwn(value, inner);
    };
  }
  return (document) => {
    let value = document;
    for (let at = 0; at <= last; at++) {
      if (value === null || typeof value !== "object") return undefined;
      if (Array.isArray(value) && (steps[at] as Segment).index === -1) return FANOUT;
      const step = steps[at] as Segment;
      value = Array.isArray(value) ? value[step.index] : readOwn(value, step.key);
    }
    return value;
  };
}

/** The same, from a value some other accessor produced. */
export function probeFrom(read: Read, keys: readonly string[]): Probe {
  const probe = probePath(keys);
  return (document) => probe(read(document));
}

/** Continues a walk from a value some other accessor produced. */
export function reachFrom(read: Read, keys: readonly string[]): Reach {
  const steps = keys.map(segment);
  return (document, test) => walk(read(document), steps, 0, test);
}

/**
 * How deep a document may nest before a path stops descending.
 *
 * Every other walk in this library is bounded — the text search by its own limit, equality
 * and sorting by theirs — and this one was not, so a document holding ten thousand nested
 * arrays threw a `RangeError` out of the predicate. That is reachable from a JSON body,
 * whose parser has no such limit, and it aborts a whole scan over one row. Past the cap the
 * value is treated as missing, which is what a path that cannot reach something means
 * everywhere else.
 */
const MAX_DOCUMENT_DEPTH = 512;

function walk(value: unknown, steps: readonly Segment[], at: number, test: (value: unknown) => boolean, depth = 0): boolean {
  if (at === steps.length) return test(value);
  if (value === null || typeof value !== "object" || depth > MAX_DOCUMENT_DEPTH) return test(undefined);
  const step = steps[at] as Segment;
  if (Array.isArray(value)) {
    if (step.index !== -1) return walk(value[step.index], steps, at + 1, test, depth + 1);
    // Fan out: the same segment, applied to each element.
    if (value.length === 0) return test(undefined);
    for (let i = 0; i < value.length; i++) if (walk(value[i], steps, at, test, depth + 1)) return true;
    return false;
  }
  return walk(readOne(value, step), steps, at + 1, test, depth + 1);
}

/**
 * How many segments a path may have.
 *
 * The same number as the document depth above, and for the same reason: a path longer than
 * the deepest document a walk will follow can reach nothing anyway, so refusing it costs a
 * query nothing real. What it buys is two things. A field name is the one part of a query
 * whose size the node count does not bound — `{"a.a.a…": 1}` is a single node however long
 * it is — and each segment becomes an object and a step in a walk, so a field name pasted
 * from somewhere could turn a small query into a large one.
 *
 * And it makes the same path mean the same thing everywhere. Projection walked its own tree
 * of segments and stopped at sixty-four, silently, so a query matched on a path that
 * `fields` then dropped from the result: the filter and the projection disagreed about a
 * path they were both given.
 */
export const MAX_PATH_SEGMENTS = 512;

/**
 * Splits a field name into segments, refusing the ones that can reach nothing.
 *
 * Returns the reason as a sentence for the caller to raise, so this module stays free of
 * the error type and its location bookkeeping.
 */
export function splitPath(path: string): string[] | string {
  if (path === "") return "an empty field name reaches nothing";
  const keys = path.split(".");
  if (keys.length > MAX_PATH_SEGMENTS) {
    return `the path has ${keys.length} segments, past the limit of ${MAX_PATH_SEGMENTS}; nothing nests that deep`;
  }
  // The path is shown shortened: it is a string from outside, and one long enough to be
  // worth refusing is long enough to bury the sentence explaining why.
  for (const key of keys) if (key === "") return `the path "${path.length > 80 ? `${path.slice(0, 80)}…` : path}" has an empty segment, which reaches nothing`;
  return keys;
}
