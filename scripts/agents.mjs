// What Nearly can gate, and how much of that is a claim rather than a
// demonstration.
//
//   nearly agents        what this repo is gated for, and what else is possible
//
// Printed because the difference matters. An adapter written from a vendor's
// hook documentation is a reasonable bet; it is not the same thing as having
// watched an agent be stopped. Saying so is cheap, and the alternative — a tool
// that reports coverage it has not earned — is the exact failure this project
// was built to catch.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ADAPTERS, OURS_RE } from '../server/adapters.mjs';
import { detect, installed } from './detect.mjs';

// Colour only on a terminal; piped into a file or a CI log it is noise.
const COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : String(s));
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : String(s));
const ok = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : String(s));

const repo = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || process.cwd());
const here = new Set(detect(repo).map((d) => d.id));
const machine = new Set(installed().map((d) => d.id));

// The config file existing proves nothing: Cursor writes .cursor/hooks.json for
// its own reasons. What proves the gate is wired is our command being inside it.
// Anything weaker would let this command report coverage it has not got.
const gated = (a) => {
  const f = join(repo, a.config);
  if (!existsSync(f)) return false;
  try { return OURS_RE.test(readFileSync(f, 'utf8')); } catch { return false; }
};

const width = Math.max(...ADAPTERS.map((a) => a.name.length));
const pad = (s) => s + ' '.repeat(width - s.length);

console.log('');
console.log(`  ${bold('Agents')} ${dim(repo)}`);
console.log('');
for (const a of ADAPTERS) {
  const on = gated(a);
  const mark = on ? ok('●') : dim('○');
  // "Wired", not "gated": a hook being in the config says nothing about whether
  // it runs. `nearly doctor` fires one to find out.
  const state = on ? 'wired here' : here.has(a.id) ? 'used here, not wired' : machine.has(a.id) ? 'installed, unused here' : 'not in use here';
  console.log(`  ${mark} ${bold(pad(a.name))}  ${pad2(state)} ${dim(a.config)}`);
}
function pad2(s) { return s + ' '.repeat(Math.max(0, 22 - s.length)); }

console.log('');
const proven = ADAPTERS.filter((a) => a.verified);
const claimed = ADAPTERS.filter((a) => !a.verified);
console.log(`  ${ok('Run against a live agent:')} ${proven.map((a) => a.name).join(', ')}`);
console.log(`  ${dim('Built to the vendor\'s published hook spec and tested against payloads')}`);
console.log(`  ${dim('copied from it, but never yet run against the real thing:')}`);
console.log(`  ${dim('  ' + claimed.map((a) => a.name).join(', '))}`);
console.log('');
console.log(dim('  If you use one of those, the useful thing you can do is try it and say'));
console.log(dim('  what broke: github.com/anujpatel06/nearly/issues'));
console.log('');
console.log(dim('  nearly --agent=cursor    turn one on for this repo'));
console.log(dim('  nearly --agent=all       turn on every one of them'));
console.log('');
