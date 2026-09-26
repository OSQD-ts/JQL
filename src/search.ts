import { type CompileOptions, compile, reachField } from "./core.js";
import { JqlError } from "./errors.js";
import { didYouMean } from "./internal/closest.js";
import { compareValues, sortValue } from "./internal/order.js";
import { MAX_PATH_SEGMENTS, readOwn, splitPath } from "./internal/path.js";
import { setField } from "./internal/record.js";
import { describe, isPlainObject } from "./internal/values.js";
import type { Reach } from "./internal/path.js";
import type { FieldName, QueryLike, Request, Source } from "./types.js";
import { checkVocabulary, type Vocabulary } from "./vocabulary.js";

/**
 * A whole request — which items, in which order, which page, which fields — in one pass.
 *
 * Two things make this cheaper than `filter` then `sort` then `slice`:
 *
 * - **Without a sort, it stops early.** The first page of matches is the first
 *   `skip + limit` of them, so the walk ends there instead of testing the rest.
 * - **With a sort and a limit, it keeps only the best `skip + limit`**, in a bounded heap,
 *   rather than sorting every match to keep a few: O(n log k) instead of O(n log n), and
 *   memory for k items rather than all of them. "The ten slowest requests" out of a
 *   million sorts ten.
 *
 * Sort keys are read once per match, not once per comparison.
 *
 * The sort is stable: items that tie on every key keep the order they arrived in, so
 * paging through a sorted result never shows an item twice or skips one.
 */

const REQUEST_KEYS = ["where", "sort", "skip", "limit", "fields", "omit"];

interface SortKey {
  readonly reach: Reach;
  readonly descending: boolean;
}

interface Ranked<T> {
  readonly item: T;
  readonly keys: readonly unknown[];
  readonly index: number;
}

type Items<T> = Source<T> | ReadonlyMap<unknown, T>;

/**
 * Runs a request. With `fields`, each result is a new object holding only those paths.
 *
 * A `Map` is read by value, like everywhere else in this library, so its overloads come
 * first: a `Map` also satisfies `Iterable<[key, value]>`, and without them the types would
 * describe a request over the pairs while the code ran one over the values.
 */
export function search<K, V, Extra extends object = {}>(
  source: ReadonlyMap<K, V>,
  request: Request<V, NoInfer<Extra>> & { readonly fields: readonly FieldName<V, NoInfer<Extra>>[] },
  options?: CompileOptions<Extra>,
): Record<string, unknown>[];
export function search<K, V, Extra extends object = {}>(
  source: ReadonlyMap<K, V>,
  request: Request<V, NoInfer<Extra>> & { readonly omit: readonly FieldName<V, NoInfer<Extra>>[] },
  options?: CompileOptions<Extra>,
): Partial<V>[];
export function search<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, request?: Request<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V[];
export function search<T, Extra extends object = {}>(
  source: Items<T>,
  request: Request<T, NoInfer<Extra>> & { readonly fields: readonly FieldName<T, NoInfer<Extra>>[] },
  options?: CompileOptions<Extra>,
): Record<string, unknown>[];
export function search<T, Extra extends object = {}>(
  source: Items<T>,
  request: Request<T, NoInfer<Extra>> & { readonly omit: readonly FieldName<T, NoInfer<Extra>>[] },
  options?: CompileOptions<Extra>,
): Partial<T>[];
export function search<T, Extra extends object = {}>(source: Items<T>, request?: Request<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
export function search<T>(source: Items<T>, request: Request<T, object> = {}, options: CompileOptions<object> = {}): T[] | Record<string, unknown>[] {
  // Through `planRequest`, which is what it is for: the paging, the heap and the projection
  // are one copy, shared with the asynchronous helpers. Written out here as well — which it
  // was — the two were free to drift, and "the best twenty, skipping forty" would have meant
  // whatever each of them happened to say.
  const plan = planRequest<T>(request, options);
  const collect = plan.collect();
  const test = plan.test;
  each(source, (item, index) => {
    if (test !== undefined && !test(item)) return false;
    return collect.offer(item, index);
  });
  return plan.shape(collect.finish()) as T[];
}

/**
 * Everything about a request that does not depend on where the items come from.
 *
 * Pulled out so the asynchronous helpers run the same paging, the same heap and the same
 * projection as the synchronous ones. Two copies of "the best twenty, skipping forty"
 * would be two chances to page differently.
 */
export function planRequest<T>(request: Request<T, object>, options: CompileOptions<object>): {
  collect: () => Collector<T>;
  test: ((item: T) => boolean) | undefined;
  shape: (items: T[]) => unknown[];
} {
  if (!isPlainObject(request)) throw new JqlError(`a request is an object, not ${describe(request)}`);
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.includes(key)) throw new JqlError(`"${key}" is not part of a request (${REQUEST_KEYS.join(", ")})${didYouMean(key, REQUEST_KEYS)}`, key);
  }
  const vocabulary = checkVocabulary(options.vocabulary) as Vocabulary<unknown, object> | undefined;
  const test = request.where === undefined ? undefined : compile(request.where as QueryLike<T, object>, options);
  const skip = count(request.skip, "skip") ?? 0;
  const limit = count(request.limit, "limit");
  const keys = sortKeys(request.sort, vocabulary);
  const project = request.fields === undefined ? undefined : projector(request.fields, vocabulary);
  const drop = request.omit === undefined ? undefined : redactor(request.omit, vocabulary);
  return {
    collect: () => collector<T>(keys, skip, limit),
    test,
    shape: (items) => {
      const projected = project === undefined ? items : items.map(project);
      return drop === undefined ? projected : projected.map(drop);
    },
  };
}

/** Gathers the page as items arrive. `offer` returns true once nothing further can change the answer. */
export interface Collector<T> {
  offer(item: T, index: number): boolean;
  finish(): T[];
}

function collector<T>(keys: readonly SortKey[], skip: number, limit: number | undefined): Collector<T> {
  return keys.length === 0 ? inOrder<T>(skip, limit) : ranked<T>(keys, skip, limit);
}

function count(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new JqlError(`is a whole number of items, zero or more, not ${describe(value)}`, name);
  }
  return value;
}

function sortKeys(sort: unknown, vocabulary: Vocabulary<unknown, object> | undefined): SortKey[] {
  if (sort === undefined) return [];
  if (!isPlainObject(sort)) throw new JqlError(`is an object of field names to directions, not ${describe(sort)}`, "sort");
  return Object.keys(sort).map((name) => {
    const direction = sort[name];
    const at = `sort.${name}`;
    if (direction !== 1 && direction !== -1 && direction !== "asc" && direction !== "desc") {
      throw new JqlError(`a direction is 1, -1, "asc" or "desc", not ${describe(direction)}`, at);
    }
    return { reach: reachField(name, vocabulary, at), descending: direction === -1 || direction === "desc" };
  });
}

/** Calls `visit` with each item and its position until it returns `true`. */
function each<T>(source: Items<T>, visit: (item: T, index: number) => boolean): void {
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) if (visit(source[i] as T, i)) return;
    return;
  }
  const iterable: Iterable<T> | undefined =
    source instanceof Map ? (source.values() as Iterable<T>) : typeof (source as Iterable<T>)[Symbol.iterator] === "function" ? (source as Iterable<T>) : undefined;
  if (iterable === undefined) {
    const list = source as ArrayLike<T>;
    for (let i = 0; i < list.length; i++) if (visit(list[i] as T, i)) return;
    return;
  }
  let i = 0;
  for (const item of iterable) if (visit(item, i++)) return;
}

/** Without a sort, the page is the first `skip + limit` matches, and the walk can stop there. */
function inOrder<T>(skip: number, limit: number | undefined): Collector<T> {
  const out: T[] = [];
  let passed = 0;
  return {
    offer(item) {
      if (limit === 0) return true;
      if (passed < skip) {
        passed++;
        return false;
      }
      out.push(item);
      return limit !== undefined && out.length >= limit;
    },
    finish: () => out,
  };
}

/** With a sort and a limit, only the best `skip + limit` are ever held. */
function ranked<T>(keys: readonly SortKey[], skip: number, limit: number | undefined): Collector<T> {
  const compare = (a: Ranked<T>, b: Ranked<T>): number => {
    for (let i = 0; i < keys.length; i++) {
      const order = compareValues(a.keys[i], b.keys[i]);
      if (order !== 0) return (keys[i] as SortKey).descending ? -order : order;
    }
    return a.index - b.index;
  };
  const keep = limit === undefined ? Number.POSITIVE_INFINITY : skip + limit;
  const heap: Ranked<T>[] = [];
  return {
    offer(item, index) {
      if (limit === 0) return true;
      const entry: Ranked<T> = { item, keys: keys.map((key) => keyOf(item, key)), index };
      if (heap.length < keep) {
        heap.push(entry);
        if (keep !== Number.POSITIVE_INFINITY) siftUp(heap, heap.length - 1, compare);
      } else if (compare(entry, heap[0] as Ranked<T>) < 0) {
        heap[0] = entry;
        siftDown(heap, 0, compare);
      }
      return false;
    },
    finish() {
      heap.sort(compare);
      return heap.slice(skip).map((entry) => entry.item);
    },
  };
}

function keyOf(item: unknown, key: SortKey): unknown {
  const values: unknown[] = [];
  key.reach(item, (value) => {
    values.push(value);
    return false;
  });
  return sortValue(values, key.descending);
}

/* A max-heap under `compare`: the root is the item that would be dropped first. */

function siftUp<T>(heap: T[], at: number, compare: (a: T, b: T) => number): void {
  let child = at;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    if (compare(heap[child] as T, heap[parent] as T) <= 0) return;
    [heap[child], heap[parent]] = [heap[parent] as T, heap[child] as T];
    child = parent;
  }
}

function siftDown<T>(heap: T[], at: number, compare: (a: T, b: T) => number): void {
  let parent = at;
  for (;;) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let largest = parent;
    if (left < heap.length && compare(heap[left] as T, heap[largest] as T) > 0) largest = left;
    if (right < heap.length && compare(heap[right] as T, heap[largest] as T) > 0) largest = right;
    if (largest === parent) return;
    [heap[parent], heap[largest]] = [heap[largest] as T, heap[parent] as T];
    parent = largest;
  }
}

/* ------------------------------------------------------------------------------------ */
/* Projection                                                                           */
/* ------------------------------------------------------------------------------------ */

type Tree = Map<string, Tree | true>;

/**
 * Keeps the named paths of each item and nothing else.
 *
 * The result has the document's own shape — `address.city` comes back as
 * `{ address: { city } }` — so a caller reads a projected item exactly as it would the
 * whole one. An array on the way is kept as an array of the projected elements. A
 * vocabulary's computed field comes back under its own name.
 */
function projector(fields: unknown, vocabulary: Vocabulary<unknown, object> | undefined): (item: unknown) => Record<string, unknown> {
  if (!Array.isArray(fields)) throw new JqlError(`is a list of field names, not ${describe(fields)}`, "fields");
  const tree: Tree = new Map();
  const computed: [string, (item: unknown) => unknown][] = [];
  fields.forEach((name, index) => {
    const at = `fields[${index}]`;
    if (typeof name !== "string") throw new JqlError(`a field name is a string, not ${describe(name)}`, at);
    const field = vocabulary?.lookup.get(name.toLowerCase());
    if (field?.get !== undefined) {
      computed.push([field.name, field.get as (item: unknown) => unknown]);
      return;
    }
    const keys = splitPath(field?.path ?? name);
    if (typeof keys === "string") throw new JqlError(keys, at);
    // `for`, not `forEach`: skipping a segment has to stop the walk, and a `return` inside
    // the callback only ended that step — leaving the rest of the path attached at the top
    // level, so `fields: ["a", "a.b"]` also emitted whatever `b` the item had of its own.
    let node = tree;
    for (let position = 0; position < keys.length; position++) {
      const key = keys[position] as string;
      const existing = node.get(key);
      // A whole subtree is already being kept here; anything under it is already included.
      if (existing === true) break;
      if (position === keys.length - 1) {
        // A whole value asked for alongside part of it: the whole wins.
        node.set(key, true);
        break;
      }
      if (existing === undefined) {
        const child: Tree = new Map();
        node.set(key, child);
        node = child;
      } else node = existing;
    }
  });
  return (item) => {
    const out = (pick(item, tree, 0) ?? {}) as Record<string, unknown>;
    for (const [name, get] of computed) setField(out, name, get(item));
    return out;
  };
}

/**
 * Drops the named paths from each result.
 *
 * A copy, never a change to the item: a request is a question, and a question that edited
 * the store it was asked of would be a very surprising one. Only the objects on the way to
 * a dropped field are copied; everything else is shared with the item, so redacting one
 * field of a large record does not duplicate the record.
 */
function redactor(omit: unknown, vocabulary: Vocabulary<unknown, object> | undefined): (item: unknown) => unknown {
  if (!Array.isArray(omit)) throw new JqlError(`is a list of field names, not ${describe(omit)}`, "omit");
  const tree: Tree = new Map();
  omit.forEach((name, index) => {
    const at = `omit[${index}]`;
    if (typeof name !== "string") throw new JqlError(`a field name is a string, not ${describe(name)}`, at);
    const field = vocabulary?.lookup.get(name.toLowerCase());
    // A computed field has no place in the item, so it is dropped by its own name — which
    // is where `fields` put it.
    const keys = field?.get !== undefined ? [field.name] : splitPath(field?.path ?? name);
    if (typeof keys === "string") throw new JqlError(keys, at);
    let node = tree;
    for (let position = 0; position < keys.length; position++) {
      const key = keys[position] as string;
      if (position === keys.length - 1) {
        node.set(key, true);
        break;
      }
      const existing = node.get(key);
      // The whole subtree is already going; nothing under it needs naming.
      if (existing === true) break;
      if (existing === undefined) {
        const child: Tree = new Map();
        node.set(key, child);
        node = child;
      } else node = existing;
    }
  });
  return (item) => without(item, tree, 0);
}

/**
 * How deep `omit` will walk.
 *
 * Past this it refuses rather than stopping: a redaction that quietly gave up returned the
 * field it was asked to remove, which is the one outcome this must never have. No item
 * anybody stores is five hundred levels deep.
 */
const MAX_REDACT_DEPTH = 512;

function without(value: unknown, tree: Tree, depth: number): unknown {
  if (depth > MAX_REDACT_DEPTH) {
    throw new JqlError(`an item nests deeper than ${MAX_REDACT_DEPTH} levels, so it cannot be redacted; nothing was dropped from it`, "omit");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let changed = false;
    const copy = value.map((element) => {
      const kept = without(element, tree, depth + 1);
      if (kept !== element) changed = true;
      return kept;
    });
    return changed ? copy : value;
  }
  if (value instanceof Map) {
    let changed = false;
    const copy = new Map<unknown, unknown>();
    for (const [key, held] of value) {
      const sub = typeof key === "string" ? tree.get(key) : undefined;
      if (sub === true) {
        changed = true;
        continue;
      }
      const kept = sub === undefined ? held : without(held, sub, depth + 1);
      if (kept !== held) changed = true;
      copy.set(key, kept);
    }
    return changed ? copy : value;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  // Nothing here is named at all: hand back the object itself rather than a copy of it.
  if (!keys.some((key) => tree.has(key))) return value;
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const key of keys) {
    const sub = tree.get(key);
    if (sub === true) {
      changed = true;
      continue;
    }
    const held = record[key];
    const kept = sub === undefined ? held : without(held, sub, depth + 1);
    if (kept !== held) changed = true;
    setField(out, key, kept);
  }
  // A path that named something this item does not have has dropped nothing, and an item
  // with nothing dropped is the item: redacting a field absent from half the rows should
  // not copy those rows.
  return changed ? out : value;
}

/**
 * The named paths of one item, as a new object.
 *
 * The depth it stops at is the longest path there can be, because the tree it walks is made
 * of paths and can be no deeper than the longest of them. It used to stop at sixty-four,
 * which was shorter than a path is allowed to be: a query matched on `a.b.c…` past that
 * depth and the projection quietly left the field out of the result, so the same path
 * meant two different things in one request.
 */
function pick(value: unknown, tree: Tree, depth: number): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || depth > MAX_PATH_SEGMENTS) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of tree) {
    const found = readOwn(value, key);
    if (found === undefined) continue;
    if (sub === true) setField(out, key, found);
    else if (Array.isArray(found)) setField(out, key, found.map((element) => pick(element, sub, depth + 1)).filter((element) => element !== undefined));
    else {
      const inner = pick(found, sub, depth + 1);
      if (inner !== undefined) setField(out, key, inner);
    }
  }
  return out;
}
