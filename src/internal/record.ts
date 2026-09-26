/**
 * Writing a field onto a result object.
 *
 * `target[key] = value` looks harmless until the key is `__proto__`. Assignment goes
 * through the setter inherited from `Object.prototype`, which *replaces the object's
 * prototype* instead of adding a property — so the field the caller asked for is missing
 * and the object answers to names nobody put on it.
 *
 * It is reachable from data rather than from code: `JSON.parse('{"__proto__": …}')` makes
 * an own `__proto__` property, so any document read from a file, a request body or a store
 * can carry one. Projecting such a document used to lose that field and hand back a result
 * whose prototype was whatever the document said, which the projection's own test could not
 * see because the property it was looking for was genuinely there — on the prototype.
 *
 * Defining the property puts it where it was meant to go. Every other key takes the plain
 * assignment, so the guard costs one comparison on the path that builds results.
 */
export function setField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}
