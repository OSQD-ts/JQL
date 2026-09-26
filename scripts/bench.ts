/**
 * The exploratory performance report: every case, JQL beside the hand-written loop.
 *
 * No pass or fail — `bench:guard` is the ratchet. This is for reading, and for seeing what
 * a change did before deciding whether it was worth it.
 *
 *   npm run bench            100 000 people
 *   npm run bench -- 10000   another size
 */
import { cases, people, time } from "./workload.js";

const size = Number(process.argv[2] ?? 100_000);
if (!Number.isInteger(size) || size <= 0) {
  process.stderr.write(`bench: the size is a positive whole number, not ${JSON.stringify(process.argv[2])}\n`);
  process.exit(2);
}
const data = people(size);

process.stderr.write(`${size.toLocaleString("en")} documents, median of 7 calibrated rounds\n\n`);
const rows = cases(data).map((item) => {
  const reference = time(item.reference);
  const jql = time(item.jql);
  return { case: item.name, "hand-written (ms)": reference.toFixed(3), "jql (ms)": jql.toFixed(3), ratio: `${(jql / reference).toFixed(2)}×` };
});
console.table(rows);
