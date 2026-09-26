#!/usr/bin/env node
// The next version, derived from the commits since the last release.
//
//   node scripts/next-version.mjs            → prints the version, or nothing
//   node scripts/next-version.mjs --explain  → prints the reasoning to stderr as well
//
// ## Why derive it rather than declare it
//
// A version bumped by hand is a number somebody chose while thinking about something else.
// It drifts: a release goes out as a patch because the last one was, and the breaking
// change inside it is discovered by whoever upgrades. The commits already say what
// happened — this repository writes `feat:`, `fix:` and `docs:` — so the version is a fact
// to be read rather than a decision to be remembered.
//
// ## The rules, in full
//
//   feat: / fix: / perf:   → patch
//   anything with a `!`    → major, or minor while the major is 0
//   BREAKING CHANGE: body  → the same
//   docs/ci/test/chore/…   → nothing at all
//
// That last line is what makes this safe to run on every push. A push that only touches
// documentation publishes nothing, so the registry does not fill up with versions whose
// only difference is a typo in a comment.
//
// ## This is the package's version, not the language's
//
// `docs/reference/specification.md` carries a version of its own — the JSON Query Language
// is at 1.1 — and the two are deliberately unrelated. The language's version says what a
// query means, moves only when the specification, the conformance suite and the changelog
// move together, and is set by hand in those files because it is a claim about a standard.
// This number says which build of the engine you installed. A release that changes what a
// query matches has to do both, and the `!` below is how it says so here.
//
// ## Why a feature is a patch
//
// Conventional Commits reads `feat` as a minor, and for a repository that releases on a
// person's say-so that is right. This one releases on *every push*, which makes the same
// rule mean something different: a fortnight of ordinary work is a fortnight of `feat`
// commits, each landing on the minor the moment it merges. The number then measures how
// often somebody pushed rather than anything about the library, and it climbs fast enough
// that a real minor — the release where the shape of the thing changed — has nothing left
// to say.
//
// So the default is the smallest bump that still publishes, and a larger one is said out
// loud. `Release-As: minor` on the commit that earns it is one line, it sits in the history
// next to the work it describes, and it makes the minor a claim somebody made rather than a
// side effect of the calendar.
//
// A `!` or a `BREAKING CHANGE:` footer is untouched by this and still bumps the major,
// because neither is a default: you have to type it, and typing it is exactly the
// deliberate act the paragraph above asks for. Shipping a breaking change as a patch is the
// one outcome worth more than a tidy version number.
//
// While the major version is 0 a breaking change bumps the minor, which is what SemVer says
// 0.x is for: anything may change, and the way to say "this is now stable" is to release
// 1.0.0 deliberately rather than to have a stray `!` do it for you.
//
// ## Saying it outright
//
// The rules above cover what the commits imply. Some releases are not implied by anything —
// 1.0.0 is a decision about stability rather than a consequence of a `feat`, a security
// patch may want its own number, and a docs-only push sometimes has to ship because the
// last release went out with the wrong README. For those, a commit may say so in a footer:
//
//   Release-As: 1.0.0     → exactly that version
//   Release-As: minor     → force that bump, whatever the commits imply
//
// It is a footer rather than a workflow input because the decision belongs in the history:
// six months later, "why is there no 0.9?" is answered by `git log` rather than by
// somebody's memory of a button they pressed. Any commit in the range may carry one and the
// newest wins, so changing your mind means one more commit rather than a force push.
//
// An override is checked rather than trusted. A version that is not semver, or that does
// not move forwards, stops the release with a non-zero exit instead of quietly falling back
// to the derived number — because the failure being guarded against is somebody mistyping
// the release they meant to cut and not finding out.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const explain = process.argv.includes("--explain");
const say = (message) => {
  if (explain) process.stderr.write(`${message}\n`);
};

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * The commit the last release was cut at.
 *
 * The tag rather than the version in package.json, because the tag is what the previous run
 * of this actually published; package.json can be edited by anyone at any time and says
 * nothing about what reached the registry.
 */
function lastReleaseTag() {
  const tags = git("tag", "--list", "v*", "--sort=-v:refname").split("\n").filter(Boolean);
  return tags[0];
}

/** `type(scope)!: subject` → the parts that decide a version. */
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s/;

/**
 * `Release-As:` in a footer, in either spelling the conventional-commits footers use.
 *
 * Anchored to the start of a line so that *describing* the mechanism — in this comment, in
 * CONTRIBUTING, in a commit that explains it — does not accidentally invoke it. The same
 * care the `BREAKING CHANGE:` match takes, and for a sharper reason: a missed override
 * publishes the version the commits implied, which is merely not what was asked for, while
 * a spurious one publishes a number nobody chose.
 */
const RELEASE_AS = /^Release[ -]As:\s*(?<value>.+?)\s*$/im;

/** A version this script is willing to publish: semver, with an optional prerelease. */
const SEMVER = /^(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)(?<pre>-[0-9A-Za-z.-]+)?$/;

/**
 * What one commit declares outright, if anything.
 *
 * `{ kind: "version", value }` for an exact version, `{ kind: "bump", value }` for a named
 * bump, and `undefined` when the commit says nothing. A footer that says something
 * unreadable returns `{ kind: "invalid", value }` rather than nothing, so the caller can
 * refuse the release instead of silently ignoring a typo.
 */
export function declaredRelease(message) {
  // The subject line is dropped before looking, because a subject is not a footer:
  // `docs: explain Release-As: 1.0.0` describes the mechanism and must not invoke it.
  const body = message.split("\n").slice(1).join("\n");
  const match = RELEASE_AS.exec(body);
  if (match === null) return undefined;
  const value = match.groups.value;
  const named = value.toLowerCase();
  if (named === "major" || named === "minor" || named === "patch") return { kind: "bump", value: named };
  if (SEMVER.test(value)) return { kind: "version", value };
  return { kind: "invalid", value };
}

/** Numeric ordering on the release triple. A prerelease sorts below its own release. */
export function isForwards(from, to) {
  const parse = (version) => {
    const match = SEMVER.exec(version);
    if (match === null) return undefined;
    return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch), match.groups.pre === undefined ? 1 : 0];
  };
  const a = parse(from.split("+")[0]);
  const b = parse(to.split("+")[0]);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 4; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}

/**
 * What one commit does to the version.
 *
 * Exported, and tested in `tests/next-version.test.ts`, because this is the function that
 * decides what the world gets. The asymmetry that matters is at the top of the scale rather
 * than the middle: an ordinary feature going out as a patch is a number that undersells
 * itself, while a breaking change going out as one is an upgrade that breaks somebody on a
 * caret range with no warning at all. So `feat` is deliberately a patch here and `!` is
 * deliberately not.
 */
export function classify(message) {
  const [header, ...rest] = message.split("\n");
  const body = rest.join("\n");
  // The footer form is the one the specification requires tooling to honour, and the one
  // people reach for when the `!` would not fit in the subject line.
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return "major";
  const match = HEADER.exec(header ?? "");
  if (match === null) return "none";
  if (match.groups.breaking === "!") return "major";
  // `feat` lands on the patch, not the minor. See the note on the default bump above.
  if (match.groups.type === "feat" || match.groups.type === "fix" || match.groups.type === "perf") return "patch";
  return "none";
}

export const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/**
 * Applies a bump to a version.
 *
 * While the major is 0 a breaking change lands on the minor, which is what SemVer says 0.x
 * is for. Reaching 1.0.0 should be somebody deciding the engine is stable, not a stray `!`
 * in a commit subject doing it on their behalf.
 */
export function bumpVersion(current, bump) {
  const [major, minor, patch] = current.split("-")[0].split(".").map(Number);
  const effective = bump === "major" && major === 0 ? "minor" : bump;
  if (effective === "major") return `${major + 1}.0.0`;
  if (effective === "minor") return `${major}.${minor + 1}.0`;
  if (effective === "patch") return `${major}.${minor}.${patch + 1}`;
  return current;
}

function main() {
  const since = lastReleaseTag();
  const range = since === undefined ? "HEAD" : `${since}..HEAD`;
  say(since === undefined ? "no v* tag yet — reading every commit" : `commits since ${since}`);

  // \x00 between commits, because a commit body may contain anything a person can type,
  // newlines and dashes included. Splitting on a text marker is how a release script reads
  // half a commit and decides it was a chore.
  const raw = git("log", range, "--format=%B%x00");
  const commits = raw.split("\0").map((commit) => commit.trim()).filter(Boolean);

  let bump = "none";
  // `git log` gives newest first, so the first override seen is the newest one. Later ones
  // are reported and not used: a second thought is expressed by another commit, and seeing
  // both in the explain output is how somebody works out which one won.
  let declared;
  for (const commit of commits) {
    const kind = classify(commit);
    if (RANK[kind] > RANK[bump]) bump = kind;
    const said = declaredRelease(commit);
    const mark = said === undefined ? "" : `  [Release-As: ${said.value}${declared === undefined ? "" : ", superseded"}]`;
    if (said !== undefined && declared === undefined) declared = said;
    say(`  ${kind.padEnd(5)}  ${commit.split("\n")[0].slice(0, 72)}${mark}`);
  }

  const current = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

  if (declared !== undefined) {
    // Refused rather than ignored. Falling back to the derived number here would publish
    // *something*, which is the outcome that hides the mistake: the release goes out, the
    // tag looks plausible, and the version somebody asked for never happens.
    if (declared.kind === "invalid") {
      throw new Error(`Release-As: ${declared.value} is neither a version nor a bump. Write a semver version like 1.0.0, or one of major, minor, patch.`);
    }
    const next = declared.kind === "version" ? declared.value : bumpVersion(current, declared.value);
    if (!isForwards(current, next)) {
      throw new Error(`Release-As: ${declared.value} asks for ${next}, which is not ahead of ${current}. A published version cannot be replaced, so a release has to move forwards.`);
    }
    say(`${current} → ${next}  (declared: Release-As: ${declared.value}${bump === "none" ? ", and nothing here would have released otherwise" : `, over the derived ${bumpVersion(current, bump)}`})`);
    return next;
  }

  if (bump === "none") {
    say(commits.length === 0 ? "nothing new since the last release" : "nothing here changes what the library does");
    return undefined;
  }

  const next = bumpVersion(current, bump);
  say(`${current} → ${next}  (${bump})`);
  return next;
}

/** Run only when invoked, so a test can import the rules without shelling out to git. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  // A refused override writes nothing to stdout and exits non-zero, which is what stops the
  // release: the workflow assigns this script's output to a variable, so a failure here
  // fails that step rather than being read as "nothing to publish".
  try {
    const next = main();
    if (next !== undefined) process.stdout.write(`${next}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
