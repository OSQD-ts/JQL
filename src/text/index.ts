/**
 * `@osqd/jql/text` — the search-box syntax, compiled into JQL.
 *
 * A separate entry because a service that only ever receives JSON queries has no reason
 * to load a tokenizer.
 */
export { parseText, MAX_TEXT_CHARS, MAX_TEXT_DEPTH, TEXT_OPERATORS } from "./parse.js";
export { suggest } from "./suggest.js";
export { toText } from "./write.js";

export type { TextOptions } from "./parse.js";
export type { Suggestions } from "./suggest.js";
export type { TextForm, Unexpressed } from "./write.js";
