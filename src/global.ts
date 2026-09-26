import { install } from "./array.js";
import type { CompileOptions } from "./core.js";
import type { FieldName, QueryLike, Request, Source } from "./types.js";

/**
 * `import "@osqd/jql/global"` — the query methods on `Array`, `Map` and `Set`, with types.
 *
 * The one module in the package with a side effect, and the only one that declares the
 * methods to TypeScript. The declarations live here rather than beside `install()` on
 * purpose: if importing the engine added `jqlSearch` to every array's type without adding
 * it to every array, the compiler would promise a method that throws "is not a function"
 * at run time — present, type-checked and missing.
 *
 * ```ts
 * import "@osqd/jql/global";
 *
 * const users = [{ id: 1, name: "Ada" }, { id: 2, name: "Grace" }];
 * users.jqlSearch({ id: 2 });                       // { id: 2, name: "Grace" }
 * Array.jqlSearch(users, { name: { $startsWith: "A" } });
 * ```
 */

install();

export { install, uninstall } from "./array.js";

declare global {
  interface ReadonlyArray<T> {
    /** The first item matching the query, or `undefined`. */
    jqlSearch<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T | undefined;
    /** Every item matching the query, as a new array. */
    jqlFilter<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
    /** How many items match. */
    jqlCount<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    /** Whether any item matches. */
    jqlSome<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    /** Whether every item matches. True when there are none. */
    jqlEvery<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    /** The position of the first match, or -1. */
    jqlFindIndex<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    /** The matches and the rest. */
    jqlPartition<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): [T[], T[]];
    /** A whole request: `where`, `sort`, `skip`, `limit`, `fields`, `omit`. */
    jqlQuery<Extra extends object = {}>(request: Request<T, NoInfer<Extra>> & { readonly fields: readonly FieldName<T, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Record<string, unknown>[];
    /** With `omit`, each result is a copy without those paths — which is `Partial<T>`, not `T`. */
    jqlQuery<Extra extends object = {}>(request: Request<T, NoInfer<Extra>> & { readonly omit: readonly FieldName<T, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Partial<T>[];
    jqlQuery<Extra extends object = {}>(request?: Request<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
  }

  interface Array<T> {
    jqlSearch<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T | undefined;
    jqlFilter<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
    jqlCount<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    jqlSome<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    jqlEvery<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    jqlFindIndex<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    jqlPartition<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): [T[], T[]];
    jqlQuery<Extra extends object = {}>(request: Request<T, NoInfer<Extra>> & { readonly fields: readonly FieldName<T, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Record<string, unknown>[];
    jqlQuery<Extra extends object = {}>(request: Request<T, NoInfer<Extra>> & { readonly omit: readonly FieldName<T, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Partial<T>[];
    jqlQuery<Extra extends object = {}>(request?: Request<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
  }

  interface ArrayConstructor {
    /** The first item of any array, array-like, iterable or `Map` (by value) matching the query. */
    jqlSearch<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V | undefined;
    jqlSearch<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T | undefined;
    jqlFilter<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V[];
    jqlFilter<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
    jqlCount<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    jqlCount<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    jqlSome<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    jqlSome<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    jqlEvery<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    jqlEvery<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): boolean;
    jqlFindIndex<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    jqlFindIndex<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
    jqlPartition<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): [V[], V[]];
    jqlPartition<T, Extra extends object = {}>(source: Source<T>, query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): [T[], T[]];
    jqlQuery<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, request: Request<V, NoInfer<Extra>> & { readonly fields: readonly FieldName<V, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Record<string, unknown>[];
    jqlQuery<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, request: Request<V, NoInfer<Extra>> & { readonly omit: readonly FieldName<V, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Partial<V>[];
    jqlQuery<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, request?: Request<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V[];
    jqlQuery<T, Extra extends object = {}>(source: Source<T>, request: Request<T, NoInfer<Extra>> & { readonly fields: readonly FieldName<T, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Record<string, unknown>[];
    jqlQuery<T, Extra extends object = {}>(source: Source<T>, request: Request<T, NoInfer<Extra>> & { readonly omit: readonly FieldName<T, NoInfer<Extra>>[] }, options?: CompileOptions<Extra>): Partial<T>[];
    jqlQuery<T, Extra extends object = {}>(source: Source<T>, request?: Request<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T[];
  }

  interface Map<K, V> {
    /** The first value matching the query. */
    jqlSearch<Extra extends object = {}>(query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): V | undefined;
    /** The entries whose value matches, as a new `Map`. */
    jqlFilter<Extra extends object = {}>(query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): Map<K, V>;
    jqlCount<Extra extends object = {}>(query: QueryLike<V, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
  }

  interface Set<T> {
    jqlSearch<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): T | undefined;
    /** The members that match, as a new `Set`. */
    jqlFilter<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): Set<T>;
    jqlCount<Extra extends object = {}>(query: QueryLike<T, NoInfer<Extra>>, options?: CompileOptions<Extra>): number;
  }
}
