import { count, every, filter, filterMap, find, findIndex, partition, some } from "./collections.js";
import { compile, type CompileOptions } from "./core.js";
import { search } from "./search.js";
import type { QueryLike, Request, Source } from "./types.js";

/**
 * The query methods on `Array`, `Map` and `Set`.
 *
 * Patching a built-in is a decision for the application, never for a library it imports,
 * so nothing here runs on import: `install()` does it, and the `@osqd/jql/global` entry
 * calls `install()` and adds the matching types in one line. A package that depends on JQL
 * uses the functions and leaves the prototypes alone.
 *
 * Every method is defined non-enumerable, so a `for…in` over an array — which nobody
 * should write, and some code does — sees nothing new.
 *
 * `install` refuses to overwrite a method of the same name it did not put there. Two
 * libraries both defining `Array.prototype.jqlSearch` would otherwise leave whichever
 * loaded last in charge, and the other one's callers running code they never wrote.
 */

/**
 * The mark that says a method on a built-in is this library's.
 *
 * `Symbol.for` rather than a set held in this module, because the question is asked across
 * copies: npm puts two copies of a package in one process whenever two dependencies want
 * different versions of it, and a set in one copy knows nothing about the other copy's
 * methods. The second copy's `import "@osqd/jql/global"` used to throw "already defined by
 * something else" — naming JQL itself as the intruder, at import time, which takes the whole
 * application down over methods that do the same thing.
 *
 * So a marked method is recognised whichever copy installed it, and the copy that got there
 * first keeps the field. Both copies answer the same queries the same way: what a method
 * means is pinned by the conformance suite, not by which copy of it is in place.
 */
const MARK = Symbol.for("@osqd/jql.method");

type Methods = Record<string, (...args: never[]) => unknown>;

/** Whether this is a JQL method, from this copy of the library or from another. */
function isOurs(value: unknown): boolean {
  return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[MARK] === true;
}

const ARRAY_METHODS: Methods = {
  jqlSearch<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return find(this, query, options);
  },
  jqlFilter<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return filter(this, query, options);
  },
  jqlCount<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return count(this, query, options);
  },
  jqlSome<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return some(this, query, options);
  },
  jqlEvery<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return every(this, query, options);
  },
  jqlFindIndex<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return findIndex(this, query, options);
  },
  jqlPartition<T>(this: T[], query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return partition(this, query, options);
  },
  jqlQuery<T>(this: T[], request?: Request<T, object>, options?: CompileOptions<object>) {
    return search(this, request, options);
  },
};

const ARRAY_STATICS: Methods = {
  jqlSearch<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return find(source, query, options);
  },
  jqlFilter<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return filter(source, query, options);
  },
  jqlCount<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return count(source, query, options);
  },
  jqlSome<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return some(source, query, options);
  },
  jqlEvery<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return every(source, query, options);
  },
  jqlFindIndex<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return findIndex(source, query, options);
  },
  jqlPartition<T>(source: Source<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return partition(source, query, options);
  },
  jqlQuery<T>(source: Source<T>, request?: Request<T, object>, options?: CompileOptions<object>) {
    return search(source, request, options);
  },
};

const MAP_METHODS: Methods = {
  jqlSearch<K, V>(this: Map<K, V>, query: QueryLike<V, object>, options?: CompileOptions<object>) {
    return find(this, query, options);
  },
  jqlFilter<K, V>(this: Map<K, V>, query: QueryLike<V, object>, options?: CompileOptions<object>) {
    return filterMap(this, query, options);
  },
  jqlCount<K, V>(this: Map<K, V>, query: QueryLike<V, object>, options?: CompileOptions<object>) {
    return count(this, query, options);
  },
};

const SET_METHODS: Methods = {
  jqlSearch<T>(this: Set<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return find(this, query, options);
  },
  jqlFilter<T>(this: Set<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    const test = compile(query, options);
    const out = new Set<T>();
    for (const item of this) if (test(item)) out.add(item);
    return out;
  },
  jqlCount<T>(this: Set<T>, query: QueryLike<T, object>, options?: CompileOptions<object>) {
    return count(this, query, options);
  },
};

const TARGETS: readonly [object, Methods, string][] = [
  [Array.prototype, ARRAY_METHODS, "Array.prototype"],
  [Array, ARRAY_STATICS, "Array"],
  [Map.prototype, MAP_METHODS, "Map.prototype"],
  [Set.prototype, SET_METHODS, "Set.prototype"],
];

for (const [, methods] of TARGETS) {
  for (const method of Object.values(methods)) Object.defineProperty(method, MARK, { value: true });
}

/**
 * Adds the methods.
 *
 * Safe to call more than once, and safe when another copy of JQL has already installed
 * them: whichever copy got there first keeps the field. Throws only for a method of the
 * same name that is not JQL's at all, because installing over that would silently change
 * what its callers run.
 */
export function install(): void {
  for (const [target, methods, label] of TARGETS) {
    for (const name of Object.keys(methods)) {
      const existing = Object.getOwnPropertyDescriptor(target, name);
      if (existing !== undefined && !isOurs(existing.value)) {
        throw new Error(`${label}.${name} is already defined by something else; installing over it would silently change what its callers run`);
      }
    }
  }
  for (const [target, methods] of TARGETS) {
    for (const [name, method] of Object.entries(methods)) {
      if (Object.getOwnPropertyDescriptor(target, name) !== undefined) continue;
      Object.defineProperty(target, name, { value: method, writable: true, configurable: true, enumerable: false });
    }
  }
}

/** Removes JQL's methods — this copy's, and any another copy of it installed. */
export function uninstall(): void {
  for (const [target, methods] of TARGETS) {
    for (const name of Object.keys(methods)) {
      const existing = Object.getOwnPropertyDescriptor(target, name);
      if (existing !== undefined && isOurs(existing.value)) Reflect.deleteProperty(target, name);
    }
  }
}
