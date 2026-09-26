import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, deliberately not part of the published build.
import { bumpVersion, classify, declaredRelease, isForwards, RANK } from "../scripts/next-version.mjs";

/**
 * The rules that decide what the world gets.
 *
 * Every push to `main` runs `scripts/next-version.mjs` and publishes whatever it says, so a
 * mistake here is not a broken build — it is a wrong version on a registry that cannot take
 * it back.
 *
 * The expensive direction is at the top of the scale. A feature going out as a patch is a
 * number that undersells itself and costs nobody anything; a *breaking change* going out as
 * one breaks whoever is on a caret range, with no warning and no way to withdraw it. That
 * is why `feat` is deliberately a patch here and `!` is deliberately not.
 */
describe("what a commit does to the version", () => {
  /**
   * A feature is a patch, which is not what Conventional Commits says and is deliberate.
   *
   * This repository publishes on every push. Under the usual rule a fortnight of ordinary
   * work is a fortnight of minor bumps, and the version ends up measuring how often
   * somebody pushed rather than anything about the engine. The smallest bump that still
   * publishes is the default; a minor is claimed out loud on the commit that earns it.
   */
  it("reads the conventional types, with a feature landing on the patch", () => {
    expect(classify("feat: add $glob")).toBe("patch");
    expect(classify("feat(text): complete a field's values")).toBe("patch");
    expect(classify("fix: stop widening a query in toText")).toBe("patch");
    expect(classify("fix(core): order an $and by cost")).toBe("patch");
    expect(classify("perf: compile $in of 100 ids into a Set")).toBe("patch");
  });

  it("still lets a minor be asked for outright", () => {
    // The escape hatch that makes the low default safe: nothing about a real minor became
    // impossible, it just has to be said rather than inferred.
    expect(declaredRelease("feat: the shape of the request envelope changed\n\nRelease-As: minor")).toEqual({ kind: "bump", value: "minor" });
    expect(bumpVersion("0.11.0", "minor")).toBe("0.12.0");
  });

  it("releases nothing for work that changes nothing for a consumer", () => {
    for (const message of ["docs: rewrite the course", "ci: publish from main", "test: cover the split", "chore: tidy", "build: add a ratchet", "refactor: rename a local", "style: reformat"]) {
      expect(classify(message), message).toBe("none");
    }
  });

  it("takes a bang as breaking, wherever the type is", () => {
    expect(classify("feat!: rename every export")).toBe("major");
    expect(classify("fix!: refuse a query that used to be accepted")).toBe("major");
    expect(classify("refactor(core)!: drop an option")).toBe("major");
  });

  it("takes the footer form as breaking too", () => {
    // The `!` does not always fit in a subject line, and the footer is the form the
    // Conventional Commits specification requires tooling to honour.
    expect(classify("fix: tighten $type\n\nBREAKING CHANGE: $type: \"integer\" no longer matches 1.0")).toBe("major");
    expect(classify("fix: tighten it\n\nBREAKING-CHANGE: with a hyphen, as the spec also allows")).toBe("major");
  });

  it("does not read a breaking footer out of a subject line", () => {
    // A commit that *describes* the mechanism is the obvious way to bump the major by
    // accident, and the one this project would write while documenting it.
    expect(classify("docs: explain that BREAKING CHANGE: bumps the major")).toBe("none");
  });

  it("ignores a message that is not conventional at all", () => {
    expect(classify("Init")).toBe("none");
    expect(classify("wip")).toBe("none");
    expect(classify("Merge branch 'main'")).toBe("none");
  });

  it("ranks the bumps so the largest in a range wins", () => {
    expect(RANK.none).toBeLessThan(RANK.patch);
    expect(RANK.patch).toBeLessThan(RANK.minor);
    expect(RANK.minor).toBeLessThan(RANK.major);
  });
});

describe("what a commit may declare outright", () => {
  it("reads an exact version and a named bump", () => {
    expect(declaredRelease("feat: freeze the API\n\nRelease-As: 1.0.0")).toEqual({ kind: "version", value: "1.0.0" });
    expect(declaredRelease("fix: something\n\nRelease-As: patch")).toEqual({ kind: "bump", value: "patch" });
    expect(declaredRelease("fix: something\n\nRelease-As: MAJOR")).toEqual({ kind: "bump", value: "major" });
    expect(declaredRelease("fix: something\n\nRelease As: minor")).toEqual({ kind: "bump", value: "minor" });
  });

  it("says nothing when the commit says nothing", () => {
    expect(declaredRelease("feat: add $glob")).toBeUndefined();
    expect(declaredRelease("feat: add $glob\n\nA body with no footer.")).toBeUndefined();
  });

  /**
   * The subject line is not a footer.
   *
   * `docs: explain Release-As: 1.0.0` is a commit this repository would plausibly write
   * while documenting the mechanism, and reading it as an instruction would publish 1.0.0
   * off the back of a documentation change.
   */
  it("does not take an instruction from a subject line", () => {
    expect(declaredRelease("docs: explain Release-As: 1.0.0")).toBeUndefined();
  });

  /**
   * A typo is reported, never skipped.
   *
   * Returning `undefined` for an unreadable footer would fall back to the derived version:
   * the release goes out, the tag looks plausible, and the version somebody actually asked
   * for never happens. The caller refuses instead.
   */
  it("reports a footer it cannot read rather than ignoring it", () => {
    expect(declaredRelease("fix: x\n\nRelease-As: 1.0")).toEqual({ kind: "invalid", value: "1.0" });
    expect(declaredRelease("fix: x\n\nRelease-As: next")).toEqual({ kind: "invalid", value: "next" });
    expect(declaredRelease("fix: x\n\nRelease-As: v1.0.0")).toEqual({ kind: "invalid", value: "v1.0.0" });
  });
});

describe("applying a bump", () => {
  it("moves the part it names and clears the parts below it", () => {
    expect(bumpVersion("1.4.2", "patch")).toBe("1.4.3");
    expect(bumpVersion("1.4.2", "minor")).toBe("1.5.0");
    expect(bumpVersion("1.4.2", "major")).toBe("2.0.0");
    expect(bumpVersion("1.4.2", "none")).toBe("1.4.2");
  });

  /**
   * 0.x is what SemVer provides for a library that is still moving. Letting a `!` take it
   * to 1.0.0 would have a commit subject decide that the engine is stable, which is a claim
   * only a person can make.
   */
  it("keeps a breaking change inside 0.x", () => {
    expect(bumpVersion("0.1.0", "major")).toBe("0.2.0");
    expect(bumpVersion("0.11.3", "major")).toBe("0.12.0");
    // And says so deliberately when asked.
    expect(bumpVersion("1.0.0", "major")).toBe("2.0.0");
  });

  it("drops a prerelease suffix before bumping", () => {
    expect(bumpVersion("1.0.0-rc.1", "patch")).toBe("1.0.1");
  });
});

describe("whether a version moves forwards", () => {
  it("accepts a later version and refuses one that is not", () => {
    expect(isForwards("0.1.0", "0.1.1")).toBe(true);
    expect(isForwards("0.1.0", "0.2.0")).toBe(true);
    expect(isForwards("0.9.9", "1.0.0")).toBe(true);
    expect(isForwards("0.1.0", "0.1.0")).toBe(false);
    expect(isForwards("0.2.0", "0.1.9")).toBe(false);
  });

  it("sorts a prerelease below its own release", () => {
    expect(isForwards("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(isForwards("1.0.0", "1.0.0-rc.2")).toBe(false);
  });

  it("refuses anything it cannot read as a version", () => {
    expect(isForwards("0.1.0", "next")).toBe(false);
    expect(isForwards("not-a-version", "1.0.0")).toBe(false);
  });
});
