/**
 * MongoDB's matching rules, written out here, so the translation is checked by running it.
 *
 * `toMongoFilter` is a rewriting, and this family checks a rewriting by asking whether the
 * rewritten form answers the same question — never by comparing its shape. The MongoDB
 * target was the exception: its tests asserted what the filter looked like, which cannot
 * catch the failure the module exists to avoid, a filter that is *nearly* right and comes
 * back with the wrong rows.
 *
 * So this is a second reading of the language the filter is written in, taken from MongoDB's
 * documented behaviour rather than from JQL's engine. Two implementations of the same idea
 * disagreeing is the signal; sharing the code would destroy it.
 *
 * It covers what `MONGO_CAPABILITIES` allows and no more, because `plan` never pushes the
 * rest: a filter holding anything else is a bug in the split, not something to interpret.
 */

/** A field the document does not have, which equality reads as `null` and everything else skips. */
export const MISSING: unique symbol = Symbol("mongo.missing");

/**
 * Every value a field path reaches, as MongoDB reads one.
 *
 * Two rules differ from JQL's walk, and both are deliberate here.
 *
 * **One array level per segment.** MongoDB applies a segment to the elements of an array but
 * does not then apply it to the elements of *those* arrays: `{"a.b": 1}` does not match
 * `{"a": [[{"b": 1}]]}`. JQL sees an array through wherever it meets one.
 *
 * **Missing is a value.** An element without the field contributes *missing* rather than
 * nothing, because `{"a.b": null}` finds the documents whose `a` has no `b`.
 */
function reached(document: unknown, path: string): unknown[] {
  let values: unknown[] = [document];
  for (const key of path.split(".")) {
    const next: unknown[] = [];
    const take = (value: unknown): void => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) next.push(Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : MISSING);
      else next.push(MISSING);
    };
    for (const value of values) {
      if (value === MISSING) {
        next.push(MISSING);
        continue;
      }
      if (Array.isArray(value)) {
        const index = /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : undefined;
        if (index !== undefined) {
          next.push(index < value.length ? value[index] : MISSING);
          continue;
        }
        // One level, and no further: an element that is itself an array contributes nothing.
        const before = next.length;
        for (const element of value) if (!Array.isArray(element)) take(element);
        // An array that contributed nothing — empty, or holding only arrays — leaves the
        // path unresolved, which is *missing* rather than no value at all.
        if (next.length === before) next.push(MISSING);
        continue;
      }
      take(value);
    }
    values = next;
  }
  return values;
}

function equal(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]));
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  // Byte-for-byte, so key order counts — which is why `plan` never pushes a comparison with
  // an embedded document in the first place.
  return keys.length === Object.keys(right).length && keys.every((key, index) => Object.keys(right)[index] === key && equal(left[key], right[key]));
}

/** One operand, against one value the path reached. A bare pattern is a match, not a comparison. */
function holds(value: unknown, operand: unknown): boolean {
  if (operand instanceof RegExp) return typeof value === "string" && operand.test(value);
  return equal(value, operand);
}

const TYPES: Record<string, (value: unknown) => boolean> = {
  double: (value) => typeof value === "number",
  int: (value) => typeof value === "number" && Number.isInteger(value),
  long: (value) => typeof value === "number" && Number.isInteger(value),
  decimal: (value) => typeof value === "number",
  string: (value) => typeof value === "string",
  bool: (value) => typeof value === "boolean",
  null: (value) => value === null,
  array: (value) => Array.isArray(value),
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date),
  date: (value) => value instanceof Date,
};

/** One operator of a field's condition, against everything the path reached. */
function operator(name: string, operand: unknown, values: readonly unknown[], present: boolean): boolean {
  const held = values.filter((value) => value !== MISSING);
  const any = (test: (value: unknown) => boolean): boolean => held.some((value) => test(value) || (Array.isArray(value) && value.some(test)));
  // A missing field reads as `null` where equality is concerned, which is MongoDB's rule and
  // JQL's: `{ "b": null }` finds the documents without a `b`.
  const asNull = values.map((value) => (value === MISSING ? null : value));
  const anyOrNull = (test: (value: unknown) => boolean): boolean => asNull.some((value) => test(value) || (Array.isArray(value) && value.some(test)));
  switch (name) {
    case "$eq":
      return anyOrNull((value) => holds(value, operand));
    case "$ne":
      return !anyOrNull((value) => holds(value, operand));
    case "$gt":
    case "$gte":
    case "$lt":
    case "$lte":
      return any((value) => {
        const left = value instanceof Date ? value.getTime() : value;
        const right = operand instanceof Date ? operand.getTime() : operand;
        if (typeof left !== typeof right) return false;
        if (typeof left !== "number" && typeof left !== "string") return false;
        const order = left < (right as string | number) ? -1 : left > (right as string | number) ? 1 : 0;
        return name === "$gt" ? order > 0 : name === "$gte" ? order >= 0 : name === "$lt" ? order < 0 : order <= 0;
      });
    case "$in":
      return anyOrNull((value) => (operand as unknown[]).some((member) => holds(value, member)));
    case "$nin":
      return !anyOrNull((value) => (operand as unknown[]).some((member) => holds(value, member)));
    case "$exists":
      return present === (operand === true);
    case "$type": {
      const names = Array.isArray(operand) ? operand : [operand];
      return any((value) => names.some((type) => TYPES[type as string]?.(value) === true));
    }
    case "$all":
      // Documented as an `$and` of `$eq`s, so each member reads a missing field as `null`
      // exactly as `$eq` does.
      return (operand as unknown[]).every((member) => anyOrNull((value) => holds(value, member)));
    case "$size":
      return held.some((value) => Array.isArray(value) && value.length === operand);
    case "$mod": {
      const [divisor, remainder] = operand as [number, number];
      return any((value) => typeof value === "number" && value % divisor === remainder);
    }
    case "$elemMatch":
      return held.some((value) => Array.isArray(value) && value.some((element) => matchesFilter(element, operand as Record<string, unknown>)));
    case "$regex": {
      const flags = typeof (operand as { $options?: unknown }).$options === "string" ? "" : "";
      return any((value) => typeof value === "string" && new RegExp(operand as string, flags).test(value));
    }
    default:
      throw new Error(`the reference does not implement "${name}", so plan() pushed something it should not have`);
  }
}

function field(document: unknown, path: string, condition: unknown): boolean {
  const values = reached(document, path);
  const present = values.some((value) => value !== MISSING);
  const equality = (): boolean => {
    const against = values.map((value) => (value === MISSING ? null : value));
    return against.some((value) => holds(value, condition) || (Array.isArray(value) && value.some((element) => holds(element, condition))));
  };
  if (condition instanceof RegExp || condition === null || typeof condition !== "object" || Array.isArray(condition) || condition instanceof Date) return equality();
  const keys = Object.keys(condition as Record<string, unknown>);
  if (keys.length === 0 || !keys.every((key) => key.startsWith("$"))) return equality();
  const carried = condition as Record<string, unknown>;
  const flags = typeof carried.$options === "string" ? carried.$options : "";
  return keys.every((key) => {
    if (key === "$options") return true;
    // `$regex` carries its flags beside it rather than in the operand.
    if (key === "$regex") return values.some((value) => typeof value === "string" && new RegExp(carried.$regex as string, flags).test(value));
    return operator(key, carried[key], values, present);
  });
}

/** Whether a document matches a MongoDB filter. */
export function matchesFilter(document: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    switch (key) {
      case "$and":
        return (value as Record<string, unknown>[]).every((part) => matchesFilter(document, part));
      case "$or":
        return (value as Record<string, unknown>[]).some((part) => matchesFilter(document, part));
      case "$nor":
        return !(value as Record<string, unknown>[]).some((part) => matchesFilter(document, part));
      default:
        if (key.startsWith("$")) throw new Error(`the reference does not implement "${key}" at the top of a filter`);
        return field(document, key, value);
    }
  });
}
