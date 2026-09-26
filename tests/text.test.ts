import { describe, expect, it } from "vitest";
import { compile, defineVocabulary, validate } from "../src/index.js";
import { MAX_TEXT_CHARS, parseText, suggest, TEXT_OPERATORS } from "../src/text/index.js";

/**
 * The search-box syntax.
 *
 * Adapted from bothandlerjs's feed-search suite (`tests/dashboard-client.test.ts`, "the
 * feed's search"): the same rows, the same queries, the same answers. The difference is
 * what runs them. There the text had its own matcher; here it becomes a JQL document and
 * the engine answers — so these cases are also the proof that the JSON language can say
 * everything the search box could.
 */

interface Entry {
  requestId: string;
  method: string;
  path: string;
  actor: string;
  userAgent: string;
  verdict: string;
  botClass: string;
  score: number;
  certain: boolean;
  action?: string;
  rule?: string;
  evidence: { detector: string; summary: string }[];
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    requestId: "req-1",
    method: "GET",
    path: "/api/items",
    actor: "203.0.113.4",
    userAgent: "curl/8.4.0",
    verdict: "confirmed-bot",
    botClass: "http-client",
    score: 100,
    certain: true,
    evidence: [],
    ...overrides,
  };
}

/** Names given to actors after the fact, looked up when the filter runs — as the dashboard does. */
const labels = new Map<string, string>();

const vocabulary = defineVocabulary<Entry>()({
  fields: {
    path: { aliases: ["url"] },
    actor: { aliases: ["ip"], kind: "word", get: (row) => (labels.has(row.actor) ? [row.actor, labels.get(row.actor)] : row.actor) },
    ua: { path: "userAgent", aliases: ["useragent", "agent"] },
    verdict: { values: ["confirmed-bot", "verified-bot", "suspected-bot", "human", "unknown"] },
    class: { path: "botClass", aliases: ["botclass"] },
    action: {},
    rule: {},
    method: { kind: "exact", values: ["GET", "POST", "HEAD"] },
    id: { path: "requestId", aliases: ["request"], kind: "word" },
    score: { kind: "number" },
    certain: { kind: "boolean", values: ["true", "false"] },
    detector: { get: (row) => row.evidence.map((item) => item.detector) },
    evidence: { get: (row) => row.evidence.map((item) => `${item.detector} ${item.summary}`) },
  },
  text: ["method", "path", "actor", "ua", "verdict", "class", "action", "rule", "id", "evidence"],
});

const rows = [
  entry({ requestId: "a", path: "/api/items", actor: "203.0.113.4", userAgent: "curl/8.4.0", verdict: "confirmed-bot", action: "block", rule: "http-clients" }),
  entry({ requestId: "b", path: "/health", actor: "203.0.113.4", userAgent: "kube-probe/1.29", verdict: "unknown", certain: false, score: 12, action: "allow", rule: "default" }),
  entry({
    requestId: "c",
    path: "/products",
    actor: "198.51.100.9",
    userAgent: "Mozilla/5.0",
    verdict: "suspected-bot",
    certain: false,
    score: 71,
    action: "challenge",
    evidence: [{ detector: "header-order", summary: "unusual header order" }],
  }),
];

function search(query: string, over: Entry[] = rows): string[] {
  const test = compile(parseText(query, { vocabulary }), { vocabulary });
  return over.filter(test).map((row) => row.requestId);
}

describe("the feed's search, answered by the engine", () => {
  it("matches a bare word anywhere", () => {
    expect(search("curl")).toEqual(["a"]);
    expect(search("203.0.113.4")).toEqual(["a", "b"]);
  });

  it("narrows to a field when one is named", () => {
    expect(search("actor:203.0.113.4")).toEqual(["a", "b"]);
    expect(search("path:/health")).toEqual(["b"]);
    expect(search("rule:default")).toEqual(["b"]);
    expect(search("detector:header-order")).toEqual(["c"]);
  });

  it("excludes with a leading dash", () => {
    expect(search("actor:203.0.113.4 -path:/health")).toEqual(["a"]);
    expect(search("-curl")).toEqual(["b", "c"]);
  });

  it("ands every term together", () => {
    expect(search("actor:203.0.113.4 path:/health")).toEqual(["b"]);
    expect(search("actor:203.0.113.4 path:/nothing")).toEqual([]);
  });

  it("compares scores rather than matching their digits", () => {
    expect(search("score:>50")).toEqual(["a", "c"]);
    expect(search("score:<50")).toEqual(["b"]);
    expect(search("score:12")).toEqual(["b"]);
  });

  it("takes the comparisons BotHandler could not", () => {
    expect(search("score:>=71")).toEqual(["a", "c"]);
    expect(search("score:<=12")).toEqual(["b"]);
    expect(search("score:10..80")).toEqual(["b", "c"]);
    expect(search("score:..12")).toEqual(["b"]);
  });

  it("keeps a quoted phrase together", () => {
    expect(parseText('"GET /api/v2"')).toEqual({ $text: "GET /api/v2" });
  });

  it("treats an unknown prefix as an ordinary word", () => {
    expect(parseText("weird:thing", { vocabulary })).toEqual({ $text: { $search: "weird:thing", $fields: vocabulary.text } });
  });

  it("ors two terms together", () => {
    expect(search("path:/health $or path:/api/items").sort()).toEqual(["a", "b"]);
  });

  it("binds $and tighter than $or", () => {
    expect(search("curl $or path:/health $and score:<50").sort()).toEqual(["a", "b"]);
  });

  it("takes brackets when that is not what you meant", () => {
    expect(search("(curl $or path:/health) $and score:<50")).toEqual(["b"]);
  });

  it("spells negation as $not as well as a dash", () => {
    expect(search("$not curl").sort()).toEqual(["b", "c"]);
    expect(search("actor:203.0.113.4 $not path:/health")).toEqual(["a"]);
    expect(search("$not (curl $or path:/health)")).toEqual(["c"]);
  });

  it("matches a set with $in and refuses one with $notin", () => {
    expect(search("path:$in(/health, /api/items)").sort()).toEqual(["a", "b"]);
    expect(search("path:$notin(/health)").sort()).toEqual(["a", "c"]);
    expect(search("path:$in(/health,/api/items)").sort()).toEqual(["a", "b"]);
  });

  it("reads every kind of quote as a quote", () => {
    const curly = (open: number, close: number, text: string): string => `${String.fromCharCode(open)}${text}${String.fromCharCode(close)}`;
    for (const quoted of ['"203.0.113.4"', "'203.0.113.4'", curly(0x201c, 0x201d, "203.0.113.4"), curly(0x2018, 0x2019, "203.0.113.4")]) {
      expect(search(`actor:$notin(${quoted})`), `$notin(${quoted})`).toEqual(["c"]);
      expect(search(`actor:$in(${quoted})`).sort(), `$in(${quoted})`).toEqual(["a", "b"]);
      expect(search(`actor:${quoted}`).sort(), `actor:${quoted}`).toEqual(["a", "b"]);
    }
  });

  it("keeps a comma inside a quoted set value", () => {
    expect(parseText('actor:$in("a,b", c)', { vocabulary })).toEqual({ actor: { $word: ["a,b", "c"], $options: "i" } });
    expect(parseText("actor:$in('a,b', c)", { vocabulary })).toEqual({ actor: { $word: ["a,b", "c"], $options: "i" } });
  });

  it("leaves an apostrophe in the middle of a word alone", () => {
    expect(parseText("don't")).toEqual({ $text: "don't" });
    expect(parseText("path:/o'reilly curl", { vocabulary })).toMatchObject({ $and: [{ path: { $contains: "/o'reilly" } }, {}] });
  });

  it("matches an actor a component at a time, not a digit at a time", () => {
    const neighbours = [
      entry({ requestId: "exact", actor: "1.2.3.4" }),
      entry({ requestId: "longer", actor: "1.2.3.45" }),
      entry({ requestId: "wider", actor: "11.2.3.4" }),
      entry({ requestId: "network", actor: "1.2.3.0/24" }),
    ];
    expect(search("actor:1.2.3.4", neighbours)).toEqual(["exact"]);
    expect(search("actor:$in(1.2.3.4)", neighbours)).toEqual(["exact"]);
    expect(search("actor:$notin(1.2.3.4)", neighbours)).toEqual(["longer", "wider", "network"]);
    expect(search("actor:1.2.3", neighbours).sort()).toEqual(["exact", "longer", "network"]);
    expect(search("actor:3.45", neighbours)).toEqual(["longer"]);
  });

  it("finds an actor by the name it was given, as well as by its key", () => {
    labels.set("203.0.113.4", "the noisy one");
    try {
      expect(search("actor:noisy").sort()).toEqual(["a", "b"]);
      expect(search('actor:$notin("the noisy one")')).toEqual(["c"]);
      expect(search("noisy").sort(), "and a free word finds it too").toEqual(["a", "b"]);
      expect(search("actor:203.0.113.4").sort()).toEqual(["a", "b"]);
    } finally {
      labels.clear();
    }
  });

  it("matches nothing for an empty set rather than everything", () => {
    expect(search("path:$in()")).toEqual([]);
  });

  it("survives half-written input", () => {
    for (const half of ["$", "$n", "$not", "$or", "(", "(curl", "curl $or", "path:$in(", "path:$in(/health", ")", "((a)", "$and $and", "-", '"', "score:>", "score:..", "a) b"]) {
      expect(() => search(half), half).not.toThrow();
      expect(validate(parseText(half, { vocabulary }), { vocabulary }).valid, half).toBe(true);
    }
    expect(search("$not")).toEqual(["a", "b", "c"]);
    expect(search("curl $or")).toEqual(["a"]);
    expect(search("(curl")).toEqual(["a"]);
  });

  it("survives brackets nested past any reasonable depth", () => {
    for (const depth of [32, 5_000, 200_000]) {
      const nested = `${"(".repeat(depth)}curl${")".repeat(depth)}`;
      expect(() => search(nested), `depth ${depth}`).not.toThrow();
    }
    expect(search("(curl $or path:/health)").sort()).toEqual(["a", "b"]);
    expect(search("(path:/nope $or path:/health)")).toEqual(["b"]);
  });

  it("does not turn an ordinary word into an operator", () => {
    expect(TEXT_OPERATORS.every((name) => name.startsWith("$"))).toBe(true);
    expect(search("or")).toEqual(["c"]);
    expect(search("path:/health or path:/api/items")).toEqual([]);
  });

  it("matches everything when it is empty", () => {
    expect(search("")).toEqual(["a", "b", "c"]);
    expect(search("   ")).toEqual(["a", "b", "c"]);
    expect(parseText("")).toEqual({});
  });

  it("reads booleans and closed sets", () => {
    expect(search("certain:true")).toEqual(["a"]);
    expect(search("certain:no").sort()).toEqual(["b", "c"]);
    expect(search("certain:maybe")).toEqual([]);
    expect(search("method:get")).toEqual(["a", "b", "c"]);
    expect(search("method:$in(post, head)")).toEqual([]);
  });

  it("cuts input past the length cap rather than refusing it", () => {
    const long = `curl ${"x".repeat(MAX_TEXT_CHARS * 2)}`;
    expect(() => parseText(long)).not.toThrow();
  });
});

describe("text without a vocabulary", () => {
  it("reads any path-like name as a field", () => {
    expect(parseText("address.city:London")).toEqual({ "address.city": { $contains: "London", $options: "i" } });
  });

  it("reads a written-out comparison as a number and a bare number as text", () => {
    expect(parseText("age:>=30")).toEqual({ age: { $gte: 30 } });
    expect(parseText("age:30..40")).toEqual({ age: { $gte: 30, $lte: 40 } });
    expect(parseText("zip:30")).toEqual({ zip: { $contains: "30", $options: "i" } });
  });

  it("reads a date field's comparison as dates when the vocabulary says so", () => {
    const dated = defineVocabulary<{ at: string }>()({ fields: { at: { kind: "date" } } });
    const query = parseText("at:>2026-09-01", { vocabulary: dated });
    expect(query).toEqual({ at: { $gt: { $date: "2026-09-01" } } });
    const test = compile(query, { vocabulary: dated });
    expect(test({ at: "2026-09-02T10:00:00Z" })).toBe(true);
    expect(test({ at: "2026-08-31T10:00:00Z" })).toBe(false);
  });
});

describe("asking whether a field is there, and when", () => {
  const dated = defineVocabulary<{ at: string; rule?: string }>()({ fields: { at: { kind: "date", aliases: ["when"] }, rule: {} } });
  const rows = [
    { at: "2026-09-22T11:30:00Z", rule: "no-scrapers" },
    { at: "2026-09-20T11:30:00Z" },
  ];
  const now = (): number => Date.parse("2026-09-22T12:00:00Z");
  const find = (input: string): number =>
    rows.filter(compile(parseText(input, { vocabulary: dated }), { vocabulary: dated, now })).length;

  it("reads has: as a question about the field", () => {
    expect(parseText("has:rule", { vocabulary: dated })).toEqual({ rule: { $exists: true } });
    expect(parseText("-has:rule", { vocabulary: dated })).toEqual({ $not: { rule: { $exists: true } } });
    expect(find("has:rule")).toBe(1);
    expect(find("-has:rule")).toBe(1);
  });

  it("searches for the text when the name is not a field here", () => {
    expect(parseText("has:nothing", { vocabulary: dated })).toMatchObject({ $text: "has:nothing" });
    // Without a vocabulary there is nothing to check a name against, so any path-like name is one.
    expect(parseText("has:anything")).toEqual({ anything: { $exists: true } });
  });

  it("reads a signed duration as an instant relative to now", () => {
    expect(parseText("at:>-1h", { vocabulary: dated })).toEqual({ at: { $gt: { $date: { $ago: "1h" } } } });
    expect(parseText("when:<+30m", { vocabulary: dated })).toEqual({ at: { $lt: { $date: { $ahead: "30m" } } } });
    expect(parseText("at:-1h..now", { vocabulary: dated })).toEqual({ at: { $gte: { $date: { $ago: "1h" } }, $lte: { $date: "now" } } });
    expect(find("at:>-1h")).toBe(1);
    expect(find("at:>-7d")).toBe(2);
    expect(find("at:-1h..now")).toBe(1);
  });

  /**
   * A bare `1h` in a date field is as likely to be part of something somebody is searching
   * for as a moment in time, so the sign is what says which was meant.
   */
  it("does not read a duration without a sign as a time", () => {
    expect(parseText("at:1h", { vocabulary: dated })).toEqual({ at: { $in: [] } });
  });
});

describe("names that mean something to JavaScript", () => {
  /**
   * A query is built from whatever somebody typed, so a field name can be `__proto__`. In
   * an object literal a computed key defines an ordinary property, which is what makes the
   * parser safe here — and what this case exists to keep true.
   */
  it("builds a query with a __proto__ field without touching any prototype", () => {
    const query = parseText("__proto__:x") as unknown as Record<string, unknown>;
    expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    expect(Object.hasOwn(query, "__proto__")).toBe(true);
    // A computed key defines an ordinary own property, so a document really holding the
    // field matches, whether it was written in code or parsed from JSON.
    expect(compile(query)({ ["__proto__"]: "x" })).toBe(true);
    expect(compile(query)(JSON.parse('{"__proto__": "xyz"}'))).toBe(true);
    // And an ordinary object, whose `__proto__` is the inherited accessor, does not.
    expect(compile(query)({})).toBe(false);
    expect(compile(query)({ other: "x" })).toBe(false);
  });
});

describe("completions", () => {
  it("completes a field name from what has been typed", () => {
    expect(suggest("ver", 3, vocabulary).options).toEqual(["verdict:"]);
  });

  it("completes the values of a field whose set is closed", () => {
    expect(suggest("verdict:con", 11, vocabulary).options).toEqual(["verdict:confirmed-bot"]);
  });

  it("offers nothing for a field that takes anything", () => {
    expect(suggest("rule:no-", 8, vocabulary).options).toEqual([]);
    expect(suggest("path:/ap", 8, vocabulary).options).toEqual([]);
  });

  it("keeps a negation on the front of what it completes", () => {
    expect(suggest("-verd", 5, vocabulary).options).toEqual(["-verdict:"]);
    expect(suggest("-verdict:hum", 12, vocabulary).options).toEqual(["-verdict:human"]);
  });

  it("completes only the token the caret is in", () => {
    const input = "actor:203.0.113.4 ver";
    const { options, from, to } = suggest(input, input.length, vocabulary);
    expect(options).toEqual(["verdict:"]);
    expect(input.slice(from, to)).toBe("ver");
  });

  it("offers the set forms and the operators", () => {
    expect(suggest("verdict:$", 9, vocabulary).options.slice(0, 2)).toEqual(["verdict:$in(", "verdict:$notin("]);
    expect(suggest("$o", 2).options).toEqual(["$or"]);
  });

  it("only offers names the parser actually accepts", () => {
    for (const name of vocabulary.names) {
      expect(suggest(name.slice(0, 2), 2, vocabulary).options.length).toBeGreaterThan(0);
      expect(Object.keys(parseText(`${name}:x`, { vocabulary }))[0]).not.toBe("$text");
    }
  });
});

/**
 * A completion is text somebody presses Tab on without reading it, so the only property
 * worth testing is that what goes in means what it says. All three of these shipped broken:
 * a value with a space was offered bare, so `status:` completed to `status:in progress` —
 * which parses as `status:in` and a loose search word, a *different query* with nothing on
 * screen to say so.
 */
describe("completing a value the syntax has to quote", () => {
  const awkward = defineVocabulary()({
    fields: {
      status: { kind: "exact", values: ["open", "in progress", "won't fix", 'say "hi"', "both ' and \""] },
      owner: { kind: "exact" },
      note: {},
    },
    text: ["note"],
  });

  it("quotes a value that holds a space", () => {
    expect(suggest("status:in", 9, awkward).options).toEqual(['status:"in progress"']);
  });

  it("picks a quote the value does not itself contain", () => {
    expect(suggest("status:won", 10, awkward).options).toEqual(["status:\"won't fix\""]);
    expect(suggest("status:say", 10, awkward).options).toEqual(["status:'say \"hi\"'"]);
  });

  it("leaves out a value the syntax cannot write at all", () => {
    // Both kinds of quote and no escape between them. Offering it unquoted would complete
    // the box with something that parses as less than it says.
    expect(suggest("status:both", 11, awkward).options).toEqual([]);
  });

  /**
   * Typing the opening quote yourself used to stop completion dead: the token was found by
   * splitting on the last space, so `status:"in pro` looked like a fresh token `pro`, and
   * the span offered to replace would have cut the input in half.
   */
  it("keeps completing after an opening quote, and replaces the whole token", () => {
    for (const input of ['status:"', 'status:"in', 'status:"in pro', "status:'in pro"]) {
      const { options, from, to } = suggest(input, input.length, awkward);
      expect(options, input).toContain('status:"in progress"');
      expect(input.slice(from, to), input).toBe(input);
    }
  });

  it("offers nothing inside a phrase, which is not a field at all", () => {
    // `"sta` is a search for text, and completing it to `"status:` would ask for documents
    // holding the characters "status:".
    expect(suggest('"sta', 4, awkward).options).toEqual([]);
    expect(suggest('note:x "sta', 11, awkward).options).toEqual([]);
  });

  it("completes inside a set, keeping the values already chosen", () => {
    const input = "status:$in(open, in pro";
    const { options, from } = suggest(input, input.length, awkward);
    expect(options).toEqual(['status:$in(open, "in progress"']);
    expect(from).toBe(0);
    expect(parseText(options[0] as string, { vocabulary: awkward })).toEqual({ status: { $in: ["open", "in progress"], $options: "i" } });
  });

  /**
   * The property, over every value in the vocabulary and every prefix of it: what is
   * offered, inserted, parses as a term on that field holding that value — and never as a
   * loose text search, which is what an unquoted space turns into.
   */
  it("every completion, inserted, parses as the term it claims", () => {
    for (const field of awkward.fields) {
      for (const value of field.values ?? []) {
        for (let cut = 0; cut <= value.length; cut++) {
          for (const opener of ["", '"', "'"]) {
            const input = `${field.name}:${opener}${value.slice(0, cut)}`;
            const { options, from, to } = suggest(input, input.length, awkward);
            for (const option of options) {
              const inserted = input.slice(0, from) + option + input.slice(to);
              const query = parseText(inserted, { vocabulary: awkward }) as unknown as Record<string, { $eq?: unknown }>;
              expect(Object.keys(query), inserted).toEqual([field.name]);
              expect(query[field.name]?.$eq, inserted).toBe(option.slice(`${field.name}:`.length).replace(/^(["'])([\s\S]*)\1$/, "$2"));
            }
          }
        }
      }
    }
  });
});

/**
 * A vocabulary's `values` is a closed set, decided when the vocabulary is written. Plenty of
 * fields have no such set and still have a handful of values in practice, and the console
 * that has just listed a thousand rows is the only thing that knows them.
 */
describe("values seen at run time", () => {
  const live = defineVocabulary()({
    fields: {
      owner: { kind: "exact", aliases: ["assignee"] },
      status: { kind: "exact", values: ["open", "closed"] },
    },
  });

  it("completes a field that declares no set, once it is given the values", () => {
    expect(suggest("owner:", 6, live).options).toEqual([]);
    expect(suggest("owner:", 6, live, { values: { owner: ["Ada Lovelace", "Grace Hopper"] } }).options).toEqual([
      'owner:"Ada Lovelace"',
      'owner:"Grace Hopper"',
    ]);
  });

  it("merges them with a declared set, declared first, without repeating one", () => {
    const options = suggest("status:", 7, live, { values: { status: ["closed", "stalled"] } }).options;
    expect(options).toEqual(["status:open", "status:closed", "status:stalled"]);
  });

  it("finds the field through an alias, whichever name was typed", () => {
    const values = { owner: ["Ada Lovelace"] };
    expect(suggest("assignee:Ada", 12, live, { values }).options).toEqual(['assignee:"Ada Lovelace"']);
  });

  it("refuses a shape it cannot read rather than offering nothing", () => {
    // Offering nothing is what a field with no values seen yet looks like, so a caller
    // passing the wrong shape would have no way to tell the two apart.
    expect(() => suggest("owner:", 6, live, { values: { owner: "Ada" } as never })).toThrow(/options\.values\.owner/);
    expect(() => suggest("owner:", 6, live, { values: { owner: [1] } as never })).toThrow(/list of strings/);
    expect(() => suggest("owner:", 6, live, { values: [] as never })).toThrow(/field names to lists of values/);
  });
});
