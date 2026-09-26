/**
 * The performance ratchet: fails when a case got materially slower.
 *
 * Every budget is a ratio against the hand-written loop for the same answer, measured in
 * the same process seconds apart — never a number of milliseconds, which is a statement
 * about the machine that produced it. A CI runner half as fast as a laptop runs both halves
 * at half speed, so the ratio stays put and moves only when the engine does.
 *
 * Budgets sit at roughly twice the top of the measured range. That is not generosity: a
 * budget tight enough to fire on noise gets raised until it stops firing, and then it is
 * not a guard at all. The measured ranges, from `npm run bench` on 100 000 documents:
 *
 *   find by id          1.02–1.11×      array membership   1.13–1.26×
 *   range and flag      1.21–1.47×      $contains, i       1.03–1.18×
 *   nested path         1.04–1.21×      $or                1.07–1.27×
 *   $in of 100 ids      0.93–1.03×      $text              2.29–2.61×
 *   $glob               0.78–0.91×      $length of a string 1.79–2.36×
 *   one field vs another 2.15–2.86×     top 10, sorted     0.39–0.81×
 *
 * The compile-per-call case is left out: its reference is a loop over ten items, so its
 * ratio measures the cost of compiling, which `bench` reports and nothing here should
 * pretend is comparable.
 */
import { cases, people, time } from "./workload.js";

const BUDGETS: Record<string, number> = {
  "find by id (the common case, walks everything)": 2.5,
  "range and flag": 3,
  "nested path": 2.5,
  "$in of 100 ids": 2.2,
  "array membership": 2.5,
  "$contains ignoring case": 2.5,
  $or: 2.6,
  "$text over the whole document": 5,
  $glob: 2,
  // A reference reads twice and compares values neither side knew at compile time, so it
  // will not reach parity with a hand-written `a.x > a.y`; the budget says how far is fair.
  "one field against another": 5,
  "$length of a string": 4,
  // The heap exists to beat sorting everything; at parity it has stopped earning its code.
  "top 10 by age, sorted (bounded heap)": 1,
};

const data = people(50_000);
let failed = 0;
for (const item of cases(data)) {
  const budget = BUDGETS[item.name];
  if (budget === undefined) continue;
  const ratio = time(item.jql, 25) / time(item.reference, 25);
  const verdict = ratio <= budget ? "ok  " : "SLOW";
  if (ratio > budget) failed++;
  process.stdout.write(`${verdict} ${ratio.toFixed(2).padStart(5)}× (budget ${budget}×)  ${item.name}\n`);
}

for (const name of Object.keys(BUDGETS)) {
  if (!cases(data.slice(0, 1)).some((item) => item.name === name)) {
    process.stderr.write(`bench:guard: the budget "${name}" names no case, so it guards nothing\n`);
    failed++;
  }
}

if (failed > 0) {
  process.stderr.write(
    "\nbench:guard: either something on the query path got materially slower, or the budget is genuinely wrong for a change that was worth making — in which case raise it and say why in the commit.\n",
  );
  process.exit(1);
}
