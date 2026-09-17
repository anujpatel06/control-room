// Whether a repo's record is posted to its pull request on push. On unless it
// was turned off for that repo, or for everything with NEARLY_NO_POST=1.

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { paths } from '../server/paths.mjs';

const key = (repo) => { try { return realpathSync.native(repo); } catch { return repo; } };
const read = () => { try { return existsSync(paths.config()) ? JSON.parse(readFileSync(paths.config(), 'utf8')) : {}; } catch { return {}; } };

export function postingOff(repo) {
  if (process.env.NEARLY_NO_POST === '1') return true;
  return (read().noPost || []).includes(key(repo));
}

export function setPosting(repo, on) {
  const cfg = read();
  const list = new Set(cfg.noPost || []);
  if (on) list.delete(key(repo)); else list.add(key(repo));
  cfg.noPost = [...list];
  writeFileSync(paths.config(), JSON.stringify(cfg, null, 2) + '\n');
}
