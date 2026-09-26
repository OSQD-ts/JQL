import { describe, expect, it } from "vitest";
import * as cli from "../src/cli.js";
import * as global from "../src/global.js";
import * as root from "../src/index.js";
import * as mongo from "../src/targets/mongo.js";
import * as text from "../src/text/index.js";

/**
 * What each entry point exports.
 *
 * Adapted from bothandlerjs. Two lists, because they answer different questions.
 * `PROMISED` is what the documentation tells people to import: a name in it is a promise,
 * and removing one is a breaking change — this is where that gets said out loud rather than
 * discovered by somebody's failing build. `SURFACE` is every runtime export, listed so that
 * adding or removing any of them is a line in a diff.
 */

const PROMISED: Record<string, readonly string[]> = {
  "@osqd/jql": [
    "compile",
    "matches",
    "validate",
    "find",
    "filter",
    "count",
    "search",
    "group",
    "explain",
    "canonical",
    "fingerprint",
    "findAsync",
    "filterAsync",
    "filterStream",
    "searchAsync",
    "defineVocabulary",
    "JqlError",
    "UNTRUSTED_LIMITS",
  ],
  "@osqd/jql/text": ["parseText", "suggest", "toText"],
  "@osqd/jql/global": ["install", "uninstall"],
  "@osqd/jql/mongo": ["MONGO_CAPABILITIES", "toMongoFilter"],
  "@osqd/jql/cli": ["main", "run"],
};

const SURFACE: Record<string, readonly string[]> = {
  "@osqd/jql": [
    "DEFAULT_LIMITS",
    "FIELD_OPERATORS",
    "JqlError",
    "QUERY_OPERATORS",
    "UNTRUSTED_LIMITS",
    "canonical",
    "compile",
    "count",
    "countAsync",
    "defineVocabulary",
    "every",
    "everyAsync",
    "explain",
    "filter",
    "filterAsync",
    "filterStream",
    "filterMap",
    "filterRecord",
    "find",
    "findAsync",
    "findEntry",
    "findIndex",
    "fingerprint",
    "group",
    "matches",
    "partition",
    "plan",
    "search",
    "searchAsync",
    "some",
    "someAsync",
    "untyped",
    "validate",
  ],
  "@osqd/jql/text": ["MAX_TEXT_CHARS", "MAX_TEXT_DEPTH", "TEXT_OPERATORS", "parseText", "suggest", "toText"],
  "@osqd/jql/global": ["install", "uninstall"],
  "@osqd/jql/mongo": ["MONGO_CAPABILITIES", "toMongoFilter"],
  "@osqd/jql/cli": ["main", "run"],
};

const MODULES: Record<string, object> = { "@osqd/jql": root, "@osqd/jql/text": text, "@osqd/jql/global": global, "@osqd/jql/mongo": mongo, "@osqd/jql/cli": cli };

describe("entry points", () => {
  for (const [entry, names] of Object.entries(PROMISED)) {
    it(`${entry} keeps every name it promised`, () => {
      const exported = Object.keys(MODULES[entry] as object);
      for (const name of names) expect(exported, name).toContain(name);
    });
  }

  for (const [entry, names] of Object.entries(SURFACE)) {
    it(`${entry} exports exactly its listed surface`, () => {
      expect(Object.keys(MODULES[entry] as object).sort()).toEqual([...names].sort());
    });
  }

  it("patches nothing from the main entry", async () => {
    const { uninstall } = global;
    uninstall();
    await import("../src/index.js");
    expect(Object.hasOwn(Array.prototype, "jqlSearch")).toBe(false);
    global.install();
  });
});
