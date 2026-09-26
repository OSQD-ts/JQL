/**
 * How much of a query the engine will take.
 *
 * Queries arrive from places the caller does not control — a URL, a request body, a
 * saved filter somebody else wrote — and every limit here is a way such a query could
 * otherwise cost more than the data it filters. Each one refuses with a `JqlError` rather
 * than truncating, because a query that was quietly cut short answers a different
 * question from the one that was asked.
 *
 * The defaults are far past anything a person writes and far short of anything that
 * hurts. The caps are exported so a caller can say what it accepts in its own
 * documentation and refuse a query before it is even parsed.
 */
export interface Limits {
  /** How deep operators may nest. Default 32: recursion over pasted input must stop well short of the stack. */
  readonly maxDepth: number;
  /** How many operators and fields a query may hold in total. Default 10 000. `$in` lists do not count: they cost one set lookup each. */
  readonly maxNodes: number;
  /** The longest `$regex` pattern. Default 1024. */
  readonly maxPatternLength: number;
  /**
   * The longest `$glob`. Default 1024, and 256 for untrusted input.
   *
   * A glob cannot backtrack exponentially, but matching one holding `?` is the length of the
   * pattern times the length of the value — so a megabyte of `?` against a megabyte of text
   * is hours per document. It has a cap of its own because `$regex` is turned *off* for
   * untrusted callers while `$glob` stays on, which is exactly when the cap has to hold.
   */
  readonly maxGlobLength: number;
  /** How deep `$text` looks into a document. Default 16: past that a document is a graph, not a record. */
  readonly maxTextDepth: number;
  /**
   * Which operators a query may use. Default `"all"`.
   *
   * An allowlist, because a public endpoint's answer to "what may a caller ask?" should be
   * a list it wrote rather than everything the language grows later. `$text` walks a whole
   * document and `$elemMatch` carries a query of its own; an endpoint that needs neither can
   * say so once, here, instead of discovering later which of them somebody found.
   *
   * Names are checked when the query compiles: an operator outside the list is refused by
   * name, never ignored. `$options` and `$comment` are exempt — they modify and annotate
   * rather than ask anything — and `$field` counts as an operator, because comparing two
   * fields is a capability in its own right.
   */
  readonly allowOperators: readonly string[] | "all";
  /**
   * Whether `$regex` is accepted at all. Default `true`.
   *
   * Turn it off for queries from untrusted callers. No engine can tell a pattern that
   * backtracks for a minute from one that does not without running it, and the string
   * operators (`$contains`, `$startsWith`, `$endsWith`, `$word`) answer almost every
   * question a pattern would, in linear time.
   */
  readonly allowRegex: boolean;
}

/** The defaults, frozen, so they can be spread and never edited in place. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxDepth: 32,
  maxNodes: 10_000,
  maxPatternLength: 1024,
  maxGlobLength: 1024,
  maxTextDepth: 16,
  allowRegex: true,
  allowOperators: "all",
});

/**
 * What an untrusted query gets: no patterns, and a tighter size.
 *
 * Public so a service taking queries from a URL can use the same answer as every other
 * service in the project, rather than each one picking its own numbers.
 */
export const UNTRUSTED_LIMITS: Readonly<Limits> = Object.freeze({
  maxDepth: 16,
  maxNodes: 512,
  maxPatternLength: 0,
  maxGlobLength: 256,
  maxTextDepth: 8,
  allowRegex: false,
  // Still every operator but `$regex`: which of the rest an endpoint wants is a decision
  // only that endpoint can make, and a list guessed here would be one nobody had chosen.
  allowOperators: "all",
});
