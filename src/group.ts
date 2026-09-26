import { compile, type CompileOptions, reachField } from "./core.js";
import { JqlError } from "./errors.js";
import { compareValues } from "./internal/order.js";
import { describe } from "./internal/values.js";
import type { QueryLike, Source } from "./types.js";
import { checkVocabulary, type Vocabulary } from "./vocabulary.js";

/**
 * Counting the matches by one field.
 *
 * Every dashboard in this family ends up doing this: a thousand requests become a dozen
 * actors you can read down, a feed becomes counts per verdict, per rule, per path. Each
 * one used to write the tally loop itself, which is where the disagreements crept in —
 * whether an item with two tags counts twice, what happens to the items with no value at
 * all, and what order the groups come back in. It is one answer now.
 *
 * One pass over the source, one `Map` of counts, and the items kept only when asked for.
 */

export interface Grouped<T> {
  /** The value that names the group. `null` covers everything that cannot name one — see below. */
  readonly key: unknown;
  readonly count: number;
  /** Present only when `items` asked for them. */
  readonly items?: readonly T[] | undefined;
}

export interface GroupOptions<T, Extra extends object = {}> extends CompileOptions<Extra> {
  /** Which items to count. Absent counts them all. */
  readonly where?: QueryLike<T, NoInfer<Extra>> | undefined;
  /** How many groups to return. Absent returns all of them. */
  readonly limit?: number | undefined;
  /** Keep the items too: `true` for all of them, a number for the first few. Default: counts only. */
  readonly items?: boolean | number | undefined;
  /** `"count"` (default) puts the largest group first; `"key"` orders by the value itself. */
  readonly sort?: "count" | "key" | undefined;
}

type Items<T> = Source<T> | ReadonlyMap<unknown, T>;

/**
 * Groups the matching items by the value at `by`, largest group first.
 *
 * Three rules worth knowing, each because leaving it unsaid is how two dashboards came to
 * disagree about the same feed:
 *
 * - **An item counts once in each group it belongs to.** A path that reaches an array —
 *   tags, say — puts the item in a group per distinct tag, and a repeated value inside one
 *   item counts once.
 * - **Everything that cannot name a group shares `null`**: a missing field, a `null`, a value
 *   that is an object, and an empty list. That is the "no rule matched" heading, and it is a
 *   real answer rather than a silently dropped row — which is the point, because it is what
 *   makes the counts add up to the number of rows there are.
 * - **Ties break by the key**, so the same data always comes back in the same order.
 */
export function group<K, V, Extra extends object = {}>(source: ReadonlyMap<K, V>, by: string, options?: GroupOptions<V, Extra>): Grouped<V>[];
export function group<T, Extra extends object = {}>(source: Source<T>, by: string, options?: GroupOptions<T, Extra>): Grouped<T>[];
export function group<T>(source: Items<T>, by: string, options: GroupOptions<T, object> = {}): Grouped<T>[] {
  if (typeof by !== "string") throw new JqlError(`a group is named by a field, not ${describe(by)}`, "by");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new JqlError(`is a whole number of groups, zero or more, not ${describe(options.limit)}`, "limit");
  }
  if (options.items !== undefined && typeof options.items !== "boolean" && (!Number.isInteger(options.items) || options.items < 0)) {
    throw new JqlError(`is true, false, or how many items to keep, not ${describe(options.items)}`, "items");
  }
  const reach = reachField(by, checkVocabulary(options.vocabulary) as Vocabulary<unknown, object> | undefined, "by");
  const test = options.where === undefined ? undefined : compile(options.where, options);
  const keep = options.items === true ? Number.POSITIVE_INFINITY : options.items === undefined || options.items === false ? 0 : options.items;

  const groups = new Map<unknown, { key: unknown; count: number; items: T[] }>();
  const keys: unknown[] = [];
  const visit = (item: T): void => {
    if (test !== undefined && !test(item)) return;
    keys.length = 0;
    reach(item, (value) => {
      collect(value, keys);
      return false;
    });
    for (const key of keys) {
      let held = groups.get(key);
      if (held === undefined) {
        held = { key, count: 0, items: [] };
        groups.set(key, held);
      }
      held.count++;
      if (held.items.length < keep) held.items.push(item);
    }
  };

  if (Array.isArray(source)) for (let i = 0; i < source.length; i++) visit(source[i] as T);
  else if (source instanceof Map) for (const item of source.values()) visit(item as T);
  else if (typeof (source as Iterable<T>)[Symbol.iterator] === "function") for (const item of source as Iterable<T>) visit(item);
  else {
    const list = source as ArrayLike<T>;
    for (let i = 0; i < list.length; i++) visit(list[i] as T);
  }

  const byKey = options.sort === "key";
  const found = [...groups.values()].sort((a, b) => (byKey ? compareValues(a.key, b.key) : b.count - a.count || compareValues(a.key, b.key)));
  const limited = options.limit === undefined ? found : found.slice(0, options.limit);
  return limited.map((held) => (keep > 0 ? { key: held.key, count: held.count, items: held.items } : { key: held.key, count: held.count }));
}

/** The keys one reached value stands for, without repeating one this item has already earned. */
function collect(value: unknown, into: unknown[]): void {
  if (Array.isArray(value)) {
    // An empty array names no group — and belonging to none is not the same as not being
    // there. Counting by a tag used to leave every untagged row out of the tally altogether,
    // so the numbers above a table did not add up to the number of rows in it, and nothing
    // said which rows had gone. It is a value that cannot name a group, so it shares `null`
    // with the others.
    if (value.length === 0) {
      if (!into.includes(null)) into.push(null);
      return;
    }
    for (const element of value) collect(element, into);
    return;
  }
  const key = value === undefined || value === null || typeof value === "object" ? null : value;
  if (!into.includes(key)) into.push(key);
}
