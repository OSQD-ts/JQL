/**
 * One total order over every value a document can hold.
 *
 * A sort has to put *something* first when one item's field is a number and another's is
 * a string, or missing. The order is fixed and written down in the specification, so two
 * implementations sort a shared result the same way:
 *
 *   missing and null < numbers < strings < objects < booleans < dates
 *
 * Strings compare by UTF-16 code unit, not by locale. A locale-aware sort would put a
 * shared link's rows in a different order for each reader, which is worse than an order
 * that is merely unidiomatic for some of them. Objects compare equal to one another, so
 * their order is the order they arrived in.
 */

function rank(value: unknown): number {
  if (value === undefined || value === null) return 0;
  switch (typeof value) {
    case "number":
    case "bigint":
      return Number.isNaN(value) ? 0 : 1;
    case "string":
      return 2;
    case "boolean":
      return 4;
    default:
      return value instanceof Date ? 5 : 3;
  }
}

export function compareValues(a: unknown, b: unknown): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 1:
    case 2:
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
    case 4:
      return a === b ? 0 : a ? 1 : -1;
    case 5:
      return (a as Date).getTime() - (b as Date).getTime();
    default:
      return 0;
  }
}

/**
 * The value an item sorts by, from everything its path reached.
 *
 * A path that reaches an array — or fans out over one — reaches several values. Ascending
 * sorts by the smallest of them and descending by the largest: an order
 * by "tags" puts first whatever has the tag that sorts first. Arrays nested past sixteen
 * levels are passed over, so an array that contains itself ends the walk.
 */
export function sortValue(values: readonly unknown[], descending: boolean, depth = 0): unknown {
  let best: unknown;
  let first = true;
  for (const value of values) {
    if (Array.isArray(value)) {
      if (value.length === 0 || depth >= 16) continue;
      const inner = sortValue(value, descending, depth + 1);
      if (first || (descending ? compareValues(inner, best) > 0 : compareValues(inner, best) < 0)) best = inner;
      first = false;
      continue;
    }
    if (first || (descending ? compareValues(value, best) > 0 : compareValues(value, best) < 0)) best = value;
    first = false;
  }
  return best;
}
