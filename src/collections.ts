import { type CompileOptions, compile } from "./core.js";
import { setField } from "./internal/record.js";
import type { Matcher, QueryLike, Source } from "./types.js";

/**
 * Running a query over a collection.
 *
 * Every helper takes anything that holds items: an array, an array-like (a typed array,
 * `arguments`, a `NodeList`), any iterable (a `Set`, a generator), or a `Map` — which is
 * read by value, because a query about "the user whose name is Ada" is a question about
 * the users, not about the keys they happen to be filed under. `filterMap` and
 * `filterRecord` keep the keys for the times they matter.
 *
 * Arrays and array-likes are walked with an index rather than an iterator: the iterator
 * protocol allocates a result object per step, and on the collection sizes this library
 * is meant for, that allocation is most of the cost of the walk.
 */

type Items<T> = Source<T> | ReadonlyMap<unknown, T>;

/** Calls `visit` for each item until it returns `true`. Returns the index it stopped at, or -1. */
function walk<T>(source: Items<T>, visit: (item: T) => boolean): number {
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) if (visit(source[i] as T)) return i;
    return -1;
  }
  if (source instanceof Map) {
    let i = 0;
    for (const item of source.values()) {
      if (visit(item as T)) return i;
      i++;
    }
    return -1;
  }
  if (typeof (source as Iterable<T>)[Symbol.iterator] === "function") {
    let i = 0;
    for (const item of source as Iterable<T>) {
      if (visit(item)) return i;
      i++;
    }
    return -1;
  }
  const list = source as ArrayLike<T>;
  for (let i = 0; i < list.length; i++) if (visit(list[i] as T)) return i;
  return -1;
}

/** The first item that matches, or `undefined`. Stops at the first match. */
export function find<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V | undefined;
export function find<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T | undefined;
export function find<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): T | undefined {
  const test = compile(query, options);
  let found: T | undefined;
  walk(source, (item) => {
    if (!test(item)) return false;
    found = item;
    return true;
  });
  return found;
}

/** The position of the first item that matches, or -1. For a `Map`, the position in insertion order. */
export function findIndex<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
export function findIndex<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
export function findIndex<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): number {
  return walk(source, compile(query, options));
}

/** Every item that matches, in order, as a new array. */
export function filter<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V[];
export function filter<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
export function filter<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): T[] {
  const test = compile(query, options);
  const out: T[] = [];
  walk(source, (item) => {
    if (test(item)) out.push(item);
    return false;
  });
  return out;
}

/** How many items match. Counts in place rather than building the list it would count. */
export function count<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
export function count<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
export function count<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): number {
  const test = compile(query, options);
  let total = 0;
  walk(source, (item) => {
    if (test(item)) total++;
    return false;
  });
  return total;
}

/** Whether any item matches. Stops at the first. */
export function some<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
export function some<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
export function some<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): boolean {
  return walk(source, compile(query, options)) !== -1;
}

/** Whether every item matches. True for an empty collection. Stops at the first that does not. */
export function every<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
export function every<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
export function every<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): boolean {
  const test = compile(query, options);
  return walk(source, (item) => !test(item)) === -1;
}

/** The matches and the rest, in one pass. */
export function partition<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): [V[], V[]];
export function partition<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): [T[], T[]];
export function partition<T>(source: Items<T>, query: QueryLike<T, object>, options?: CompileOptions<object>): [T[], T[]] {
  const test = compile(query, options);
  const yes: T[] = [];
  const no: T[] = [];
  walk(source, (item) => {
    (test(item) ? yes : no).push(item);
    return false;
  });
  return [yes, no];
}

/** The entries of a `Map` whose value matches, as a new `Map` with the same keys. */
export function filterMap<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): Map<K, V> {
  const test: Matcher<V> = compile(query, options);
  const out = new Map<K, V>();
  for (const [key, value] of source) if (test(value)) out.set(key, value);
  return out;
}

/**
 * The properties of a plain object whose value matches, as a new object.
 *
 * Own enumerable properties only — the same ones `Object.entries` sees.
 */
export function filterRecord<V, Extra extends object = {}>(source: Readonly<Record<string, V>>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): Record<string, V> {
  const test: Matcher<V> = compile(query, options);
  const out: Record<string, V> = {};
  for (const key of Object.keys(source)) {
    const value = source[key] as V;
    if (test(value)) setField(out as Record<string, unknown>, key, value);
  }
  return out;
}

/** The first value of a plain object that matches, with its key. */
export function findEntry<V, Extra extends object = {}>(source: Readonly<Record<string, V>>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): [string, V] | undefined;
export function findEntry<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): [K, V] | undefined;
export function findEntry<V>(source: ReadonlyMap<unknown, V> | Readonly<Record<string, V>>, query: QueryLike<V, object>, options?: CompileOptions<object>): [unknown, V] | undefined {
  const test: Matcher<V> = compile(query, options);
  if (source instanceof Map) {
    for (const [key, value] of source) if (test(value)) return [key, value];
    return undefined;
  }
  const record = source as Readonly<Record<string, V>>;
  for (const key of Object.keys(record)) {
    const value = record[key] as V;
    if (test(value)) return [key, value];
  }
  return undefined;
}
