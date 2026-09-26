# Lesson 6 — Typed queries

**Goal:** make a typo in a field name a compile error instead of an empty result.

← [Course](index.md) · Previous: [Dates and windows](05-dates.md) · Next: [Requests](07-requests.md)

---

## The most expensive mistake

```json
{ "statsu": "paid" }
```

That is a perfectly valid query. It asks about a field nothing has, so it matches nothing, so
the page comes back empty, so somebody reports "there were no paid orders this week" — and
they are wrong.

Nothing at run time can catch this. `statsu` might genuinely be a field on some other
collection; the engine has no way to know it is not one of yours. The compiler does.

`Query<T>` knows the shape of `T` and checks three things: the **paths**, the **values**, and
which **operators** make sense for each field.

This is the one lesson that needs TypeScript.

## Setting up

```bash
npm install --save-dev typescript
```

`harbour/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "node16",
    "moduleResolution": "node16",
    "strict": true,
    "noEmit": true
  },
  "files": ["lesson-06.ts"]
}
```

And the shape of an order, which the rest of the lesson refers to. Put this at the top of
`harbour/lesson-06.ts`:

```ts
import { filter, type Query } from "@osqd/jql";

interface Order {
  id: string;
  placed: string;
  status: "open" | "paid" | "refunded" | "cancelled";
  channel: "web" | "app" | "phone";
  customer: { name: string; country: string; email: string };
  lines: { sku: string; title: string; quantity: number; price: number }[];
  total: number;
  paid: number;
  tags: string[];
  note?: string | null;
}

declare const orders: Order[];
```

## What a typed query looks like

Everything you learned in lessons 1 to 5 still applies — paths, operators, `$elemMatch`,
`$date`. The type adds nothing to write:

```ts
const good: Query<Order> = {
  status: "paid",
  "customer.country": "GB",
  "lines.sku": "pen-fine",
  total: { $gte: 30 },
  tags: "repeat",
  lines: { $elemMatch: { quantity: { $gt: 5 } } },
  placed: { $gte: { $date: "2026-09-01" } },
};

filter(orders, good);
```

That compiles cleanly. Run `npx tsc -p tsconfig.json` and you will get nothing back, which is
what "nothing wrong" looks like.

## Six mistakes, six errors

Now add these one at a time and compile after each.

### A misspelt field

```ts
const q: Query<Order> = { statsu: "paid" };
```

```
error TS2561: Object literal may only specify known properties, but 'statsu' does not exist in type 'TypedQuery<Order, {}>'. Did you mean to write 'status'?
```

The suggestion is TypeScript's own spell-checker, working from the key list JQL built out of
your interface.

### The wrong kind of value

```ts
const q: Query<Order> = { total: "30" };
```

```
error TS2322: Type 'string' is not assignable to type 'FieldQuery<number> | undefined'.
```

`total` is a number, so a string is refused — which matters because lesson 2's comparisons
never coerce, so `"30"` really would have matched nothing.

### A value outside a union

```ts
const q: Query<Order> = { status: "posted" };
```

```
error TS2322: Type '"posted"' is not assignable to type 'FieldQuery<"open" | "paid" | "refunded" | "cancelled"> | undefined'.
```

A union type is checked member by member, so a status that does not exist is caught by name.

### A misspelt path

```ts
const q: Query<Order> = { "customer.contry": "GB" };
```

```
error TS2353: Object literal may only specify known properties, and '"customer.contry"' does not exist in type 'TypedQuery<Order, {}>'.
```

Paths are enumerated five levels deep, through arrays as well as objects. Deeper ones still
work at run time; they are simply not offered as suggestions.

### An operator the field cannot serve

```ts
const q: Query<Order> = { status: { $size: 3 } };
```

```
error TS2322: Type 'number' is not assignable to type 'undefined'.
```

This is the one message worth memorising, because it reads so oddly. `$size` counts array
elements and `status` is a string, so `$size`'s type on this field is `undefined` — and
anything at all you pass to it is an error. **`… is not assignable to type 'undefined'` always
means "this operator does not apply to this field".**

### A typo inside `$elemMatch`

```ts
const q: Query<Order> = { lines: { $elemMatch: { quantiy: 5 } } };
```

```
error TS2322: Type '{ $elemMatch: { quantiy: number; }; }' is not assignable to type 'FieldQuery<{ sku: string; title: string; quantity: number; price: number; }[]> | undefined'.
  Types of property '$elemMatch' are incompatible.
    Object literal may only specify known properties, but 'quantiy' does not exist in type 'TypedQuery<{ sku: string; title: string; quantity: number; price: number; }, {}>'. Did you mean to write 'quantity'?
```

Inside `$elemMatch` is a full query over the **element** type, checked just as thoroughly as
the outer one. Read that message from the bottom up; the last line is the actual problem.

Every one of those six would otherwise have compiled, run, and matched nothing.

## When the shape is not known

A query parsed out of a request body, read from a database or typed into a search box has no
`T` to check against — its shape only exists at run time. Say so rather than fighting the
compiler:

```ts
import { untyped, validate } from "@osqd/jql";

// A query that arrived as text: check it, then run the thing you checked.
const checked = validate<Order>(JSON.parse(body));
if (!checked.valid) return respond(400, { error: checked.error.message });
const matching = orders.filter(checked.test);

// A query built at run time, used where a typed one is expected.
filter(orders, untyped(somethingBuiltAtRunTime));
```

- **`untyped(value)`** marks a query as one to check at run time instead of at compile time,
  and is accepted anywhere a typed query is. It is what makes `orders.jqlFilter(parseText(input))`
  compile in lesson 11.
- **`validate`** is lesson 12's subject. Note that it hands back the predicate it compiled, so
  the query you checked is guaranteed to be the query you run.
- **`Query<unknown>`** accepts any field, for the same reason.

In all three cases the engine still refuses anything that is not valid JQL. What you give up
is only the compiler's help with names.

## Exercise

Add `outstanding: number` to `Order` and write a typed query for orders on the app with more
than £50 outstanding. Then misspell `outstanding` and see which of the six errors you get.

<details>
<summary>Answer</summary>

```ts
interface Order { /* … as before … */ outstanding: number }

const chasing: Query<Order> = { channel: "app", outstanding: { $gt: 50 } };
```

Misspell it —

```ts
const chasing: Query<Order> = { channel: "app", outstandng: { $gt: 50 } };
```

— and it is the first of the six errors again:

```
error TS2561: Object literal may only specify known properties, but 'outstandng' does not exist in type 'TypedQuery<Order, {}>'. Did you mean to write 'outstanding'?
```

In lesson 10 this same field becomes a **computed** one that is not on the interface at all —
and the types still know about it.
</details>

## Related

- [TypeScript guide](../guides/typescript.md) — typed queries, the array methods, vocabularies
- [Library API](../reference/api.md) — `Query`, `UntypedQuery`, `validate`
