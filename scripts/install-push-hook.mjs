// Install a git pre-push hook that builds the branch's session record and
// offers to post it to the pull request.
//
//   node scripts/install-push-hook.mjs <repo-path> [--remove]
//
// Pushing is the moment your work stops being yours and becomes someone else's
// to review, so it is the right moment to hand over the record. The hook:
//
//   1. builds one record for the branch being pushed, merging every session
//   2. prints what it found, including anything that was refused
//   3. asks whether to post it, reading your answer from the terminal
//   4. gets out of the way
//
// It never blocks a push. If the record cannot be built, or you say no, or
// anything at all goes wrong, the push proceeds and the hook exits 0. Posting
// is always your explicit "y" — a record of what you refused is more revealing
// than a diff, and software should not publish that on your behalf.

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const argv = process.argv.slice(2);
const repo = resolve(argv.find((a) => !a.startsWith('--')) || '.');
const remove = argv.includes('--remove');

if (!existsSync(join(repo, '.git'))) {
  console.error(`${repo} is not a git repository`);
  process.exit(1);
}
const hooksDir = join(repo, '.git', 'hooks');
const hookPath = join(hooksDir, 'pre-push');

if (remove) {
  if (existsSync(hookPath)) { rmSync(hookPath); console.log(`Removed ${hookPath}`); }
  else console.log('No pre-push hook to remove.');
  process.exit(0);
}

if (existsSync(hookPath)) {
  const existing = readFileSync(hookPath, 'utf8');
  if (!existing.includes('control-room')) {
    console.error(`${hookPath} already exists and was not written by the Control Room.`);
    console.error('Refusing to overwrite it. Move it aside, or add this line to it yourself:');
    console.error(`  node ${join(root, 'scripts', 'push-record.mjs')} "${repo}" || true`);
    process.exit(1);
  }
}

mkdirSync(hooksDir, { recursive: true });
writeFileSync(hookPath, `#!/bin/sh
# control-room: hand the session record over at push time.
# Never blocks the push; "exit 0" at the end is the whole safety story.
#
# git gives a hook no terminal of its own, so borrow the user's when there is
# one. Scripted and CI pushes have no controlling terminal: run anyway, print
# nothing to ask, and post nothing.
#
# The test has to be an actual open. /dev/tty always exists and is always
# readable and writable by its permission bits; opening it is what fails, with
# ENXIO, when no terminal is attached. The open has to happen inside a subshell
# too: a failed redirection is reported by the shell itself, so redirecting the
# command's stderr does not silence it, but redirecting the subshell's does.
CR="${join(root, 'scripts', 'push-record.mjs')}"
if (: >/dev/tty) 2>/dev/null; then
  node "$CR" "${repo}" </dev/tty >/dev/tty 2>&1 || true
else
  CONTROL_ROOM_NO_TTY=1 node "$CR" "${repo}" || true
fi
exit 0
`);
chmodSync(hookPath, 0o755);

console.log(`Installed ${hookPath}`);
console.log('');
console.log('Next push on this repo will build the branch record and ask before posting.');
console.log('Set RECAP_URL_BASE so the comment can link to the hosted page, e.g.');
console.log('  export RECAP_URL_BASE=https://<user>.github.io/<repo>/recaps');
console.log('Remove it again with: node scripts/install-push-hook.mjs "' + repo + '" --remove');
