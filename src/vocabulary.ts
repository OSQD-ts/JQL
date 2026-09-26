import { JqlError } from "./errors.js";
import { describe } from "./internal/values.js";
import type { PathValue } from "./types.js";

/**
 * The names a query may use for one kind of document.
 *
 * Without one, a field name is a path and nothing more. With one, a collection gets the
 * names people actually type — `ip` for `actor`, `ua` for `request.headers.user-agent` —
 * and fields that are computed rather than stored, like BotHandler's `outcome`, which is
 * derived from the action and never kept anywhere.
 *
 * The same vocabulary serves the JSON engine and the text front end. That is deliberate:
 * two places that each kept their own list of field names would be two dialects within a
 * week, and a filter typed into a search box has to mean exactly what the JSON it becomes
 * means.
 */

/**
 * How the text front end reads a value typed after `field:`. The JSON engine ignores it:
 * a JSON query says what it means with its operator.
 *
 * - `text` — contains the value, ignoring case. The default, and right for prose.
 * - `word` — contains it as a whole component (`1.2.3.4` does not find `1.2.3.45`). For identifiers.
 * - `exact` — equals it, ignoring case. For closed sets like a verdict or a method.
 * - `number` — compares: `>70`, `<=5`, `10..20`, `42`.
 * - `date` — compares instants the same way: `>2026-01-01`.
 * - `boolean` — `true`/`false`, `yes`/`no`, `1`/`0`.
 */
export type FieldKind = "text" | "word" | "exact" | "number" | "date" | "boolean";

export interface FieldDefinition<T = unknown> {
  /** Where the value lives. Default: the field's own name. */
  readonly path?: string | undefined;
  /** Computes the value instead. Called once per document the field is tested against; it must not throw. */
  readonly get?: ((document: T) => unknown) | undefined;
  /** Other names that mean this field. */
  readonly aliases?: readonly string[] | undefined;
  /** Default `"text"`. */
  readonly kind?: FieldKind | undefined;
  /** The values worth offering as completions, when the set is closed. Leave out for a field that takes anything. */
  readonly values?: readonly string[] | undefined;
}

export interface VocabularyDefinition<T = unknown> {
  readonly fields: Readonly<Record<string, FieldDefinition<T>>>;
  /** The fields a bare search word looks in. Default: the whole document. */
  readonly text?: readonly string[] | undefined;
  /**
   * Whether a name outside the vocabulary is refused. Default `false`, so any path still
   * works alongside the named fields. Turn it on where the vocabulary is the whole
   * contract — a public API whose documents may grow fields nobody promised to keep.
   */
  readonly strict?: boolean | undefined;
}

/** One field, with every name that reaches it already resolved. */
export interface VocabularyField<T = unknown> {
  readonly name: string;
  readonly kind: FieldKind;
  readonly path: string;
  readonly get: ((document: T) => unknown) | undefined;
  readonly aliases: readonly string[];
  readonly values: readonly string[] | undefined;
}

/**
 * A vocabulary ready to use.
 *
 * `Extra` is the type of the fields it names, so a typed query can use them: build one
 * with `defineVocabulary<Doc>()({ … })` and the computed names type-check.
 */
export interface Vocabulary<T = unknown, Extra extends object = {}> {
  /** Every name, aliases included, lower-cased, to the field it means. */
  readonly lookup: ReadonlyMap<string, VocabularyField<T>>;
  /** The canonical fields, in the order they were defined. */
  readonly fields: readonly VocabularyField<T>[];
  /** Every name a query may use, aliases included, sorted. For completions. */
  readonly names: readonly string[];
  readonly text: readonly string[] | undefined;
  readonly strict: boolean;
  /** Carries the computed field types. Never present at run time. */
  readonly __extra?: Extra | undefined;
}

type ExtraOf<T, F> = {
  [K in keyof F]: F[K] extends { get: (document: T) => infer R } ? R : F[K] extends { path: infer P extends string } ? PathValue<T, P> : K extends string ? PathValue<T, K> : unknown;
};

/** Names a query may never use for a field: they begin like an operator, or contain a path separator. */
const BAD_NAME = /^\$|\./;

/**
 * Builds a vocabulary, refusing one that would quietly misbehave.
 *
 * Two names that collide, a text field that is not a field, a field with both a path and a
 * getter: each is a vocabulary that looks defined and means something other than what it
 * says, so each is an error here rather than a surprise at query time.
 *
 * Curried so the document type can be given while the field names are inferred:
 * `defineVocabulary<Request>()({ fields: { … } })`.
 */
export function defineVocabulary<T = unknown>(): <const D extends VocabularyDefinition<T>>(definition: D) => Vocabulary<T, ExtraOf<T, D["fields"]>> {
  return (definition) => build(definition) as Vocabulary<T, ExtraOf<T, (typeof definition)["fields"]>>;
}

/**
 * Refuses anything that is not a vocabulary, where one was expected.
 *
 * Two mistakes land here, and both used to arrive as `Cannot read properties of undefined
 * (reading 'get')` from somewhere inside the engine. `defineVocabulary` is curried, so
 * `defineVocabulary({ fields: … })` — the empty parentheses forgotten — returns a *function*;
 * and a definition passed straight through is an object with no `lookup` on it. Neither is
 * caught by the types from JavaScript, and a `TypeError` is not a `JqlError`, so `validate`
 * re-threw it: the one call whose job is to answer 400 rather than 500 answered 500.
 */
export function checkVocabulary<T>(value: T, at = "vocabulary"): T {
  if (value === undefined || (value !== null && typeof value === "object" && (value as { lookup?: unknown }).lookup instanceof Map)) return value;
  throw new JqlError(
    `is not a vocabulary, but ${describe(value)}: build one with defineVocabulary()({ fields: … }) — the empty parentheses first — and pass what that returns`,
    at,
  );
}

function build<T>(definition: VocabularyDefinition<T>): Vocabulary<T> {
  const lookup = new Map<string, VocabularyField<T>>();
  const fields: VocabularyField<T>[] = [];
  const claim = (name: string, field: VocabularyField<T>): void => {
    const key = name.toLowerCase();
    if (name === "" || BAD_NAME.test(name)) throw new JqlError(`"${name}" cannot name a field: a field name is not empty, does not start with "$" and has no "."`, "vocabulary");
    const holder = lookup.get(key);
    if (holder !== undefined) {
      throw new JqlError(`"${name}" names both "${holder.name}" and "${field.name}", so a query using it could mean either`, "vocabulary");
    }
    lookup.set(key, field);
  };

  for (const [name, spec] of Object.entries(definition.fields)) {
    if (spec.path !== undefined && spec.get !== undefined) {
      throw new JqlError(`"${name}" has both a path and a getter; one of them would be ignored, so say which`, `vocabulary.${name}`);
    }
    if (spec.path === "") throw new JqlError(`"${name}" has an empty path, which reaches nothing`, `vocabulary.${name}`);
    const field: VocabularyField<T> = {
      name,
      kind: spec.kind ?? "text",
      path: spec.path ?? name,
      get: spec.get,
      aliases: spec.aliases ?? [],
      values: spec.values,
    };
    fields.push(field);
    claim(name, field);
    for (const alias of field.aliases) claim(alias, field);
  }

  if (definition.text !== undefined) {
    for (const name of definition.text) {
      if (!lookup.has(name.toLowerCase())) throw new JqlError(`the text field "${name}" is not a field of this vocabulary, so a bare word would never search it`, "vocabulary.text");
    }
  }

  return {
    lookup,
    fields,
    names: [...lookup.keys()].sort(),
    text: definition.text,
    strict: definition.strict ?? false,
  };
}
