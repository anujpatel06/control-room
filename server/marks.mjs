// Claude Code sessions opened outside a repo, remembered once they have been
// gated in it. Written by the server, read by the hook (scripts/outside.mjs).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.mjs';

// One small file per session, naming the repo.
//
// Later calls from such a session may not mention the repo at all, and still
// have to be gated. Asking the server would put a network round trip in front of
// every tool call of every Claude Code session on the machine, and asking one
// from an older build got every one of those calls refused as an unknown
// session. A file lookup costs neither.
const safeId = (sid) => String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
const WEEK = 7 * 24 * 60 * 60 * 1000;

export function rememberOutside(sid, repo) {
  const id = safeId(sid);
  if (!id) return;
  const dir = paths.outside();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), String(repo));
  try {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (Date.now() - statSync(full).mtimeMs > WEEK) rmSync(full, { force: true });
    }
  } catch { /* tidying is optional */ }
}

export function rememberedRepo(sid, repos) {
  const id = safeId(sid);
  if (!id) return null;
  try {
    const repo = readFileSync(join(paths.outside(), id), 'utf8').trim();
    return repos.find((r) => r.repo === repo) || null;
  } catch { return null; }
}

