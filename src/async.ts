import { compile, type CompileOptions } from "./core.js";
import { planRequest } from "./search.js";
import type { FieldName, QueryLike, Request, Source } from "./types.js";

/**
 * The same questions, asked of something that arrives over time.
 *
 * A log file read line by line, a cursor over a store, a stream of events: the items are
 * the same shape, and the query that filters an array should filter these. Everything here
 * is the ordinary engine with an `await` in the loop — the query is compiled once, before
 * the first item, and the helpers stop reading as soon as the answer cannot change.
 *
 * That last property is the point of `filterStream` and of a limit: a source that never
 * ends still answers "the first twenty matches", because nothing pulls from it afterwards.
 * Sorting is the exception and says so — an order over items you have not seen yet is not
 * an order — so `searchAsync` with a sort reads the whole source, keeping only the page it
 * was asked for.
 */

/** Anything that yields items, now or later. */
export type AsyncSource<T> = AsyncIterable<T> | Source<T> | ReadonlyMap<unknown, T>;

/** One loop over any of the shapes a source can take. */
async function* iterate<T>(source: AsyncSource<T>): AsyncGenerator<T> {
  if (Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) yield source[i] as T;
    return;
  }
  if (source instanceof Map) {
    for (const item of source.values()) yield item as T;
    return;
  }
  if (typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
    for await (const item of source as AsyncIterable<T>) yield item;
    return;
  }
  if (typeof (source as Iterable<T>)[Symbol.iterator] === "function") {
    for (const item of source as Iterable<T>) yield item;
    return;
  }
  const list = source as ArrayLike<T>;
  for (let i = 0; i < list.length; i++) yield list[i] as T;
}

/** Every matching item, as they arrive. The caller can stop at any point, and the source stops with it. */
export async function* filterStream<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  query: QueryLike<T, NoInfer<Extra>>,
  options?: CompileOptions<Extra>,
): AsyncGenerator<T> {
  const test = compile(query, options);
  for await (const item of iterate(source)) if (test(item)) yield item;
}

/** The first match, or `undefined`. Stops reading at it. */
export async function findAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  query: QueryLike<T, NoInfer<Extra>>,
  options?: CompileOptions<Extra>,
): Promise<T | undefined> {
  for await (const item of filterStream(source, query, options)) return item;
  return undefined;
}

/** Every match, as an array. Reads the whole source, so give an endless one a limit through `searchAsync`. */
export async function filterAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  query: QueryLike<T, NoInfer<Extra>>,
  options?: CompileOptions<Extra>,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of filterStream(source, query, options)) out.push(item);
  return out;
}

/** How many match. */
export async function countAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  query: QueryLike<T, NoInfer<Extra>>,
  options?: CompileOptions<Extra>,
): Promise<number> {
  let total = 0;
  const test = compile(query, options);
  for await (const item of iterate(source)) if (test(item)) total++;
  return total;
}

/** Whether any item matches. Stops at the first. */
export async function someAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  query: QueryLike<T, NoInfer<Extra>>,
  options?: CompileOptions<Extra>,
): Promise<boolean> {
  // Not `findAsync(…) !== undefined`: an item that *is* `undefined` matched `{}` and was
  // then reported as nothing found, where the synchronous `some` said true.
  const test = compile(query, options);
  for await (const item of iterate(source)) if (test(item)) return true;
  return false;
}

/** Whether every item matches. True for an empty source. Stops at the first that does not. */
export async function everyAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  query: QueryLike<T, NoInfer<Extra>>,
  options?: CompileOptions<Extra>,
): Promise<boolean> {
  const test = compile(query, options);
  for await (const item of iterate(source)) if (!test(item)) return false;
  return true;
}

/**
 * A whole request over a source that arrives over time.
 *
 * Without a sort it stops as soon as the page is full, so an endless source still answers.
 * With a sort it reads everything — it has to — but holds only `skip + limit` items while
 * it does, the same bounded heap the synchronous version uses.
 */
export async function searchAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  request: Request<T, NoInfer<Extra>> & { readonly fields: readonly FieldName<T, NoInfer<Extra>>[] },
  options?: CompileOptions<Extra>,
): Promise<Record<string, unknown>[]>;
export async function searchAsync<T, Extra extends object = {}>(
  source: AsyncSource<T>,
  request: Request<T, NoInfer<Extra>> & { readonly omit: readonly FieldName<T, NoInfer<Extra>>[] },
  options?: CompileOptions<Extra>,
): Promise<Partial<T>[]>;
export async function searchAsync<T, Extra extends object = {}>(source: AsyncSource<T>, request?: Request<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): Promise<T[]>;
export async function searchAsync<T>(source: AsyncSource<T>, request: Request<T, object> = {}, options: CompileOptions<object> = {}): Promise<unknown[]> {
  const plan = planRequest<T>(request, options);
  const collect = plan.collect();
  let index = 0;
  for await (const item of iterate(source)) {
    const position = index++;
    if (plan.test !== undefined && !plan.test(item)) continue;
    if (collect.offer(item, position)) break;
  }
  return plan.shape(collect.finish());
}
