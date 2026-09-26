# Quick start

Install it, ask a question, and know where to go next.

← [Documentation](../index.md)

---

```sh
npm install @osqd/jql
```

## A query is JSON

```ts
import { filter, find } from "@osqd/jql";

const users = [
  { id: 1, name: "Ada", roles: ["admin"], address: { city: "London" } },
  { id: 2, name: "Grace", roles: ["editor"], address: { city: "New York" } },
];

find(users, { id: 2 });                                   // Grace
filter(users, { roles: "admin" });                        // [Ada] — a value matches any element
filter(users, { "address.city": { $startsWith: "New" } }); // [Grace]
filter(users, { $or: [{ id: 1 }, { name: { $contains: "gra", $options: "i" } }] });
```

Because the query is plain data, the same object can be stored, put in a URL, sent to
another service, and it finds the same thing there. The [specification](../reference/specification.md)
says exactly what each operator means.

## Or a method on the array

The methods are opt-in, because patching a built-in is the application's decision:

```ts
import "@osqd/jql/global";

const arr = [{ id: 1 }, { id: 2 }];
const object2 = arr.jqlSearch({ id: 2 });
const same = Array.jqlSearch(arr, { id: 2 });           // any array, iterable, Set or Map
new Map([["a", { n: 1 }]]).jqlFilter({ n: 1 });          // a Map in, a Map out
[3, 8, 1].jqlFilter({ $gt: 2 });                        // [3, 8] — a condition on the item itself
```

The element type is inferred, so a field that does not exist is a compile error rather than a
filter that quietly matches nothing. See [TypeScript](../guides/typescript.md).

## Compile once in a loop

```ts
import { compile } from "@osqd/jql";

const isOpen = compile<Order>({ status: "open", total: { $gte: 100 } });
orders.filter(isOpen);
```

Every helper compiles the query it is given; `compile` lets you do that once and keep the
predicate. See [Performance](../design/performance.md).

## Sort, page and pick fields

```ts
import { search } from "@osqd/jql";

search(orders, { where: { status: "open" }, sort: { total: -1 }, skip: 20, limit: 20, fields: ["id", "total"] });
```

## Let people type

```ts
import { parseText } from "@osqd/jql/text";

orders.jqlFilter(parseText('status:open total:>100 -"test account"'));
```

The text becomes a JQL document; nothing about it is matched separately. See
[Text syntax](../reference/text-syntax.md).

## Related

- [The specification](../reference/specification.md) — every operator, precisely
- [Queries from outside](../guides/untrusted-input.md) — before you accept one from a URL
