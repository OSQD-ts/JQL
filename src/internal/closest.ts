/**
 * "Did you mean" for names that almost exist.
 *
 * An unknown operator is refused either way; naming the one that was probably meant turns
 * a lookup in the documentation into a one-character fix.
 */
export function closest(word: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  // Two edits is the line between a typo and a different word: `$gtt` → `$gt` is one,
  // `$foo` → `$not` is two and is still more likely a slip than a new idea.
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(word.toLowerCase(), candidate.toLowerCase(), bestDistance);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Levenshtein distance, giving up once it is certain to exceed `ceiling`. */
function editDistance(a: string, b: string, ceiling: number): number {
  if (Math.abs(a.length - b.length) >= ceiling) return ceiling;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost);
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    if (rowBest >= ceiling) return ceiling;
    previous = current;
  }
  return previous[b.length] as number;
}

/** The suffix of an error sentence that offers the likely name, or nothing. */
export function didYouMean(word: string, candidates: Iterable<string>): string {
  const guess = closest(word, candidates);
  return guess === undefined ? "" : `; did you mean "${guess}"?`;
}
