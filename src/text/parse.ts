import { parseDuration } from "../internal/duration.js";
import type { LooseQuery, UntypedQuery } from "../types.js";
import { checkVocabulary, type FieldKind, type Vocabulary, type VocabularyField } from "../vocabulary.js";

/**
 * The search-box syntax, compiled into a JQL document.
 *
 * Ported from BotHandler's feed filter, where it was its own language with its own
 * matcher. Here it has no matcher at all: it produces the JSON query that means the same
 * thing, and the engine runs that. So a filter typed into a box and the JSON a service
 * receives cannot drift apart — there is only one set of semantics, and the text is a way
 * of writing it.
 *
 * ```text
 * actor:203.0.113.4 -path:/health          that address, except its health checks
 * verdict:human $or verdict:unknown        either verdict
 * $not path:/health                        the same as -path:/health, spelled out
 * action:$in(block, drop)                  one of a set
 * action:$notin(allow, tag)                none of a set
 * score:>70   score:>=70   score:10..20    numeric comparisons and a range
 * at:>2026-09-01                           a date comparison
 * at:>-1h                                  the last hour, and it stays the last hour
 * has:rule    -has:rule                    the field is set, or is not
 * (verdict:human $or score:<20) $and $not path:/health
 * "connection reset"                       a phrase, spaces and all — matched against one
 *                                          value, never joined across two fields
 * ```
 *
 * **Adjacent terms mean AND**, which is what narrowing means. `$or` binds more loosely than
 * `$and`, and `$not` more tightly than either — the conventional precedence. Operators
 * carry a `$` because a bare `or` is a word that appears in User-Agents and paths, and a
 * language where an ordinary search word silently becomes an operator is a language that
 * lies about what it matched.
 *
 * **Nothing here throws for anything anybody types.** It backs live search boxes, so
 * half-typed input is the normal state rather than an error: an unclosed bracket, a dangling
 * `$or`, a `$in(` with nothing after it all parse to the best reading available. A
 * *vocabulary* that is not one is the exception — that is a mistake in the calling code
 * rather than in the box, and it is refused by name instead of failing later, deeper, as a
 * `TypeError` nobody can place. That is the opposite of the JSON
 * engine's rule, and on purpose: JSON is written by a program that can be told it is wrong,
 * a search box by a person who has not finished typing.
 */

export interface TextOptions {
  /** The field names the text may use, and how each one reads a value. */
  readonly vocabulary?: Vocabulary<never, object> | undefined;
  /**
   * What a name before a colon may be.
   *
   * - `"vocabulary"` — only a vocabulary field; anything else is searched for as text,
   *   because a path or a User-Agent can contain a colon. The default when a vocabulary is given.
   * - `"any"` — any name that looks like a path (`address.city:London`), read as text.
   *   The default without a vocabulary, since there is nothing else to go on. A URL then
   *   has to be quoted: `"http://example.com"`.
   */
  readonly fields?: "vocabulary" | "any" | undefined;
}

/**
 * The longest input this will read.
 *
 * Parsing is linear, so length is not a cliff the way nesting is, but this runs on every
 * keystroke and on whatever arrives in a URL. Eight kilobytes is past any query a person
 * writes. Longer input is cut, not refused, because refusing would be the one way this
 * function could fail.
 */
export const MAX_TEXT_CHARS = 8192;

/**
 * How deep brackets may nest.
 *
 * Past anything anyone types, and deliberately no deeper than the tightest limit the engine
 * is asked to compile under (`UNTRUSTED_LIMITS` allows sixteen levels): a box that produced
 * a query the engine would refuse would be a box that lies about what it accepts.
 */
export const MAX_TEXT_DEPTH = 16;

/** The name that asks whether a field is set, rather than naming one. */
export const EXISTS_TERM = "has";

/** The operator words the text syntax understands. */
export const TEXT_OPERATORS: readonly string[] = ["$and", "$or", "$not", "$in", "$notin"];

interface Term {
  readonly name: string | undefined;
  readonly value: string;
  readonly negated: boolean;
  /** For `$in` and `$notin`. */
  readonly values?: readonly string[] | undefined;
}

type Tree = { kind: "all" } | { kind: "term"; term: Term } | { kind: "not"; of: Tree } | { kind: "and"; parts: Tree[] } | { kind: "or"; parts: Tree[] };

type Token = { kind: "word"; text: string } | { kind: "open" } | { kind: "close" } | { kind: "op"; op: "and" | "or" | "not" };

/**
 * Parses search-box text into a JQL query. Never throws; an empty input is `{}`, which
 * matches everything. The result is an `UntypedQuery`, so it can be handed to a typed
 * collection: what the text names is only known once somebody has typed it.
 */
export function parseText(input: string, options: TextOptions = {}): UntypedQuery {
  checkVocabulary(options.vocabulary);
  const trimmed = plainQuotes(String(input).trim());
  const tokens = tokenize(trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed);
  const mode = options.fields ?? (options.vocabulary === undefined ? "any" : "vocabulary");
  // A cast rather than a call to `untyped()`: importing the engine for an identity function
  // would put all of it in the text entry, which exists so that it does not.
  return toQuery(parseTokens(tokens), options.vocabulary, mode) as unknown as UntypedQuery;
}

/* ------------------------------------------------------------------------------------ */
/* Quotes and tokens                                                                    */
/* ------------------------------------------------------------------------------------ */

/**
 * Typographic quotes, and the plain ones they stand for.
 *
 * Nobody types a curly quote into a filter meaning a curly quote. They arrive by paste,
 * from anything with smart punctuation turned on. In BotHandler they used to be taken
 * literally, so `actor:$notin(“203.0.113.4”)` excluded nothing, with no sign anything was
 * wrong.
 */
const DOUBLE_QUOTES = "\u201c\u201d\u201e\u201f\u2033\u2036";
const TYPOGRAPHIC_QUOTES = /[\u201c\u201d\u201e\u201f\u2033\u2036\u2018\u2019\u201a\u201b\u2032\u2035]/g;

function plainQuotes(input: string): string {
  return input.replace(TYPOGRAPHIC_QUOTES, (quote) => (DOUBLE_QUOTES.includes(quote) ? '"' : "'"));
}

const SET_OPENER = /\$(in|notin)$/i;
const SPACE = /\s/;

/**
 * Splits the input into words, operators and brackets.
 *
 * Quoted runs stay whole, spaces and brackets included. A `field:$in(...)` list is one
 * word, because its brackets belong to the term rather than grouping.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  // The same, inside a `$in(...)` set, where quotes are kept for `splitSet` to read and a
  // bracket inside one must not end the set.
  let setQuote: '"' | "'" | undefined;
  let depth = 0;

  const flush = (): void => {
    if (current === "") return;
    const lower = current.toLowerCase();
    if (lower === "$and" || lower === "$or" || lower === "$not") tokens.push({ kind: "op", op: lower.slice(1) as "and" | "or" | "not" });
    else tokens.push({ kind: "word", text: current });
    current = "";
  };

  for (let i = 0; i < input.length; i++) {
    const character = input[i] as string;
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
      quote = '"';
      continue;
    }
    // A single quote is a quote only where a value begins. Anywhere else it is the
    // apostrophe in `don't` or `o'reilly`, and treating it as a quote would swallow the
    // rest of the query.
    if (character === "'" && (current === "" || current === "-" || current === "!" || current.endsWith(":"))) {
      quote = "'";
      continue;
    }
    if (character === "(") {
      if (SET_OPENER.test(current)) {
        current += character;
        depth = 1;
        continue;
      }
      flush();
      tokens.push({ kind: "open" });
      continue;
    }
    if (character === ")") {
      flush();
      tokens.push({ kind: "close" });
      continue;
    }
    if (SPACE.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
}

/**
 * The values of a `$in(...)` set. A comma separates values only outside quotes, and a quote
 * left open runs to the end, because that is what a box somebody is typing into looks like.
 */
function splitSet(inside: string): string[] {
  const values: string[] = [];
  let at = 0;
  while (at < inside.length) {
    while (at < inside.length && SPACE.test(inside[at] as string)) at++;
    if (at >= inside.length) break;
    const open = inside[at];
    let value: string;
    if (open === '"' || open === "'") {
      const close = inside.indexOf(open, at + 1);
      value = close === -1 ? inside.slice(at + 1) : inside.slice(at + 1, close);
      at = close === -1 ? inside.length : close + 1;
      const comma = inside.indexOf(",", at);
      at = comma === -1 ? inside.length : comma + 1;
    } else {
      const comma = inside.indexOf(",", at);
      const end = comma === -1 ? inside.length : comma;
      value = inside.slice(at, end);
      at = end + 1;
    }
    const cleaned = value.trim();
    if (cleaned !== "") values.push(cleaned);
  }
  return values;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  return (first === '"' || first === "'") && trimmed.endsWith(first) ? trimmed.slice(1, -1) : trimmed;
}

export const SET_TERM = /^\$(in|notin)\(([\s\S]*)$/i;

function toTerm(word: string): Term | undefined {
  const negated = word.startsWith("-") || word.startsWith("!");
  const body = negated ? word.slice(1) : word;
  if (body === "") return undefined;
  const colon = body.indexOf(":");
  if (colon <= 0) return { name: undefined, value: body, negated };
  const name = body.slice(0, colon);
  const rest = body.slice(colon + 1);
  // The closing bracket is stripped separately. Matched as an optional `\)?` at the end of
  // one pattern, the greedy middle swallowed it and handed it to the last value, so
  // `$notin(/health, /checkout)` stopped excluding `/checkout`.
  const set = SET_TERM.exec(rest);
  if (set !== null) {
    const raw = set[2] as string;
    const values = splitSet(raw.endsWith(")") ? raw.slice(0, -1) : raw);
    const inverted = (set[1] as string).toLowerCase() === "notin";
    return { name, value: values[0] ?? "", negated: negated !== inverted, values };
  }
  const value = unquote(rest);
  if (value === "") return undefined;
  return { name, value, negated };
}

/**
 * Recursive descent, `$not` tightest and `$or` loosest.
 *
 * A dangling operator, an unclosed bracket or a stray close is dropped rather than raised.
 * Brackets past `MAX_TEXT_DEPTH` are ignored rather than descended into: in BotHandler five
 * thousand nested brackets in a shared link overflowed the stack and broke the dashboard
 * for whoever opened it.
 */
function parseTokens(tokens: readonly Token[]): Tree {
  let at = 0;
  let depth = 0;

  const parseUnary = (): Tree | undefined => {
    const token = tokens[at];
    if (token === undefined) return undefined;
    if (token.kind === "op" && token.op === "not") {
      // A run of negations is its parity, which is both what they mean and what keeps the
      // query shallow: thirty-three `$not`s used to build thirty-three levels, past what the
      // engine will compile, so the box could produce a filter that would not run.
      let negations = 0;
      while (tokens[at]?.kind === "op" && (tokens[at] as { op: string }).op === "not") {
        at++;
        negations++;
      }
      const of = parseUnary();
      if (of === undefined) return undefined;
      return negations % 2 === 0 ? of : { kind: "not", of };
    }
    if (token.kind === "open") {
      at++;
      if (depth >= MAX_TEXT_DEPTH) return undefined;
      depth++;
      const inner = parseOr();
      depth--;
      if (tokens[at]?.kind === "close") at++;
      return inner.kind === "all" ? undefined : inner;
    }
    if (token.kind === "close") return undefined;
    if (token.kind === "op") {
      at++;
      return parseUnary();
    }
    at++;
    const term = toTerm(token.text);
    return term === undefined ? undefined : { kind: "term", term };
  };

  const parseAnd = (): Tree => {
    const parts: Tree[] = [];
    while (at < tokens.length) {
      const token = tokens[at];
      if (token === undefined || token.kind === "close") break;
      if (token.kind === "op" && token.op === "or") break;
      if (token.kind === "op" && token.op === "and") {
        at++;
        continue;
      }
      const before = at;
      const part = parseUnary();
      if (part !== undefined) parts.push(part);
      if (at === before) at++;
    }
    return parts.length === 0 ? { kind: "all" } : parts.length === 1 ? (parts[0] as Tree) : { kind: "and", parts };
  };

  const parseOr = (): Tree => {
    const parts: Tree[] = [parseAnd()];
    while (tokens[at]?.kind === "op" && (tokens[at] as { op: string }).op === "or") {
      at++;
      parts.push(parseAnd());
    }
    const real = parts.filter((part) => part.kind !== "all");
    if (real.length === 0) return { kind: "all" };
    return real.length === 1 ? (real[0] as Tree) : { kind: "or", parts: real };
  };

  // Stray closing brackets at the top level end `parseOr` early; keep going past them so
  // `a) b` still reads both terms.
  const parts: Tree[] = [];
  while (at < tokens.length) {
    const tree = parseOr();
    if (tree.kind !== "all") parts.push(tree);
    if (tokens[at]?.kind === "close") at++;
  }
  if (parts.length === 0) return { kind: "all" };
  return parts.length === 1 ? (parts[0] as Tree) : { kind: "and", parts };
}

/* ------------------------------------------------------------------------------------ */
/* To JQL                                                                               */
/* ------------------------------------------------------------------------------------ */

/** A query that matches nothing: an empty `$in`. What a half-typed set or an unreadable number means. */
function nothing(key: string): LooseQuery {
  return { [key]: { $in: [] } };
}

function toQuery(tree: Tree, vocabulary: Vocabulary<never, object> | undefined, mode: "vocabulary" | "any"): LooseQuery {
  switch (tree.kind) {
    case "all":
      return {};
    case "not":
      return { $not: toQuery(tree.of, vocabulary, mode) };
    case "and":
      return { $and: tree.parts.map((part) => toQuery(part, vocabulary, mode)) };
    case "or":
      return { $or: tree.parts.map((part) => toQuery(part, vocabulary, mode)) };
    case "term": {
      const query = termQuery(tree.term, vocabulary, mode);
      return tree.term.negated ? { $not: query } : query;
    }
  }
}

const PATH_NAME = /^[\p{L}_][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*$/u;

function termQuery(term: Term, vocabulary: Vocabulary<never, object> | undefined, mode: "vocabulary" | "any"): LooseQuery {
  let field: VocabularyField<never> | undefined;
  let key: string | undefined;
  // `has:rule` asks about a field rather than a value, so its value *is* the field name.
  if (term.name !== undefined && term.name.toLowerCase() === EXISTS_TERM && term.values === undefined) {
    const named = existence(term.value, vocabulary, mode);
    if (named !== undefined) return named;
  }
  if (term.name !== undefined) {
    field = vocabulary?.lookup.get(term.name.toLowerCase());
    if (field !== undefined) key = field.name;
    else if (mode === "any" && PATH_NAME.test(term.name)) key = term.name;
  }
  if (key === undefined) {
    // A colon with an unknown name in front of it is not a field term: `foo:bar` searches
    // for the text `foo:bar`, and a set on an unknown name for what was typed.
    const text = term.name === undefined ? term.value : `${term.name}:${term.values === undefined ? term.value : term.values.join(",")}`;
    return freeText(text, vocabulary);
  }
  const kind: FieldKind = field?.kind ?? (term.values === undefined && EXPLICIT_COMPARISON.test(term.value) ? "number" : "text");
  const values = term.values ?? [term.value];
  // An empty set matches nothing rather than everything: `$in()` is half-typed, and a
  // filter that widens while somebody is still typing it is a filter that lies.
  if (values.length === 0) return nothing(key);
  switch (kind) {
    case "text":
      return { [key]: { $contains: single(values), $options: "i" } };
    case "word":
      return { [key]: { $word: single(values), $options: "i" } };
    case "exact":
      return values.length === 1 ? { [key]: { $eq: values[0], $options: "i" } } : { [key]: { $in: values, $options: "i" } };
    case "boolean": {
      const read = values.map(readBoolean).filter((value): value is boolean => value !== undefined);
      if (read.length === 0) return nothing(key);
      return read.length === 1 ? { [key]: read[0] } : { [key]: { $in: read } };
    }
    case "number":
    case "date": {
      if (term.values !== undefined) {
        const read = values.map((value) => readScalar(value, kind)).filter((value) => value !== undefined);
        return read.length === 0 ? nothing(key) : { [key]: { $in: read } };
      }
      const condition = comparison(term.value, kind);
      return condition === undefined ? nothing(key) : { [key]: condition };
    }
  }
}

/**
 * A comparison written out in full, on a field nothing is known about.
 *
 * Without a vocabulary every field reads as text, and `score:>70` would search for the
 * characters ">70" — which nobody typing it means. An operator or a range with a number
 * on it is unambiguous, so it compares. A bare `70` stays text, because on an unknown
 * field it is as likely to be part of an identifier as a quantity.
 */
export const EXPLICIT_COMPARISON = /^(?:(?:>=|<=|>|<)[+-]?(?:\d+\.?\d*|\.\d+)|[+-]?(?:\d+\.?\d*|\.\d+)?\.\.[+-]?(?:\d+\.?\d*|\.\d+)?)$/;

/**
 * `has:<field>` — the field has a value.
 *
 * Returns nothing when the name is not a field here, so `has:something-else` falls through
 * and is searched for as text, the same as any other name the vocabulary does not know.
 */
function existence(name: string, vocabulary: Vocabulary<never, object> | undefined, mode: "vocabulary" | "any"): LooseQuery | undefined {
  const field = vocabulary?.lookup.get(name.toLowerCase());
  if (field !== undefined) return { [field.name]: { $exists: true } };
  if (mode === "any" && PATH_NAME.test(name)) return { [name]: { $exists: true } };
  return undefined;
}

function single(values: readonly string[]): string | readonly string[] {
  return values.length === 1 ? (values[0] as string) : values;
}

function freeText(text: string, vocabulary: Vocabulary<never, object> | undefined): LooseQuery {
  if (vocabulary?.text !== undefined) return { $text: { $search: text, $fields: vocabulary.text } };
  return { $text: text };
}

const TRUE_WORDS = new Set(["true", "yes", "1", "on"]);
const FALSE_WORDS = new Set(["false", "no", "0", "off"]);

function readBoolean(value: string): boolean | undefined {
  const lower = value.toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;
  return undefined;
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A relative instant, written with the sign that says which way: `-1h` is an hour ago,
 * `+30m` is half an hour from now.
 *
 * The sign is required. A bare `1h` in a date field could as easily be part of an
 * identifier somebody is searching for, and a filter that quietly turned it into a moment
 * in time would be reading something into what was typed.
 */
const RELATIVE = /^([+-])(\d+(?:ms|s|m|h|d|w))+$/;

function readScalar(value: string, kind: "number" | "date"): number | { $date: string | { $ago: string } | { $ahead: string } } | undefined {
  const trimmed = value.trim();
  if (kind === "number") {
    if (!NUMBER.test(trimmed)) return undefined;
    const read = Number(trimmed);
    // `1e309` reads as Infinity, which is not a JSON number: the query would be one the
    // engine refuses and `JSON.stringify` turns into null, so a box could produce a filter
    // that could neither run nor be saved. A number nobody can write is a value nothing has.
    if (!Number.isFinite(read)) return undefined;
    // `-0` matches everything `0` matches, and writing it out as JSON turns it into `0`
    // anyway; normalising here keeps a saved query identical to the one that was typed.
    return read === 0 ? 0 : read;
  }
  if (trimmed.toLowerCase() === "now") return { $date: "now" };
  const relative = RELATIVE.exec(trimmed);
  if (relative !== null) {
    const span = trimmed.slice(1);
    // A duration the engine could not size is not one anybody typed on purpose, and
    // emitting it would hand the box a query that cannot run.
    if (parseDuration(span) === undefined) return undefined;
    return { $date: relative[1] === "-" ? { $ago: span } : { $ahead: span } };
  }
  return trimmed !== "" && !Number.isNaN(Date.parse(trimmed)) ? { $date: trimmed } : undefined;
}

const COMPARISON = /^(>=|<=|>|<|=)?([\s\S]*)$/;

/** `>70`, `>=70`, `<70`, `<=70`, `=70`, `70`, and the range `10..20` (both ends included). */
function comparison(value: string, kind: "number" | "date"): Record<string, unknown> | undefined {
  const range = value.indexOf("..");
  if (range !== -1) {
    const low = value.slice(0, range);
    const high = value.slice(range + 2);
    const from = low === "" ? undefined : readScalar(low, kind);
    const to = high === "" ? undefined : readScalar(high, kind);
    if ((low !== "" && from === undefined) || (high !== "" && to === undefined) || (from === undefined && to === undefined)) return undefined;
    return { ...(from === undefined ? {} : { $gte: from }), ...(to === undefined ? {} : { $lte: to }) };
  }
  const [, operator, rest] = COMPARISON.exec(value) as RegExpExecArray;
  const scalar = readScalar(rest as string, kind);
  if (scalar === undefined) return undefined;
  switch (operator) {
    case ">":
      return { $gt: scalar };
    case ">=":
      return { $gte: scalar };
    case "<":
      return { $lt: scalar };
    case "<=":
      return { $lte: scalar };
    default:
      return { $eq: scalar };
  }
}
