#!/usr/bin/env node
// The one command. Everything else is a subcommand of this.
//
//   control-room              turn it on for the repo you are in
//   control-room off          turn it off again
//   control-room open         open the dashboard
//   control-room record       build the record for the current branch
//   control-room post         put that record on the pull request
//   control-room voices       list the narration voices you have
//   control-room server       run the server in the foreground (it self-starts otherwise)
//   control-room hook <ev>    internal: what the Claude Code hooks call
//
// Run it with no arguments inside a git repo and it does the useful thing,
// because the useful thing is what people type first.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const s = (n) => join(root, 'scripts', n);
const run = (file, args = []) => {
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
};

const [cmd = 'attach', ...rest] = process.argv.slice(2);

function main() {
switch (cmd) {
  case 'attach': case 'on': case 'init':
    return run(s('attach.mjs'), rest);

  case 'off': case 'detach':
    return run(s('attach.mjs'), [...rest, '--off']);

  case 'hook':
    return run(s('hook.mjs'), rest);

  case 'record': case 'recap': {
    // Default to the branch you are on, since that is what gets reviewed.
    if (rest.length) return run(s('build-recap.mjs'), rest);
    try {
      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
      return run(s('build-recap.mjs'), ['--branch', branch, '--repo', process.cwd()]);
    } catch { return run(s('build-recap.mjs'), ['latest']); }
  }

  case 'post':
    return run(s('post-recap.mjs'), rest.length ? rest : ['latest']);

  case 'publish':
    return run(s('publish-pages.mjs'), rest);

  case 'voices':
    return run(s('build-recap.mjs'), ['--voices']);

  case 'server': {
    console.log('Control Room on http://127.0.0.1:47653');
    console.log('You do not normally need this: the hooks start it when they need it.');
    return run(join(root, 'server', 'index.mjs'), rest);
  }

  case 'open': {
    const url = 'http://127.0.0.1:47653';
    spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open',
      [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    console.log(url);
    return process.exit(0);
  }

  case 'help': case '--help': case '-h': {
    console.log(`
  control-room              turn it on for the repo you are in
  control-room off          turn it off again
  control-room open         open the dashboard
  control-room record       build the record for the current branch
  control-room post         put that record on the pull request
  control-room voices       list the narration voices you have
  control-room server       run the server in the foreground
`);
    return process.exit(0);
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Try: control-room help');
    process.exit(1);
}
}

main();
