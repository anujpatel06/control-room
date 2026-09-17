#!/usr/bin/env node
// The entry Claude Code's user-level hook runs: `node …/scripts/outside-hook.mjs <event>`.
//
// A file of its own, not `nearly hook <event> --outside`, so that a Nearly too old
// to know about sessions opened elsewhere cannot answer for them. 0.1.18 wrote the
// flag form and pointed it at an installed 0.1.17, which read the unknown flag as
// "supervise this session" and held every tool call of every Claude Code session on
// the machine for two minutes before refusing it. An older copy has no such file,
// so node exits with an error, and Claude Code treats a hook that errors as one
// that did not object.
process.argv.splice(3, 0, '--outside');
await import('./hook.mjs');
