/**
 * Seeded generators: random documents, random queries, and the random generator itself.
 *
 * Shared because every suite that needs "a few thousand queries nobody wrote by hand" needs
 * the same ones: the differential test against a naive reference, the split, the canonical
 * form, the explanation, the text writer, the grouping tally and the asynchronous helpers.
 * Separate copies would drift into separate ideas of what a query looks like, and each would
 * cover a little less than it believed.
 *
 * Everything is seeded, so a failure names a seed and anybody can reproduce it. A fuzzer that
 * finds something new on a random CI run is a flaky test, and a test that cries wolf gets
 * muted.
 */

export type Query = Record<string, unknown>;

export function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32: small, fast and good enough to wander a grammar.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4_294_967_296;
  };
}

export const KEYS = ["a", "b", "c"];
/** The type names `$type` takes. */
export const TYPES = ["string", "number", "integer", "boolean", "null", "array", "object"];

export const GLOBS = ["x*", "*y", "*x*", "x?", "?y", "x*y", "*", "xy", "x\\*y"];
export const PATHS = ["a", "b", "a.b", "a.c", "a.b.c", "arr", "arr.a", "arr.b", "arr.0", "arr.0.a", "arr.a.b", "m.a", "m.b.c"];

export function makeDocument(next: () => number, depth = 0): unknown {
  const pick = next();
  if (depth > 2 || pick < 0.35) return scalar(next);
  if (pick < 0.55) return Array.from({ length: Math.floor(next() * 3) }, () => makeDocument(next, depth + 1));
  if (pick < 0.62 && depth > 0) return new Map(KEYS.filter(() => next() < 0.5).map((key) => [key, makeDocument(next, depth + 1)]));
  const out: Record<string, unknown> = {};
  for (const key of KEYS) if (next() < 0.6) out[key] = makeDocument(next, depth + 1);
  return out;
}

export function makeRoot(next: () => number): unknown {
  const root = makeDocument(next, 1);
  if (root === null || typeof root !== "object" || Array.isArray(root) || root instanceof Map) return { a: root };
  const record = root as Record<string, unknown>;
  if (next() < 0.7) record.arr = Array.from({ length: Math.floor(next() * 3) }, () => makeDocument(next, 1));
  if (next() < 0.3) record.m = new Map([["a", scalar(next)], ["b", { c: scalar(next) }]]);
  return record;
}

export function scalar(next: () => number): unknown {
  const pick = next();
  if (pick < 0.4) return Math.floor(next() * 4);
  // Mixed case on purpose: without it `$options: "i"` would be a flag with nothing to do.
  if (pick < 0.7) return ["x", "xy", "y", "X", "Xy", "Y"][Math.floor(next() * 6)];
  if (pick < 0.85) return null;
  return next() < 0.5;
}

export function literal(next: () => number): unknown {
  const pick = next();
  if (pick < 0.85) return scalar(next);
  if (pick < 0.95) return [scalar(next)];
  return { b: scalar(next) };
}

export function makeCondition(next: () => number, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const count = 1 + Math.floor(next() * 3);
  for (let i = 0; i < count; i++) {
    const pick = next();
    if (pick < 0.12) out.$eq = literal(next);
    else if (pick < 0.22) out.$ne = literal(next);
    else if (pick < 0.3) out.$gt = Math.floor(next() * 4);
    else if (pick < 0.36) out.$gte = Math.floor(next() * 4);
    else if (pick < 0.42) out.$lt = Math.floor(next() * 4);
    else if (pick < 0.46) out.$lte = Math.floor(next() * 4);
    else if (pick < 0.54) out.$in = Array.from({ length: Math.floor(next() * 3) }, () => literal(next));
    else if (pick < 0.6) out.$nin = Array.from({ length: Math.floor(next() * 3) }, () => literal(next));
    else if (pick < 0.68) out.$exists = next() < 0.5;
    else if (pick < 0.72) out.$contains = next() < 0.5 ? "x" : "X";
    else if (pick < 0.75) out.$startsWith = next() < 0.5 ? "x" : "X";
    else if (pick < 0.765) out.$endsWith = next() < 0.5 ? "y" : "Y";
    else if (pick < 0.775) out.$word = ["x", "xy", "X", "x.y"][Math.floor(next() * 4)] as string;
    else if (pick < 0.778) out.$size = Math.floor(next() * 3);
    else if (pick < 0.79) out.$glob = GLOBS[Math.floor(next() * GLOBS.length)] as string;
    else if (pick < 0.80) out.$length = Math.floor(next() * 3);
    else if (pick < 0.81) out.$mod = [1 + Math.floor(next() * 3), Math.floor(next() * 3)];
    else if (pick < 0.825) out.$type = next() < 0.5 ? TYPES[Math.floor(next() * TYPES.length)] : [TYPES[Math.floor(next() * TYPES.length)], TYPES[Math.floor(next() * TYPES.length)]];
    else if (pick < 0.835) out.$all = Array.from({ length: 1 + Math.floor(next() * 2) }, () => scalar(next));
    // These two thresholds used to read 0.835, 0.83, 0.84 — and a chain of `else if` cannot
    // reach a bound lower than the one before it, so the `$eq` reference was dead code and
    // no generated query ever held one. It reaches a different path in the engine from the
    // ordering references beside it, and every suite here believed it was covering it.
    else if (pick < 0.845) out.$eq = { $field: PATHS[Math.floor(next() * PATHS.length)] as string };
    else if (pick < 0.855) out[next() < 0.5 ? "$gt" : "$lte"] = { $field: PATHS[Math.floor(next() * PATHS.length)] as string };
    else if (pick < 0.92 && depth < 2) out.$elemMatch = makeQuery(next, depth + 1);
    else if (depth < 2) out.$not = makeCondition(next, depth + 1);
  }
  if (Object.keys(out).length === 0) out.$exists = true;
  // `$options` is refused where nothing would use it, so it is added only beside an
  // operator whose meaning it changes.
  if (next() < 0.25 && Object.keys(out).some((key) => CASE_AWARE.includes(key))) out.$options = "i";
  return out;
}

/** The operators `$options: "i"` changes, which is where the generator may add it. */
const CASE_AWARE = ["$eq", "$ne", "$in", "$nin", "$all", "$contains", "$startsWith", "$endsWith", "$word", "$glob"];

export function makeQuery(next: () => number, depth = 0): Query {
  const out: Query = {};
  const count = 1 + Math.floor(next() * 2);
  for (let i = 0; i < count; i++) {
    const pick = next();
    if (pick < 0.12 && depth < 2) out.$or = Array.from({ length: Math.floor(next() * 3) }, () => makeQuery(next, depth + 1));
    else if (pick < 0.18 && depth < 2) out.$not = makeQuery(next, depth + 1);
    else if (pick < 0.22 && depth < 2) out.$nor = Array.from({ length: 1 + Math.floor(next() * 2) }, () => makeQuery(next, depth + 1));
    else {
      const path = PATHS[Math.floor(next() * PATHS.length)] as string;
      out[path] = next() < 0.4 ? literal(next) : makeCondition(next, depth);
    }
  }
  return out;
}

export function show(value: unknown): string {
  return JSON.stringify(value, (_, item) => (item instanceof Map ? { "<Map>": Object.fromEntries(item) } : item));
}

