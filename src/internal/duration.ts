/**
 * Durations, for the relative dates a saved filter is written with.
 *
 * `"1h"`, `"30m"`, `"1h30m"`, `"7d"`. Written as one or more counts with a unit, largest
 * first by convention but in any order, because a filter is typed by a person and
 * `"30m1h"` means what it says.
 *
 * Months and years are deliberately absent: neither has a fixed length, so `"1mo"` would
 * mean something slightly different in February, and a filter whose window changes size
 * with the calendar is one nobody can reason about. Use days or weeks.
 */

const PART = /(\d+)(ms|s|m|h|d|w)/g;
const SHAPE = /^(?:\d+(?:ms|s|m|h|d|w))+$/;

const UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** The unit names, for an error that says what is accepted. */
export const DURATION_UNITS = Object.keys(UNITS);

/** A duration in milliseconds, or `undefined` when the text is not one. */
export function parseDuration(text: string): number | undefined {
  if (!SHAPE.test(text)) return undefined;
  let total = 0;
  PART.lastIndex = 0;
  for (;;) {
    const part = PART.exec(text);
    if (part === null) break;
    const count = Number(part[1]);
    // A count that does not survive the round trip through a number is not a duration
    // anybody meant; it is a digit string long enough to have lost its tail.
    if (!Number.isSafeInteger(count)) return undefined;
    total += count * (UNITS[part[2] as string] as number);
  }
  return Number.isSafeInteger(total) ? total : undefined;
}
