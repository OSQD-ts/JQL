import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, JqlError, search } from "../src/index.js";

/**
 * The conformance suite, run against this implementation.
 *
 * `conformance/cases.json` is the language's definition in executable form: plain JSON
 * documents, plain JSON queries, and the positions that must match. It is written for any
 * implementation — a Go service or a Python notebook reading the same saved filters has to
 * give the same answers — so it contains nothing that only JavaScript can express. This
 * file is the TypeScript engine taking the same test everybody else would.
 */

interface Case {
  group: string;
  name: string;
  documents?: string;
  query: unknown;
  matches?: number[];
  error?: boolean;
  at?: string;
  /** The instant the case is evaluated at, for a query holding a relative date. */
  now?: string;
}

/** A whole request — which items, in which order, which page, which fields. */
interface RequestCase {
  group: string;
  name: string;
  documents: string;
  request: unknown;
  /** The positions of the items returned, in the order they come back. */
  matches?: number[];
  /** For a request with `fields`, the objects themselves, since they are not the items. */
  projection?: unknown[];
  error?: boolean;
  at?: string;
}

const suite = JSON.parse(readFileSync(new URL("../conformance/cases.json", import.meta.url), "utf8")) as {
  documents: Record<string, unknown[]>;
  cases: Case[];
  requests: RequestCase[];
};

const groups = [...new Set(suite.cases.map((item) => item.group))];

for (const group of groups) {
  describe(`conformance: ${group}`, () => {
    for (const item of suite.cases.filter((entry) => entry.group === group)) {
      it(item.name, () => {
        // An implementation must let the caller say what "now" is, or a relative date could
        // not be tested at all.
        const options = item.now === undefined ? undefined : { now: () => Date.parse(item.now as string) };
        if (item.error) {
          let caught: unknown;
          try {
            compile(item.query as never, options);
          } catch (error) {
            caught = error;
          }
          expect(caught, "the query should have been refused").toBeInstanceOf(JqlError);
          if (item.at !== undefined) expect((caught as JqlError).at).toBe(item.at);
          return;
        }
        const documents = suite.documents[item.documents as string] as unknown[];
        const test = compile(item.query as never, options);
        const found = documents.flatMap((document, index) => (test(document) ? [index] : []));
        expect(found).toEqual(item.matches);
      });
    }
  });
}

for (const group of [...new Set(suite.requests.map((item) => item.group))]) {
  describe(`conformance: requests, ${group}`, () => {
    for (const item of suite.requests.filter((entry) => entry.group === group)) {
      it(item.name, () => {
        const documents = suite.documents[item.documents] as unknown[];
        if (item.error) {
          let caught: unknown;
          try {
            search(documents, item.request as never);
          } catch (error) {
            caught = error;
          }
          expect(caught, "the request should have been refused").toBeInstanceOf(JqlError);
          if (item.at !== undefined) expect((caught as JqlError).at).toBe(item.at);
          return;
        }
        const found = search(documents, item.request as never);
        if (item.projection !== undefined) {
          expect(found).toEqual(item.projection);
          // The objects a projection returns are its own, built the way the specification
          // says: a field called `__proto__` is a field, not a prototype.
          for (const result of found) expect(Object.getPrototypeOf(result as object)).toBe(Object.prototype);
          return;
        }
        expect(found.map((item_) => documents.indexOf(item_))).toEqual(item.matches);
      });
    }
  });
}

describe("the conformance suite itself", () => {
  it("names a document set and an answer for every request case", () => {
    for (const item of suite.requests) {
      expect(suite.documents[item.documents], item.name).toBeDefined();
      if (!item.error) expect(item.matches ?? item.projection, item.name).toBeDefined();
    }
  });

  it("names a document set for every case that is not a refusal", () => {
    for (const item of suite.cases) {
      if (item.error) continue;
      expect(suite.documents[item.documents as string], item.name).toBeDefined();
      expect(item.matches, item.name).toBeDefined();
    }
  });

  it("gives every case a name of its own", () => {
    const names = suite.cases.map((item) => `${item.group}/${item.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("holds nothing JSON cannot carry", () => {
    const text = readFileSync(new URL("../conformance/cases.json", import.meta.url), "utf8");
    expect(JSON.stringify(JSON.parse(text))).toBe(JSON.stringify(suite));
  });
});
