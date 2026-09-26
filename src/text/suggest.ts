import { checkVocabulary, type Vocabulary } from "../vocabulary.js";
import { TEXT_OPERATORS } from "./parse.js";

/**
 * What to offer for the token the caret is in.
 *
 * Returns the completions and the span they replace, so a caller can put one in without
 * disturbing the rest of the input. A token that already names a field with a closed set
 * of values completes the value; anything else completes the field name. Every name
 * offered comes from the vocabulary the parser reads, so nothing offered is something the
 * language would not accept.
 */
export interface Suggestions {
  readonly options: readonly string[];
  readonly from: number;
  readonly to: number;
}

export function suggest(input: string, caret: number, vocabulary?: Vocabulary<never, object>): Suggestions {
  checkVocabulary(vocabulary);
  const before = input.slice(0, caret);
  const start = Math.max(before.lastIndexOf(" ") + 1, 0);
  const token = before.slice(start);
  const to = caret;
  const negated = token.startsWith("-") || token.startsWith("!");
  const body = negated ? token.slice(1) : token;
  const sign = negated ? (token[0] as string) : "";
  const colon = body.indexOf(":");

  if (colon === -1) {
    const partial = body.toLowerCase();
    // A token that has begun with `$` can only be an operator; no field name starts with one.
    if (partial.startsWith("$")) return { options: TEXT_OPERATORS.filter((name) => name.startsWith(partial)), from: start, to };
    const names = vocabulary?.names ?? [];
    return { options: names.filter((name) => name.startsWith(partial)).map((name) => `${sign}${name}:`), from: start, to };
  }

  const name = body.slice(0, colon).toLowerCase();
  const values = vocabulary?.lookup.get(name)?.values;
  // A field that takes anything gets nothing: guessing there would be inventing options
  // rather than completing them.
  if (values === undefined) return { options: [], from: start, to };
  const partial = body.slice(colon + 1).toLowerCase();
  const prefix = `${sign}${name}:`;
  // The set forms come first, because a field with a closed set is exactly the field
  // somebody wants two of.
  const forms = partial.startsWith("$") ? ["$in(", "$notin("].filter((form) => form.startsWith(partial)).map((form) => `${prefix}${form}`) : [];
  return { options: [...forms, ...values.filter((value) => value.toLowerCase().startsWith(partial)).map((value) => `${prefix}${value}`)], from: start, to };
}
