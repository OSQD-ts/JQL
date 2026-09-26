/**
 * The shapes a query is made of.
 *
 * A JQL query is a JSON document, so everything here describes JSON: no functions, no
 * `RegExp` objects, no `Date` instances. That is the whole point of the language — a
 * query that finds something can be written into a URL, a saved filter, a config file or
 * a request body, sent to somebody else, and find the same thing there. A query that
 * carried a function could do none of that.
 *
 * The types come in two strengths. `Query<T>` for a known `T` only accepts field paths
 * that exist on `T`, with values of the right type, so a typo in a field name is a compile
 * error rather than a filter that quietly matches nothing. `Query<unknown>` (and
 * `Query<any>`) accepts any field, for data whose shape is not known until it arrives;
 * the engine still refuses anything that is not JQL when the query is compiled.
 */

/** A JSON value, as a query document may contain one. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * An instant relative to now, so a saved filter goes on meaning "the last hour".
 *
 * The duration is a count and a unit — `"90s"`, `"1h30m"`, `"7d"` — from `ms`, `s`, `m`,
 * `h`, `d` and `w`. Months and years are left out because neither has a fixed length.
 */
export type RelativeDate = { readonly $ago: string } | { readonly $ahead: string };

/**
 * A date, written the only way JSON can write one.
 *
 * An ISO 8601 string, epoch milliseconds, `"now"`, or a `RelativeDate`. When a query
 * compares against one, the value in the document is read as a date too: a `Date`, an ISO
 * string or epoch milliseconds. The literal is what says "this is a date", so no value is
 * ever read as a date unless the query asked for that.
 */
export interface DateLiteral {
  readonly $date: string | number | RelativeDate;
}

/**
 * A comparison with another field of the same item, rather than with a value.
 *
 * `{ "bytesOut": { "$gt": { "$field": "bytesIn" } } }`. It is still data — a path, not an
 * expression — so a query holding one stores, travels and validates like any other.
 */
export interface FieldReference {
  readonly $field: string;
}

/** The names `$type` accepts. `integer` is a `number` with no fractional part. */
export type TypeName = "string" | "number" | "integer" | "bigint" | "boolean" | "null" | "array" | "object" | "date";

/**
 * A free-text search across a whole document, or across named fields.
 *
 * The string form searches every string (and, when the phrase has a digit in it, every
 * number) anywhere in the document, case-insensitively. The object form narrows the
 * fields and can turn case sensitivity on.
 */
export type TextSearch =
  | string
  | {
      readonly $search: string;
      /** The fields to search. Absent means the whole document, or the vocabulary's text fields when it names some. */
      readonly $fields?: readonly string[] | undefined;
      /** Default `false`: a search box that cared about case would find less than people expect. */
      readonly $caseSensitive?: boolean | undefined;
    };

/* ------------------------------------------------------------------------------------ */
/* Paths                                                                                */
/* ------------------------------------------------------------------------------------ */

type Leaf = string | number | boolean | bigint | symbol | null | undefined | Date | RegExp | ((...args: never[]) => unknown);

/** How deep path completion goes. Past this a path is still valid at run time; the types simply stop enumerating it. */
type Depth = [never, 0, 1, 2, 3, 4, 5];

/** The element type of an array, or the type itself. */
export type ElementOf<T> = T extends readonly (infer E)[] ? E : T;

/**
 * Every dot path into `T`, seeing through arrays the way the engine does.
 *
 * `{ items: { id: number }[] }` yields `"items"`, `"items.id"` (any element's id),
 * `"items.0"` and `"items.0.id"` (one element by position).
 */
export type Path<T, D extends number = 5> = [D] extends [never]
  ? never
  : T extends Leaf
    ? never
    : T extends readonly (infer E)[]
      ? `${number}` | ArrayPaths<E, D> | Path<E, D>
      : T extends ReadonlyMap<string, infer V>
        ? string | `${string}.${Path<V, Depth[D]>}`
        : { [K in keyof T & string]: K | SubPath<K, NonNullable<T[K]>, D> }[keyof T & string];

type ArrayPaths<E, D extends number> = Path<E, Depth[D]> extends infer P extends string ? `${number}.${P}` : never;
type SubPath<K extends string, V, D extends number> = Path<V, Depth[D]> extends infer P extends string ? `${K}.${P}` : never;

/** The type found at a path, with arrays seen through. `unknown` when the path does not resolve. */
export type PathValue<T, P extends string> = T extends readonly (infer E)[]
  ? P extends `${number}`
    ? E
    : P extends `${number}.${infer R}`
      ? PathValue<NonNullable<E>, R>
      : PathValue<NonNullable<E>, P>
  : T extends ReadonlyMap<string, infer V>
    ? P extends `${string}.${infer R}`
      ? PathValue<NonNullable<V>, R>
      : V
    : P extends keyof T
      ? T[P]
      : P extends `${infer K}.${infer R}`
        ? K extends keyof T
          ? PathValue<NonNullable<T[K]>, R>
          : unknown
        : unknown;

/* ------------------------------------------------------------------------------------ */
/* Conditions                                                                           */
/* ------------------------------------------------------------------------------------ */

type Scalar<V> = ElementOf<NonNullable<V>>;

/** What a field may be compared to for equality. `null` also matches a missing field. */
export type Literal<V> = unknown extends V ? JsonValue | DateLiteral : LiteralOf<NonNullable<V>> | null;
type LiteralOf<V> = V extends Date
  ? DateLiteral
  : V extends readonly (infer E)[]
    ? readonly LiteralOf<E>[] | LiteralOf<E>
    : V extends string | number | boolean
      ? V
      : V extends bigint
        ? number
        : V extends object
          ? // A date inside a value is written the same way as one on its own: the engine
            // resolves `{ "$date": … }` wherever it meets it, so the types accept it there.
            { readonly [K in keyof V]: LiteralOf<V[K]> }
          : V;

/**
 * What an ordering operator accepts for a value of type `V`. A `$date` is accepted for
 * strings (ISO timestamps) and numbers (epoch milliseconds) as well as for `Date`s, because
 * that is how dates are stored when they have been through JSON.
 */
type Bound<V> = unknown extends V
  ? number | string | DateLiteral
  : [Extract<Scalar<V>, number | bigint>] extends [never]
    ? [Extract<Scalar<V>, string>] extends [never]
      ? [Extract<Scalar<V>, Date>] extends [never]
        ? never
        : DateLiteral
      : string | DateLiteral
    : number | DateLiteral;

/** Available only when the field can hold a string. */
type StringOperand<V> = unknown extends V ? string | readonly string[] : [Extract<Scalar<V>, string>] extends [never] ? never : string | readonly string[];

/** Available only when the field can hold an array. */
type ArrayOnly<V, X> = unknown extends V ? X : [Extract<NonNullable<V>, readonly unknown[]>] extends [never] ? never : X;

/** Available when the field can hold something with a length: an array or a string. */
type HasLength<V, X> = unknown extends V
  ? X
  : [Extract<NonNullable<V>, readonly unknown[]>] extends [never]
    ? [Extract<Scalar<V>, string>] extends [never]
      ? never
      : X
    : X;

/**
 * An operator expression on one field.
 *
 * Several operators in one object must all hold. On an array field each operator is
 * tested against the array and against each element separately, so `{ $gt: 5, $lt: 10 }`
 * holds for `[1, 20]`. `$elemMatch` is for "one element satisfies all of these".
 */
export interface Condition<V = unknown> {
  readonly $eq?: Literal<V> | FieldReference | undefined;
  /** Also matches a document without the field. */
  readonly $ne?: Literal<V> | FieldReference | undefined;
  readonly $gt?: Bound<V> | FieldReference | undefined;
  readonly $gte?: Bound<V> | FieldReference | undefined;
  readonly $lt?: Bound<V> | FieldReference | undefined;
  readonly $lte?: Bound<V> | FieldReference | undefined;
  /** An empty list matches nothing. */
  readonly $in?: readonly Literal<V>[] | undefined;
  /** Also matches a document without the field. An empty list matches everything. */
  readonly $nin?: readonly Literal<V>[] | undefined;
  readonly $exists?: boolean | undefined;
  readonly $type?: TypeName | readonly TypeName[] | undefined;
  /** Any of the given substrings. */
  readonly $contains?: StringOperand<V> | undefined;
  readonly $startsWith?: StringOperand<V> | undefined;
  readonly $endsWith?: StringOperand<V> | undefined;
  /** A whole component: the value starts and ends on a boundary between runs of letters and digits. */
  readonly $word?: StringOperand<V> | undefined;
  /** A glob: `*` for any run, `?` for one character, `\\` to escape either. */
  readonly $glob?: StringOperand<V> | undefined;
  /** An ECMAScript pattern, as a string. */
  readonly $regex?: ([Extract<Scalar<V>, string>] extends [never] ? (unknown extends V ? string : never) : string) | undefined;
  /** `i` makes every string comparison in this object case-insensitive; `m`, `s`, `u` apply to `$regex`. */
  readonly $options?: string | undefined;
  /** `[divisor, remainder]`. Offered on a big integer too, which is a number everywhere else in the language. */
  readonly $mod?: ([Extract<Scalar<V>, number | bigint>] extends [never] ? (unknown extends V ? readonly [number, number] : never) : readonly [number, number]) | undefined;
  readonly $size?: ArrayOnly<V, number | Condition<number>> | undefined;
  /** The length of the value itself: elements of an array, UTF-16 code units of a string. */
  readonly $length?: HasLength<V, number | Condition<number>> | undefined;
  readonly $all?: ArrayOnly<V, readonly Literal<Scalar<V>>[]> | undefined;
  readonly $elemMatch?: ArrayOnly<V, Query<Scalar<V>>> | undefined;
  readonly $not?: Condition<V> | undefined;
}

/** A literal to compare with, another field to compare with, or an operator expression. */
export type FieldQuery<V> = Literal<V> | FieldReference | Condition<V>;

/* ------------------------------------------------------------------------------------ */
/* Queries                                                                              */
/* ------------------------------------------------------------------------------------ */

/** The operators that combine whole queries. Valid at the top of any query. */
export interface LogicalOperators<Q> {
  /** Every one. An empty list matches everything. */
  readonly $and?: readonly Q[] | undefined;
  /** At least one. An empty list matches nothing. */
  readonly $or?: readonly Q[] | undefined;
  /** None of them. An empty list matches everything. */
  readonly $nor?: readonly Q[] | undefined;
  readonly $not?: Q | undefined;
  readonly $text?: TextSearch | undefined;
  /** Carried along and ignored, so a stored query can say why it exists. */
  readonly $comment?: string | undefined;
}

/**
 * A query over values of type `T`.
 *
 * For an object type, the keys are field paths. For a primitive element type — an array
 * of numbers, say — the query is a condition on the element itself: `{ $gt: 3 }`.
 * `Extra` adds the fields a vocabulary computes, which are not on `T` itself.
 */
export type Query<T = unknown, Extra extends object = {}> = unknown extends T
  ? LooseQuery
  : NonNullable<T> extends Leaf
    ? Condition<T> & LogicalOperators<Query<T, Extra>>
    : TypedQuery<NonNullable<T>, Extra>;

type TypedQuery<T, Extra extends object> = {
  readonly [P in Path<T>]?: FieldQuery<PathValue<T, P>> | undefined;
} & {
  readonly [K in keyof Extra & string]?: FieldQuery<Extra[K]> | undefined;
} & LogicalOperators<Query<T, Extra>>;

/** A query whose field names are not known in advance. The engine validates it when it compiles. */
export type LooseQuery = LogicalOperators<LooseQuery> & { readonly [path: string]: unknown };

declare const untypedBrand: unique symbol;

/**
 * A query that came from outside the type system: typed into a search box, read from a
 * URL, received in a request body.
 *
 * Accepted wherever a typed query is, so `rows.jqlFilter(parseText(input))` compiles. It is
 * branded rather than being a plain `LooseQuery` because a plain one would also accept
 * every object literal — including `{ nme: "Ada" }` — and the typed queries would stop
 * catching typos. For the same reason it has no index signature: one in any member of a
 * union switches off the excess-property check for the whole union, and
 * `users.jqlSearch({ missing: 1 })` compiled until a type test caught it. Cast to
 * `LooseQuery` to read its fields. The brand exists only in the types; the engine
 * validates the query itself when it compiles it, which is the check that matters for
 * input from outside.
 */
export type UntypedQuery = LogicalOperators<LooseQuery> & { readonly [untypedBrand]: true };

/** A compiled query: a plain predicate. Any function of this shape is accepted wherever a query is. */
export type Matcher<T> = (value: T) => boolean;

/** A query document, one that came from outside the types, or one already compiled. */
export type QueryLike<T, Extra extends object = {}> = Query<T, Extra> | UntypedQuery | Matcher<T>;

/* ------------------------------------------------------------------------------------ */
/* Requests: a query plus ordering, paging and projection                               */
/* ------------------------------------------------------------------------------------ */

/** `1` or `"asc"` for ascending, `-1` or `"desc"` for descending. */
export type SortDirection = 1 | -1 | "asc" | "desc";

/** Keys in order of precedence: the first key sorts, the second breaks its ties, and so on. */
export type Sort<T, Extra extends object = {}> = unknown extends T
  ? { readonly [path: string]: SortDirection }
  : { readonly [P in Path<NonNullable<T>> | (keyof Extra & string)]?: SortDirection };

/** A field a request may name: a path into `T`, or a vocabulary field. */
export type FieldName<T, Extra extends object = {}> = unknown extends T ? string : Path<NonNullable<T>> | (keyof Extra & string);

/**
 * A whole question about a collection, as one JSON document.
 *
 * The envelope a service accepts and a dashboard puts in its URL: which items, in which
 * order, which page, and which fields of each.
 */
export interface Request<T = unknown, Extra extends object = {}> {
  /** A query, one already compiled, or any predicate — the same as every other place a query is taken. */
  readonly where?: QueryLike<T, Extra> | undefined;
  readonly sort?: Sort<T, Extra> | undefined;
  /** How many matches to pass over first. Default 0. */
  readonly skip?: number | undefined;
  /** The most to return. Absent means all of them. */
  readonly limit?: number | undefined;
  /** Paths to keep in each result. Absent returns the items themselves. */
  readonly fields?: readonly FieldName<T, Extra>[] | undefined;
  /**
   * Paths to drop from each result, applied after `fields`.
   *
   * What a server redacts with: the values never leave the process, and the request that
   * says so is data like the rest of it. The items themselves are not touched — a result
   * with something dropped is a copy.
   */
  readonly omit?: readonly FieldName<T, Extra>[] | undefined;
}

/** Anything the collection helpers can read: arrays, array-likes, iterables, and maps (by value). */
export type Source<T> = Iterable<T> | ArrayLike<T>;
