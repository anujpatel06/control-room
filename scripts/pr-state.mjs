// The pull request for the branch you are on, and whether it can still take a record.
//
// `gh pr view` finds a branch's pull request whatever state it is in. Everything
// here used to read "found" as "open", so doctor reported a merged pull request
// as the open one, and a push offered to post a record onto a conversation that
// had already ended — where nobody reviewing will ever see it.

import { spawnSync } from 'node:child_process';

export function prForBranch(repo) {
  if (spawnSync('gh', ['--version'], { encoding: 'utf8' }).status !== 0) return { state: 'no-gh' };
  const r = spawnSync('gh', ['pr', 'view', '--json', 'number,url,state'], { cwd: repo, encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) {
    return /not logged|authentication|gh auth/i.test(r.stderr || '') ? { state: 'signed-out' } : { state: 'none' };
  }
  try {
    const { number, url, state } = JSON.parse(r.stdout);
    return { state: String(state || 'OPEN').toLowerCase(), number, url };
  } catch { return { state: 'none' }; }
}
