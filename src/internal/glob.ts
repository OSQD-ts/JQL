/**
 * Glob matching: `*`, `?`, and `\` to escape either of them.
 *
 * What people mean when they reach for a pattern in a search box — `/api/*`,
 * `*.example.com` — and the reason it is not `$regex` with the sharp edges filed off: this
 * runs without a regular-expression engine, so it is available when patterns are turned
 * off for untrusted callers, and it cannot backtrack exponentially.
 *
 * No character classes. `[a-z]` is a literal `[a-z]`, because half a class syntax is worse
 * than none: somebody would write `[!abc]` expecting negation and get a match against those
 * four characters instead, with nothing to say so.
 *
 * **A pattern is taken apart once and becomes the narrowest matcher that fits it.** Nearly
 * every real glob is a prefix, a suffix, something in the middle, or a run of literals
 * separated by stars, and each of those is one or two native string calls per value. Only a
 * pattern with `?` in it walks character by character, and only that walk pays for splitting
 * the text into characters — which, measured against `startsWith`, was four times the cost of
 * the whole comparison.
 */

export type GlobMatcher = (text: string) => boolean;

/**
 * What `*` and `?` become once the pattern is taken apart.
 *
 * Objects rather than strings, because a string sentinel is a string a *pattern* can also
 * contain: with a NUL-prefixed marker standing for `*`, the glob `a*\u0000\*` re-formed the
 * marker when the tokens were joined back together and was split in the wrong place — a
 * glob that silently matched everything.
 */
const ANY = { any: true } as const;
const ONE = { one: true } as const;

type Token = string | typeof ANY | typeof ONE;

export function compileGlob(pattern: string): GlobMatcher {
  const tokens = tokenize(pattern);
  const stars = tokens.includes(ANY);
  const questions = tokens.includes(ONE);

  if (!stars && !questions) {
    const literal = tokens.join("");
    return (text) => text === literal;
  }
  if (!questions) {
    // Literal runs separated by stars: each run is found with `indexOf`, left to right.
    const segments: string[] = [""];
    for (const token of tokens) {
      if (token === ANY) segments.push("");
      else segments[segments.length - 1] += token as string;
    }
    const open = segments[0] === "";
    const close = segments[segments.length - 1] === "";
    const parts = segments.filter((segment) => segment !== "");
    if (parts.length === 0) return () => true;
    if (open && close && parts.length === 1) {
      const inside = parts[0] as string;
      return (text) => text.includes(inside);
    }
    if (!open && close && parts.length === 1) {
      const prefix = parts[0] as string;
      return (text) => text.startsWith(prefix);
    }
    if (open && !close && parts.length === 1) {
      const suffix = parts[0] as string;
      return (text) => text.endsWith(suffix);
    }
    return (text) => scan(text, parts, open, close);
  }
  return (text) => walk([...text], tokens);
}

/**
 * The same glob as the body of a regular expression, for a target that speaks patterns
 * rather than running the matcher — a store this query is being pushed down to.
 *
 * It shares the tokenizer with the matcher on purpose: an escape read one way here and
 * another way there would mean a query that found different things depending on which half
 * of the system answered it.
 */
export function compileGlobPattern(pattern: string, quoteLiteral: (text: string) => string): string {
  return tokenize(pattern)
    .map((token) => (token === ANY ? "[\\s\\S]*" : token === ONE ? "[\\s\\S]" : quoteLiteral(token as string)))
    .join("");
}

/** Takes the pattern apart: literal characters, `ANY` for `*`, `ONE` for `?`. */
function tokenize(pattern: string): Token[] {
  const tokens: Token[] = [];
  let escaped = false;
  for (const character of pattern) {
    if (escaped) {
      tokens.push(character);
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "*") {
      // A run of stars means what one means, and collapsing it here keeps the matcher's
      // backtracking to one mark per run.
      if (tokens[tokens.length - 1] !== ANY) tokens.push(ANY);
      continue;
    }
    tokens.push(character === "?" ? ONE : character);
  }
  // A trailing backslash is somebody mid-word, not an error: it stands for itself.
  if (escaped) tokens.push("\\");
  return tokens;
}

/** Literal runs in order, anchored at each end unless a star opens or closes the pattern. */
function scan(text: string, parts: readonly string[], open: boolean, close: boolean): boolean {
  let at = 0;
  const last = parts.length - 1;
  for (let i = 0; i <= last; i++) {
    const part = parts[i] as string;
    if (i === 0 && !open) {
      if (!text.startsWith(part)) return false;
      at = part.length;
      continue;
    }
    if (i === last && !close) {
      // The final run has to be at the very end, and must not overlap what is matched.
      return text.length - part.length >= at && text.endsWith(part);
    }
    const found = text.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return true;
}

/** The two-pointer walk, for patterns holding `?`. Quadratic at worst, linear on anything typed. */
function walk(characters: readonly string[], tokens: readonly Token[]): boolean {
  let at = 0;
  let token = 0;
  let star = -1;
  let mark = 0;
  while (at < characters.length) {
    const current = tokens[token];
    if (current !== undefined && (current === ONE || current === characters[at])) {
      at++;
      token++;
      continue;
    }
    if (current === ANY) {
      star = token++;
      mark = at;
      continue;
    }
    if (star !== -1) {
      token = star + 1;
      at = ++mark;
      continue;
    }
    return false;
  }
  while (tokens[token] === ANY) token++;
  return token === tokens.length;
}
