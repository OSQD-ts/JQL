/**
 * The cases both performance scripts measure, each paired with the hand-written
 * predicate a person would otherwise have written.
 *
 * The hand-written loop is the reference, so every number is a ratio: "JQL costs this many
 * times what the obvious code costs, measured seconds apart in the same process". That
 * holds still across machines, which an absolute figure in microseconds never does.
 */
import { compile, search } from "../src/index.js";

export interface Person {
  id: number;
  name: string;
  age: number;
  active: boolean;
  tags: string[];
  address: { city: string; zip: string };
  notes: string;
  visits: number;
  purchases: number;
}

const CITIES = ["London", "Paris", "Berlin", "Warsaw", "Madrid", "Rome", "Oslo", "Vienna"];
const TAGS = ["admin", "editor", "viewer", "billing", "support", "ops"];

/** Deterministic, so a run is comparable with the last one. */
export function people(total: number): Person[] {
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  return Array.from({ length: total }, (_, id) => ({
    id,
    name: `Person ${id} ${CITIES[id % CITIES.length]}`,
    age: 18 + Math.floor(next() * 60),
    active: next() < 0.7,
    tags: [TAGS[Math.floor(next() * TAGS.length)] as string, TAGS[Math.floor(next() * TAGS.length)] as string],
    address: { city: CITIES[Math.floor(next() * CITIES.length)] as string, zip: String(10_000 + Math.floor(next() * 90_000)) },
    notes: next() < 0.01 ? "escalated to the Needle team" : "nothing to report",
    visits: Math.floor(next() * 50),
    purchases: Math.floor(next() * 50),
  }));
}

export interface Case {
  readonly name: string;
  /** What JQL runs, with the query compiled once outside the timed loop. */
  readonly jql: () => unknown;
  /** The same answer, written by hand. */
  readonly reference: () => unknown;
}

export function cases(data: Person[]): Case[] {
  const last = data.length - 1;
  const ids = Array.from({ length: 100 }, (_, i) => i * 97);
  const idSet = new Set(ids);

  const byId = compile<Person>({ id: last });
  const range = compile<Person>({ age: { $gte: 30, $lt: 50 }, active: true });
  const nested = compile<Person>({ "address.city": "Warsaw" });
  const member = compile<Person>({ id: { $in: ids } });
  const tag = compile<Person>({ tags: "billing" });
  const contains = compile<Person>({ name: { $contains: "WARSAW", $options: "i" } });
  const text = compile<Person>({ $text: "needle" });
  const either = compile<Person>({ $or: [{ "address.city": "Oslo" }, { age: { $gt: 70 } }] });
  const glob = compile<Person>({ name: { $glob: "Person 1*" } });
  const reference = compile<Person>({ visits: { $gt: { $field: "purchases" } } });
  const long = compile<Person>({ notes: { $length: { $gt: 20 } } });

  return [
    { name: "find by id (the common case, walks everything)", jql: () => data.find(byId), reference: () => data.find((p) => p.id === last) },
    { name: "range and flag", jql: () => data.filter(range), reference: () => data.filter((p) => p.age >= 30 && p.age < 50 && p.active === true) },
    { name: "nested path", jql: () => data.filter(nested), reference: () => data.filter((p) => p.address.city === "Warsaw") },
    { name: "$in of 100 ids", jql: () => data.filter(member), reference: () => data.filter((p) => idSet.has(p.id)) },
    { name: "array membership", jql: () => data.filter(tag), reference: () => data.filter((p) => p.tags.includes("billing")) },
    { name: "$contains ignoring case", jql: () => data.filter(contains), reference: () => data.filter((p) => p.name.toLowerCase().includes("warsaw")) },
    { name: "$or", jql: () => data.filter(either), reference: () => data.filter((p) => p.address.city === "Oslo" || p.age > 70) },
    {
      name: "$text over the whole document",
      jql: () => data.filter(text),
      reference: () => data.filter((p) => p.name.toLowerCase().includes("needle") || p.notes.toLowerCase().includes("needle") || p.address.city.toLowerCase().includes("needle") || p.tags.some((t) => t.includes("needle"))),
    },
    { name: "$glob", jql: () => data.filter(glob), reference: () => data.filter((p) => p.name.startsWith("Person 1")) },
    { name: "one field against another", jql: () => data.filter(reference), reference: () => data.filter((p) => p.visits > p.purchases) },
    { name: "$length of a string", jql: () => data.filter(long), reference: () => data.filter((p) => p.notes.length > 20) },
    {
      name: "top 10 by age, sorted (bounded heap)",
      jql: () => search(data, { where: { active: true }, sort: { age: -1 }, limit: 10 }),
      reference: () =>
        data
          .filter((p) => p.active)
          .sort((a, b) => b.age - a.age)
          .slice(0, 10),
    },
    {
      name: "compile and run a small query on 10 items",
      jql: () => data.slice(0, 10).filter(compile<Person>({ id: 3, active: true })),
      reference: () => data.slice(0, 10).filter((p) => p.id === 3 && p.active === true),
    },
  ];
}

/**
 * The median time of one call, in milliseconds.
 *
 * The number of calls per round is calibrated so a round lasts about `roundMs`, because a
 * fixed count is wrong at both ends: twenty calls of a microsecond-long case measures the
 * timer, and twenty calls of a slow one wastes a minute. Several rounds, the median, and a
 * collection between rounds when `--expose-gc` allows it.
 */
export function time(run: () => unknown, roundMs = 40, rounds = 7): number {
  let iterations = 1;
  for (;;) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    const elapsed = performance.now() - start;
    if (elapsed >= roundMs / 4) {
      iterations = Math.max(1, Math.ceil((iterations * roundMs) / elapsed));
      break;
    }
    iterations *= 4;
  }
  const samples: number[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  for (let round = 0; round < rounds; round++) {
    gc?.();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}
