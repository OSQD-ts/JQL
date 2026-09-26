/**
 * Writing a value so the tokenizer reads it back whole.
 *
 * Shared by the writer and by completion, because both hand a value to somebody who will
 * feed it straight back to the parser. They disagreed once: `toText` quoted a value with a
 * space in it and `suggest` did not, so completing `status:` with `in progress` produced
 * `status:in progress` — which parses as `status:in` and a loose search word. A completion
 * that changes the query is worse than no completion at all, and one copy of this rule is
 * how the two stay honest.
 */

/**
 * The value, quoted if it has to be — or `undefined` when the syntax cannot write it.
 *
 * `inSet` is for a value inside `$in(…)`, where a comma separates values and so has to be
 * quoted as well.
 */
export function quote(value: string, inSet: boolean): string | undefined {
  const plain = !/[\s()"'“”‘’]/.test(value) && !/^[-!$]/.test(value) && !(inSet && value.includes(","));
  if (plain) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  // The syntax has no escape inside a quoted run, so a value holding both kinds cannot be
  // written at all. Saying so is better than writing something that reads as less.
  return undefined;
}
