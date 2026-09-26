#!/usr/bin/env node
// Three lines over the same implementation the package exports, because a command that
// reimplements the library is a command that drifts from it.
import { run } from "../dist/cli.js";
await run();
