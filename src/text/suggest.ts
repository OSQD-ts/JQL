import { JqlError } from "../errors.js";
import { checkVocabulary, type Vocabulary } from "../vocabulary.js";
import { TEXT_OPERATORS } from "./parse.js";
import { quote } from "./quote.js";

/**
 * What to offer for the token the caret is in.
 *
 * Returns the completions and the span they replace, so a caller can put one in without
 * disturbing the rest of the input. A token that already names a field with a known set of
 * values completes the value; anything else completes the field name. Every name offered
 * comes from the vocabulary the parser reads, so nothing offered is something the language
 * would not accept.
 *
 * The rule the whole module is written to: **what is offered, inserted, means what it
 * says.** A completion is text somebody will press Tab on without reading, so one that
 * parses into a different query is worse than no completion — the box looks as though it
 * filled itself in correctly and the result is wrong.
 */
export interface Suggestions {
  readonly options: readonly string[];
  readonly from: number;
  readonly to: number;
}

/** Anything completion needs that the vocabulary cannot know when it is written. */
export interface SuggestOptions {
  /**
   * Values seen at run time, by field name — the statuses actually in the table, the paths
   * actually in the log.
   *
   * A vocabulary's `values` is a *closed set*: what the field is allowed to hold, known
   * when the vocabulary is written. Plenty of fields have no such set and still have a
   * handful of values in practice, and a console that has just listed a thousand rows knows
   * them. Passing them here completes the field; leaving them out still offers nothing,
   * because guessing is inventing options rather than completing them.
   *
   * Declared values come first and the two are merged, so a field may have both. Names are
   * resolved through the vocabulary, so an alias works.
   */
  readonly values?: Readonly<Record<string, readonly string[]>> | undefined;
}

/**
 * The start of the token the caret is in.
 *
 * A replay of the parser's own tokenizer over the text before the caret, because the two
 * have to agree about where a token begins. Splitting on the last space — which is what
 * this did — puts the caret's token in the wrong place the moment a value holds one:
 * `status:"in pro` looked like a fresh token `pro` starting after the space, so the span
 * offered to replace cut the input in half.
 */
function tokenAt(before: string): number {
  let start = 0;
  let started = false;
  let quote: '"' | "'" | undefined;
  let setQuote: '"' | "'" | undefined;
  let depth = 0;
  // What the tokenizer has accumulated for this token, which decides whether a `'` is a
  // quote or the apostrophe in `don't`.
  let current = "";

  const begin = (at: number): void => {
    if (!started) {
      start = at;
      started = true;
    }
  };
  const flush = (): void => {
    started = false;
    current = "";
  };

  for (let i = 0; i < before.length; i++) {
    const character = before[i] as string;
    if (depth > 0) {
      current += character;
      if (setQuote !== undefined) {
        if (character === setQuote) setQuote = undefined;
      } else if (character === '"' || character === "'") setQuote = character;
      else if (character === "(") depth++;
      else if (character === ")") {
        depth--;
        if (depth === 0) flush();
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"') {
      begin(i);
      quote = '"';
      continue;
    }
    if (character === "'" && (current === "" || current === "-" || current === "!" || current.endsWith(":"))) {
      begin(i);
      quote = "'";
      continue;
    }
    if (character === "(") {
      if (/\$(in|notin)$/i.test(current)) {
        current += character;
        depth = 1;
        continue;
      }
      flush();
      continue;
    }
    if (character === ")") {
      flush();
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    begin(i);
    current += character;
  }
  return start;
}

/** The values to offer for one field: those it declares, then those the caller has seen. */
function valuesFor(name: string, vocabulary: Vocabulary<never, object> | undefined, given: SuggestOptions["values"]): readonly string[] | undefined {
  const field = vocabulary?.lookup.get(name);
  const declared = field?.values;
  // Looked up by the canonical name as well as by what was typed, so `{ values: { status:
  // … } }` still reaches the field when somebody typed one of its aliases.
  const seen = given?.[name] ?? (field === undefined ? undefined : given?.[field.name]);
  if (declared === undefined && seen === undefined) return undefined;
  const out: string[] = [];
  for (const value of [...(declared ?? []), ...(seen ?? [])]) if (!out.includes(value)) out.push(value);
  return out;
}

function checkGivenValues(values: SuggestOptions["values"]): void {
  if (values === undefined) return;
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new JqlError("takes an object of field names to lists of values", "options.values");
  }
  for (const [name, list] of Object.entries(values)) {
    // Refused rather than skipped: a console that passes the wrong shape here would
    // otherwise get an empty list of completions and no way to tell that from a field
    // nobody has seen a value of yet.
    if (!Array.isArray(list) || list.some((value) => typeof value !== "string")) {
      throw new JqlError("takes a list of strings", `options.values.${name}`);
    }
  }
}

export function suggest(input: string, caret: number, vocabulary?: Vocabulary<never, object>, options?: SuggestOptions): Suggestions {
  checkVocabulary(vocabulary);
  checkGivenValues(options?.values);
  const to = Math.max(0, Math.min(caret, input.length));
  const before = input.slice(0, to);
  const start = tokenAt(before);
  const token = before.slice(start);
  const negated = token.startsWith("-") || token.startsWith("!");
  const body = negated ? token.slice(1) : token;
  const sign = negated ? (token[0] as string) : "";
  const none = { options: [], from: start, to };

  // A token that opens with a quote is a phrase, whatever is inside it. Offering field
  // names there would complete `"sta` to `"status:`, which is a search for the text
  // "status:" and not the field at all.
  if (body.startsWith('"') || body.startsWith("'")) return none;

  const colon = body.indexOf(":");
  if (colon === -1) {
    const partial = body.toLowerCase();
    // A token that has begun with `$` can only be an operator; no field name starts with one.
    if (partial.startsWith("$")) return { options: TEXT_OPERATORS.filter((name) => name.startsWith(partial)), from: start, to };
    const names = vocabulary?.names ?? [];
    return { options: names.filter((name) => name.startsWith(partial)).map((name) => `${sign}${name}:`), from: start, to };
  }

  const name = body.slice(0, colon).toLowerCase();
  const rest = body.slice(colon + 1);
  const prefix = `${sign}${name}:`;
  const values = valuesFor(name, vocabulary, options?.values);

  // Inside `$in(…)`: complete the value after the last comma, and leave everything before
  // it exactly as typed so the values already chosen survive.
  const set = /^\$(in|notin)\(/i.exec(rest);
  if (set !== null) {
    if (values === undefined) return none;
    const opener = set[0];
    const inside = rest.slice(opener.length);
    const comma = inside.lastIndexOf(",");
    const kept = comma === -1 ? "" : inside.slice(0, comma + 1);
    const typed = comma === -1 ? inside : inside.slice(comma + 1);
    const partial = typed.trimStart();
    const spacing = typed.slice(0, typed.length - partial.length);
    return { options: offer(values, partial, true, (written) => `${prefix}${opener}${kept}${spacing}${written}`), from: start, to };
  }

  // The set forms come first, because a field with a known set is exactly the field
  // somebody wants two of.
  const forms = rest.startsWith("$") ? ["$in(", "$notin("].filter((form) => form.startsWith(rest)).map((form) => `${prefix}${form}`) : [];
  if (values === undefined) return { options: forms, from: start, to };
  return { options: [...forms, ...offer(values, unopened(rest), false, (written) => `${prefix}${written}`)], from: start, to };
}

/**
 * What the caret is in the middle of typing, with a quote it has opened taken off.
 *
 * The parser strips those quotes before it reads the value, so `"in pro` is a partial
 * `in pro` — and matching against the quote as though it were part of the value is why a
 * box stopped offering anything the moment somebody opened one.
 */
function unopened(rest: string): string {
  const first = rest[0];
  if (first !== '"' && first !== "'") return rest;
  const body = rest.slice(1);
  return body.endsWith(first) ? body.slice(0, -1) : body;
}

/** The values that continue what has been typed, each written so the parser reads it back. */
function offer(values: readonly string[], partial: string, inSet: boolean, write: (written: string) => string): string[] {
  const wanted = partial.toLowerCase();
  const out: string[] = [];
  for (const value of values) {
    if (!value.toLowerCase().startsWith(wanted)) continue;
    const written = quote(value, inSet);
    // A value holding both kinds of quote has no spelling in this syntax. Offering it
    // unquoted would complete the box with something that parses as something else.
    if (written !== undefined) out.push(write(written));
  }
  return out;
}
