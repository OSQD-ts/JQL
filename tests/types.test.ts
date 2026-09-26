import { describe, expect, it } from "vitest";
import "../src/global.js";
import { compile, defineVocabulary, filter, type Query, search, searchAsync } from "../src/index.js";

/**
 * What the types promise.
 *
 * Most of this file is checked by the compiler rather than by the test runner: each
 * `@ts-expect-error` is a query that must *not* type-check, and `npm run typecheck` fails
 * if it starts to. A typo in a field name that compiles is a filter that silently matches
 * nothing, which is the whole class of bug the typed queries exist to stop.
 */

interface User {
  id: number;
  name: string;
  email?: string | undefined;
  joined: Date;
  roles: ("admin" | "editor")[];
  address: { city: string; geo: { lat: number; lng: number } };
  sessions: { device: string; minutes: number }[];
}

const users: User[] = [
  {
    id: 1,
    name: "Ada",
    joined: new Date("2020-01-01"),
    roles: ["admin"],
    address: { city: "London", geo: { lat: 51.5, lng: -0.1 } },
    sessions: [{ device: "desktop", minutes: 30 }],
  },
];

describe("typed queries", () => {
  it("accepts fields, paths, operators and array paths that exist", () => {
    const queries: Query<User>[] = [
      { id: 1 },
      { name: { $startsWith: "A", $options: "i" } },
      { email: null },
      { "address.city": "London" },
      { "address.geo.lat": { $gt: 50 } },
      { roles: "admin" },
      { roles: { $all: ["admin", "editor"] } },
      { "sessions.device": "desktop" },
      { "sessions.0.minutes": { $gte: 10 } },
      { sessions: { $elemMatch: { device: "mobile", minutes: { $gt: 5 } } } },
      { joined: { $gte: { $date: "2020-01-01" } } },
      { $or: [{ id: 1 }, { "address.city": { $in: ["Paris", "Rome"] } }] },
      { $not: { roles: { $size: 0 } } },
      { $text: "ada" },
    ];
    expect(queries.every((query) => filter(users, query).length <= 1)).toBe(true);
  });

  it("refuses what does not exist or does not fit", () => {
    // @ts-expect-error — there is no field `nme`
    const typo: Query<User> = { nme: "Ada" };
    // @ts-expect-error — `id` is a number
    const wrongType: Query<User> = { id: "1" };
    // @ts-expect-error — `$contains` is for strings, and `id` is not one
    const stringOnNumber: Query<User> = { id: { $contains: "1" } };
    // @ts-expect-error — `$size` is for arrays
    const sizeOnString: Query<User> = { name: { $size: 3 } };
    // @ts-expect-error — no such nested field
    const deepTypo: Query<User> = { "address.cty": "London" };
    // @ts-expect-error — a date is compared with a `{ $date }`, not a Date object
    const dateObject: Query<User> = { joined: { $gt: new Date() } };
    // @ts-expect-error — not a role
    const badRole: Query<User> = { roles: "owner" };
    expect([typo, wrongType, stringOnNumber, sizeOnString, deepTypo, dateObject, badRole]).toHaveLength(7);
  });

  it("infers the element type from the array it is called on", () => {
    const found: User | undefined = users.jqlSearch({ "address.city": "London" });
    const also: User | undefined = Array.jqlSearch(users, { id: 1 });
    // @ts-expect-error — the element type is inferred, so a field it lacks is refused
    users.jqlSearch({ missing: 1 });
    expect(found).toBe(also);
  });

  it("types a query over an array of primitives as a condition on the item", () => {
    const numbers = [1, 2, 3];
    expect(numbers.jqlFilter({ $gt: 1 })).toEqual([2, 3]);
    // @ts-expect-error — a number has no fields
    numbers.jqlFilter({ id: 1 });
  });

  it("takes any field on data of unknown shape", () => {
    const loose: unknown[] = [{ anything: { goes: 1 } }];
    expect(filter(loose, { "anything.goes": 1 })).toHaveLength(1);
  });

  it("reads a Map by value in search, as the collection helpers do", () => {
    const byId = new Map([[1, users[0] as User]]);
    const found: User[] = search(byId, { where: { "address.city": "London" }, sort: { id: 1 } });
    // The annotation is the assertion: without the Map overloads this is `[number, User][]`,
    // which is what the runtime never returns.
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(users[0]);
  });

  it("types sort keys and projected fields", () => {
    expect(search(users, { sort: { "address.geo.lat": -1 }, fields: ["id", "address.city"] })).toEqual([{ id: 1, address: { city: "London" } }]);
    // @ts-expect-error — no such sort key
    search(users, { sort: { age: 1 } });
  });

  /**
   * The five queries the TypeScript guide shows as accepted and the five it shows as errors.
   * The page is where somebody learns what the types do for them, and nothing held it to the
   * types as they are: a promise that stopped being true would read exactly the same.
   */
  it("types the guide's examples the way the guide says", () => {
    interface Guide {
      id: number;
      name: string;
      joined: Date;
      roles: ("admin" | "editor")[];
      address: { city: string };
      sessions: { device: string; minutes: number }[];
    }
    const accepted: Query<Guide> = {
      "address.city": "London",
      "sessions.device": "mobile",
      roles: "admin",
      joined: { $gte: { $date: "2026-01-01" } },
      sessions: { $elemMatch: { minutes: { $gt: 30 } } },
    };
    // One declaration each, not five properties of one object: TypeScript stops reporting
    // after some of a literal's errors, so stacking them makes two of the five look accepted.
    // @ts-expect-error — no such field
    const noField: Query<Guide> = { nme: "Ada" };
    // @ts-expect-error — id is a number
    const wrongType: Query<Guide> = { id: "1" };
    // @ts-expect-error — no such path
    const noPath: Query<Guide> = { "address.cty": "London" };
    // @ts-expect-error — $size is for arrays
    const wrongOperator: Query<Guide> = { name: { $size: 3 } };
    // @ts-expect-error — not a role
    const notARole: Query<Guide> = { roles: "owner" };
    expect(accepted).toBeTypeOf("object");
    expect([noField, wrongType, noPath, wrongOperator, notARole]).toHaveLength(5);
    const rows: Guide[] = [];
    // The methods infer the element type, as the same page says.
    const one: Guide | undefined = rows.jqlSearch({ "address.city": "London" });
    // @ts-expect-error — Guide has no field `missing`
    rows.jqlSearch({ missing: 1 });
    const numbers: number[] = [1, 2, 3].jqlFilter({ $gt: 1 });
    expect(one).toBeUndefined();
    expect(numbers).toEqual([2, 3]);
  });

  /**
   * `omit` hands back a copy without those paths, and `search` has always said so. The
   * methods on `Array` carried only the `fields` overload, so the same request typed as
   * `User[]`: the compiler promised a field the value no longer had, which is the one thing
   * these declarations exist to prevent.
   */
  /**
   * The projection overloads never matched an object literal, so every `search(rows, { fields })`
   * was typed as whole items while it returned projected records. The intersection said
   * `readonly string[]` where `Request` says `readonly FieldName<T>[]`, and with `T` being
   * inferred from the source the two sides could not agree, so the candidate was dropped and
   * the plain overload answered instead.
   *
   * These assertions are written so that the *plain* overload cannot satisfy them: `User[]`
   * is assignable to `Partial<User>[]`, which is why the `omit` case looked fine for so long
   * — the check has to be a property the projected type does *not* have.
   */
  it("types a projected request as projected records, not as whole items", () => {
    const projected = search(users, { fields: ["id"] });
    const withSort = search(users, { where: { id: 1 }, sort: { id: -1 }, fields: ["id", "address.city"], limit: 2 });
    const dropped = search(users, { omit: ["email"] });
    // @ts-expect-error — a projected record is not a User: `name` is not promised
    const leaked: string = projected[0]?.name;
    // @ts-expect-error — nor after a sort and a limit
    const alsoLeaked: string = withSort[0]?.name;
    // @ts-expect-error — `omit` gives partial items, so a required field is no longer required
    const required: string = dropped[0]?.name;
    expect([leaked, alsoLeaked, required]).toHaveLength(3);
    // A name the item does not have is still refused in either list.
    // @ts-expect-error — no such path
    search(users, { fields: ["nope"] });
    // @ts-expect-error — no such path
    search(users, { omit: ["nope"] });
  });

  /** The same overloads on the asynchronous helper and on the methods, checked the same way. */
  it("types a projected request the same way wherever one is taken", async () => {
    async function* arriving(): AsyncGenerator<User> {
      for (const user of users) yield user;
    }
    const streamed = await searchAsync(arriving(), { fields: ["id"] });
    const streamedPartial = await searchAsync(arriving(), { omit: ["email"] });
    // @ts-expect-error — a projected record is not a User
    const one: string = streamed[0]?.name;
    // @ts-expect-error — `omit` gives partial items
    const two: string = streamedPartial[0]?.name;
    const byMethod = users.jqlQuery({ fields: ["id"] });
    const byStatic = Array.jqlQuery(users, { fields: ["id"] });
    // @ts-expect-error — the method projects too
    const three: string = byMethod[0]?.name;
    // @ts-expect-error — and so does the static form
    const four: string = byStatic[0]?.name;
    expect([one, two, three, four]).toHaveLength(4);
  });

  it("types a request with `omit` as partial items, through the methods as well", () => {
    const dropped = users.jqlQuery({ omit: ["email"] });
    const statically = Array.jqlQuery(users, { omit: ["email"] });
    // Partial, so an optional field is all that is promised.
    const first: Partial<User> | undefined = dropped[0];
    const second: Partial<User> | undefined = statically[0];
    expect(first?.email).toBeUndefined();
    expect(second?.email).toBeUndefined();
    // @ts-expect-error — a partial item does not promise `name`
    const named: string = dropped[0].name;
    expect(named).toBeTypeOf("string");
  });

  it("infers a vocabulary's field names from the options, with no type arguments", () => {
    const vocabulary = defineVocabulary<User>()({
      fields: { city: { path: "address.city" }, minutes: { get: (user) => user.sessions.reduce((sum, s) => sum + s.minutes, 0) } },
    });
    expect(users.jqlFilter({ city: "London", minutes: { $gt: 10 } }, { vocabulary })).toHaveLength(1);
    expect(filter(users, { city: "London" }, { vocabulary })).toHaveLength(1);
    expect(search(users, { where: { minutes: { $gte: 30 } }, sort: { minutes: -1 }, fields: ["id", "minutes"] }, { vocabulary })).toEqual([{ id: 1, minutes: 30 }]);
    // @ts-expect-error — a computed number is not a string
    users.jqlFilter({ minutes: "thirty" }, { vocabulary });
    // @ts-expect-error — and a name the vocabulary does not have is still refused
    users.jqlFilter({ town: "London" }, { vocabulary });
  });

  it("adds a vocabulary's computed fields to what a query may name", () => {
    const vocabulary = defineVocabulary<User>()({ fields: { city: { path: "address.city" }, sessionMinutes: { get: (user) => user.sessions.reduce((sum, s) => sum + s.minutes, 0) } } });
    type Extra = NonNullable<(typeof vocabulary)["__extra"]>;
    const query: Query<User, Extra> = { city: "London", sessionMinutes: { $gt: 10 } };
    expect(users.filter(compile<User, Extra>(query, { vocabulary }))).toHaveLength(1);
  });
});
