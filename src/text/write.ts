import { checkVocabulary, type FieldKind, type Vocabulary } from "../vocabulary.js";
import { quote } from "./quote.js";
import { EXISTS_TERM, EXPLICIT_COMPARISON, SET_TERM, type TextOptions } from "./parse.js";

/**
 * A query, written back as something somebody can type.
 *
 * A dashboard that stores filters as JSON still has to put one in a search box when
 * somebody opens it to edit. That is this, and it is deliberately **not** total: the text
 * syntax has no spelling for `$elemMatch`, `$size`, `$glob` or a `{ "$field": … }`
 * reference, and inventing one per operator would turn a box people can type into a
 * language they have to learn.
 *
 * So the honest answer is two things: the text, and what was left out of it. **The text is
 * exact for what it says** — parsed back with the same vocabulary it means precisely the
 * clauses it carries, which the tests hold it to — but a caller that ignores `unexpressed`
 * is showing somebody a filter wider than the one that is running. `complete` is there so
 * that check is one line.
 */

export interface Unexpressed {
  /** Where the clause is in the query: `$or[1].tags`. */
  readonly at: string;
  /** The clause itself, as it was written. */
  readonly clause: unknown;
  /** Why the text cannot say it. */
  readonly why: string;
}

export interface TextForm {
  /** The query as text. Parsing it back gives exactly the clauses it carries. */
  readonly text: string;
  /** True when the text says everything the query does. */
  readonly complete: boolean;
  /** The clauses with no spelling in the text syntax, in the order they were met. */
  readonly unexpressed: readonly Unexpressed[];
}

/** The operators a condition may hold that the text syntax can say, per field kind. */
const SAYABLE: Readonly<Record<FieldKind, readonly string[]>> = {
  text: ["$contains", "$exists"],
  word: ["$word", "$exists"],
  exact: ["$eq", "$in", "$exists"],
  number: ["$eq", "$gt", "$gte", "$lt", "$lte", "$in", "$exists"],
  date: ["$eq", "$gt", "$gte", "$lt", "$lte", "$in", "$exists"],
  boolean: ["$eq", "$in", "$exists"],
};

const PATH_NAME = /^[\p{L}_][\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*$/u;

/** The comparisons a field with no vocabulary entry can carry: the ones the parser infers back. */
const INFERRED = ["$gt", "$gte", "$lt", "$lte"];

function inferKind(condition: Record<string, unknown>): FieldKind {
  const operators = Object.keys(condition).filter((operator) => operator !== "$options");
  const numeric = operators.length > 0 && operators.every((operator) => INFERRED.includes(operator) && typeof condition[operator] === "number" && Number.isFinite(condition[operator]));
  return numeric ? "number" : "text";
}

/** Writes a query as search-box text, and says what it could not write. */
export function toText(query: unknown, options: TextOptions = {}): TextForm {
  const vocabulary = checkVocabulary(options.vocabulary);
  const mode = options.fields ?? (vocabulary === undefined ? "any" : "vocabulary");
  const left: Unexpressed[] = [];
  const text = writeQuery(query, { vocabulary, mode, left }, "", false);
  return { text, complete: left.length === 0, unexpressed: left };
}

interface Writing {
  readonly vocabulary: Vocabulary<never, object> | undefined;
  readonly mode: "vocabulary" | "any";
  readonly left: Unexpressed[];
}

function drop(writing: Writing, at: string, clause: unknown, why: string): "" {
  writing.left.push({ at, clause, why });
  return "";
}

/**
 * One query, as terms joined by juxtaposition — which is what `$and` means in the text.
 *
 * `grouped` says whether the caller will put this inside something tighter than an `$and`,
 * in which case an `$or` has to be bracketed to keep its meaning.
 */
function writeQuery(query: unknown, writing: Writing, at: string, grouped: boolean): string {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return drop(writing, at, query, "only an object is a query, and the text syntax writes nothing else");
  }
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    const here = at === "" ? key : `${at}.${key}`;
    const written = writeClause(key, value, writing, here, grouped);
    if (written !== "") clauses.push(written);
  }
  if (clauses.length === 0) return "";
  const joined = clauses.join(" ");
  return grouped && clauses.length > 1 ? `(${joined})` : joined;
}

function writeClause(key: string, value: unknown, writing: Writing, at: string, grouped: boolean): string {
  switch (key) {
    case "$comment":
      // A note is not part of what the query asks, so losing it loses nothing.
      return "";
    case "$and": {
      if (!Array.isArray(value)) return drop(writing, at, value, "$and takes a list of queries");
      const parts = value.map((part, index) => writeQuery(part, writing, `${at}[${index}]`, true)).filter((part) => part !== "");
      const joined = parts.join(" ");
      // Several terms are several clauses. Handed back unbracketed to a caller expecting
      // one — a `$not` — only the first was negated: `$not ((a $or b) c)` came out as
      // `$not (a $or b) c`, which is a different question.
      return grouped && parts.length > 1 ? `(${joined})` : joined;
    }
    case "$or": {
      if (!Array.isArray(value)) return drop(writing, at, value, "$or takes a list of queries");
      // An `$or` of nothing matches nothing, and the text syntax has no term for that: it
      // was written as `()`, which reads back as an empty query — everything. A filter that
      // widened from nothing to everything, and called itself complete while doing it.
      if (value.length === 0) return drop(writing, at, value, "an $or of nothing matches nothing, and no term says that");
      const parts = value.map((part, index) => writeQuery(part, writing, `${at}[${index}]`, true));
      // A branch that cannot be written would widen the whole `$or`, so none of it is said.
      if (parts.some((part) => part === "")) return drop(writing, at, value, "one branch of the $or has no spelling, and writing the others would widen it");
      return parts.length === 1 ? (parts[0] as string) : `(${parts.join(" $or ")})`;
    }
    case "$nor": {
      if (!Array.isArray(value) || value.length === 0) return drop(writing, at, value, "$nor takes a list of queries");
      const parts = value.map((part, index) => writeQuery(part, writing, `${at}[${index}]`, true));
      if (parts.some((part) => part === "")) return drop(writing, at, value, "one branch of the $nor has no spelling");
      return `$not (${parts.join(" $or ")})`;
    }
    case "$not":
      return writeNot(value, writing, at);
    case "$text":
      return writeText(value, writing, at);
    default:
      if (key.startsWith("$")) return drop(writing, at, value, `"${key}" is a query operator the text syntax cannot say`);
      return writeField(key, value, writing, at, false);
  }
}

/** `$not` is a leading `-` on one term, and `$not ( … )` on anything larger. */
function writeNot(value: unknown, writing: Writing, at: string): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    // A negated single field is `-term`, and a negated set is `$notin(…)`.
    if (keys.length === 1) {
      const key = keys[0] as string;
      if (!key.startsWith("$")) return writeField(key, (value as Record<string, unknown>)[key], writing, `${at}.${key}`, true);
    }
  }
  // What was already unsayable inside it, before this writes anything: a `$not` whose
  // contents were dropped is reported by that drop, and leaving the negation out is the
  // conservative reading the contract asks for.
  const reported = writing.left.length;
  const inner = writeQuery(value, writing, at, true);
  if (inner === "") {
    // Nothing written and nothing reported means the negation held only things that say
    // nothing — an empty query, or a comment. `$not {}` matches *nothing*, and the empty
    // text matches everything, so staying quiet here turned the narrowest query there is
    // into the widest one and still called the form complete.
    if (writing.left.length === reported) return drop(writing, at, value, "$not of a query that asks nothing matches nothing, and no term says that");
    return "";
  }
  return inner.startsWith("(") ? `$not ${inner}` : `$not (${inner})`;
}

function writeText(value: unknown, writing: Writing, at: string): string {
  const search = typeof value === "string" ? { $search: value } : (value as Record<string, unknown> | null);
  if (search === null || typeof search !== "object" || typeof search.$search !== "string") {
    return drop(writing, at, value, "a text search is a phrase or { $search: … }");
  }
  if (search.$caseSensitive === true) return drop(writing, at, value, "a bare word in the text syntax always ignores case");
  if (search.$fields !== undefined) {
    const fields = search.$fields;
    const same =
      Array.isArray(fields) &&
      writing.vocabulary?.text !== undefined &&
      fields.length === writing.vocabulary.text.length &&
      fields.every((name, index) => name === (writing.vocabulary?.text as readonly string[])[index]);
    // A bare word searches the vocabulary's own text fields; any other list is a question
    // the box cannot ask.
    if (!same) return drop(writing, at, value, "a bare word searches the vocabulary's text fields, not a list of its own");
  }
  if (search.$search === "") return drop(writing, at, value, "an empty search is not a term anybody can type");
  // Quoting cannot save a bare word that begins with a dash, or one that *is* an operator:
  // the parser strips the quotes before it decides what the word is, so `"-a"` would be
  // read back as a negated `a` and `"$or"` as an operator. A field term is safe — the
  // decision there is made on the whole word, which starts with the field's name.
  if (/^[-!]/.test(search.$search)) return drop(writing, at, value, "a bare word cannot begin with a dash: quoted or not, the parser reads that as a negation");
  if (/^\$(and|or|not)$/i.test(search.$search)) return drop(writing, at, value, "a bare word cannot be an operator's name: quoted or not, the parser reads it as the operator");
  const quoted = quote(search.$search, false);
  return quoted ?? drop(writing, at, value, "the phrase holds both kinds of quote, and the syntax has no escape for either");
}

/** One field, as `name:value`, `-name:value`, `name:$in(…)` or `has:name`. */
function writeField(name: string, value: unknown, writing: Writing, at: string, negated: boolean): string {
  const field = writing.vocabulary?.lookup.get(name.toLowerCase());
  if (field === undefined && (writing.mode === "vocabulary" || !PATH_NAME.test(name))) {
    return drop(writing, at, { [name]: value }, writing.mode === "vocabulary" ? `"${name}" is not a field of this vocabulary, so the text would search for it as words` : `"${name}" cannot be written before a colon`);
  }
  const key = field?.name ?? name;
  if (key.toLowerCase() === EXISTS_TERM) {
    return drop(writing, at, { [name]: value }, `"${key}" is how the syntax asks whether a field is set, so a field of that name cannot be written`);
  }
  const condition = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { $eq: value };
  // Without a vocabulary the parser reads a value by its shape, so the writer has to reach
  // the same conclusion: an explicit comparison against a number is a number, and
  // everything else is text. Writing `x:30` for `{ x: { $eq: 30 } }` would read back as the
  // characters "30" — narrower than it looks, and wrong.
  const inferred = field === undefined;
  const kind: FieldKind = field?.kind ?? inferKind(condition);
  const operators = Object.keys(condition).filter((operator) => operator !== "$options");
  if (operators.length === 0 || !operators.every((operator) => operator.startsWith("$"))) {
    return drop(writing, at, { [name]: value }, "the value mixes operators with fields, or holds none");
  }
  const sayable = SAYABLE[kind];
  // `10..20` is what somebody typed, and what the box reads back most naturally; written as
  // two terms it means the same thing but no longer looks like the range it is.
  const range = writeRange(key, kind, condition, operators, negated);
  if (range !== undefined) return range;
  const terms: string[] = [];
  for (const operator of operators) {
    const term = writeOperator(key, kind, operator, condition, writing, at, negated, sayable, inferred);
    if (term === "") return "";
    terms.push(term);
  }
  // Several operators on one field are several terms, which is what juxtaposition means —
  // except under a negation, where `-a -b` would mean neither rather than not both.
  if (terms.length > 1 && negated) return drop(writing, at, { [name]: value }, "a negated field with several operators would have to be written as $not ( … ), which changes what a set means");
  return terms.join(" ");
}

/** `field:a..b`, when the condition is exactly the two ends of one. */
function writeRange(key: string, kind: FieldKind, condition: Record<string, unknown>, operators: readonly string[], negated: boolean): string | undefined {
  if (negated || (kind !== "number" && kind !== "date")) return undefined;
  if (operators.length !== 2 || !operators.includes("$gte") || !operators.includes("$lte")) return undefined;
  const low = writeValue(condition.$gte, kind, "$eq", false, false);
  const high = writeValue(condition.$lte, kind, "$eq", false, false);
  if (low === undefined || high === undefined) return undefined;
  return `${key}:${low}..${high}`;
}

function writeOperator(
  key: string,
  kind: FieldKind,
  operator: string,
  condition: Record<string, unknown>,
  writing: Writing,
  at: string,
  negated: boolean,
  sayable: readonly string[],
  inferred: boolean,
): string {
  const operand = condition[operator];
  const here = `${at}.${operator}`;
  const sign = negated ? "-" : "";
  if (!sayable.includes(operator)) return drop(writing, here, { [operator]: operand }, `"${operator}" has no spelling in the text syntax`);
  if (operator === "$exists") {
    if (operand !== true) return drop(writing, here, { [operator]: operand }, "only $exists: true is written, as has:field; its negation is the leading dash");
    return `${sign}has:${key}`;
  }
  // The box always matches text and names without regard to case, so a condition that does
  // care is one it cannot ask.
  const ignoresCase = condition.$options === "i";
  if ((kind === "text" || kind === "word" || kind === "exact") && !ignoresCase) {
    return drop(writing, here, condition, "the text syntax always ignores case, and this condition does not");
  }

  // A string operator holding a list is a set, and the box writes a set one way.
  const set = operator === "$in" || ((operator === "$contains" || operator === "$word") && Array.isArray(operand));
  const values = set ? operand : [operand];
  if (!Array.isArray(values)) return drop(writing, here, { [operator]: operand }, "$in takes a list");
  if (values.length === 0) return drop(writing, here, { [operator]: operand }, "an empty set is not something anybody types");
  const written: string[] = [];
  for (const value of values) {
    const one = writeValue(value, kind, operator, values.length > 1, inferred);
    if (one === undefined) return drop(writing, here, { [operator]: operand }, `${describeValue(value)} cannot be written after a colon`);
    written.push(one);
  }
  if (written.length > 1) return `${key}:${negated ? "$notin" : "$in"}(${written.join(", ")})`;
  return `${sign}${key}:${written[0] as string}`;
}

/** A value as the box would take it, or `undefined` when it has no spelling. */
function writeValue(value: unknown, kind: FieldKind, operator: string, inSet: boolean, inferred: boolean): string | undefined {
  if (kind === "boolean") return value === true ? "true" : value === false ? "false" : undefined;
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return `${comparison(operator)}${String(value)}`;
  }
  if (kind === "date") {
    const instant = writeDate(value);
    return instant === undefined ? undefined : `${comparison(operator)}${instant}`;
  }
  if (typeof value !== "string" || value === "") return undefined;
  // The parser trims a value after the tokenizer has taken its quotes off, so whitespace at
  // either end is lost — and a value that is only whitespace disappears altogether, taking
  // the term with it and leaving a query that matches everything.
  if (value.trim() !== value) return undefined;
  // `$in(` and `$notin(` are read before quoting is considered, so a value beginning with
  // either is read as a set however it is written.
  if (SET_TERM.test(value)) return undefined;
  // On a field with no kind of its own, the parser reads an explicit comparison as a number,
  // so text that looks like one cannot be written as text.
  if (kind === "text" && inferred && EXPLICIT_COMPARISON.test(value)) return undefined;
  return quote(value, inSet);
}

function comparison(operator: string): string {
  switch (operator) {
    case "$gt":
      return ">";
    case "$gte":
      return ">=";
    case "$lt":
      return "<";
    case "$lte":
      return "<=";
    default:
      return "";
  }
}

function writeDate(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const date = (value as { $date?: unknown }).$date;
  if (Object.keys(value as object).length !== 1) return undefined;
  if (typeof date === "string") return date === "now" ? "now" : /\s/.test(date) ? undefined : date;
  if (date !== null && typeof date === "object") {
    const relative = date as { $ago?: unknown; $ahead?: unknown };
    if (typeof relative.$ago === "string") return `-${relative.$ago}`;
    if (typeof relative.$ahead === "string") return `+${relative.$ahead}`;
  }
  // Epoch milliseconds have no spelling: the box reads a bare number as text.
  return undefined;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return `${typeof value} ${JSON.stringify(value)}`;
}
