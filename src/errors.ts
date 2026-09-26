/**
 * The one way a query is refused.
 *
 * A query that looks right and matches nothing is the failure this library exists to
 * prevent: a misspelt operator, a field value that is `undefined` because a variable was,
 * a regex that does not compile. Each of those used to be a filter that silently let
 * everything through or nothing through, and nobody could tell which from the result. So
 * `compile` refuses, with a sentence saying what was wrong and where in the query it was.
 */
export class JqlError extends Error {
  /**
   * Where in the query the problem is, written the way you would reach it in code:
   * `$or[1].age.$gt`. Empty for the query as a whole.
   */
  readonly at: string;

  constructor(message: string, at = "") {
    super(at === "" ? message : `at ${show(at)}: ${message}`);
    this.name = "JqlError";
    this.at = at;
  }
}

/**
 * The location, short enough to read.
 *
 * A location is built from the query's own field names, and a field name is a string from
 * outside — a long one makes the sentence it prefixes unreadable, and turns a log line into
 * a paragraph. `at` itself keeps the whole path, because that is the part a program reads.
 */
function show(at: string): string {
  return at.length > 80 ? `${at.slice(0, 80)}…` : at;
}
