#!/usr/bin/env node
// The one command. Everything else is a subcommand of this.
//
//   nearly              turn it on for the repo you are in
//   nearly off          turn it off again
//   nearly open         open the dashboard
//   nearly record       build the record for the current branch
//   nearly post         put that record on the pull request
//   nearly agents       which agents this repo is gated for
//   nearly voices       list the narration voices you have
//   nearly server       run the server in the foreground (it self-starts otherwise)
//   nearly hook <ev>    internal: what the Claude Code hooks call
//
// Run it with no arguments inside a git repo and it does the useful thing,
// because the useful thing is what people type first.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const s = (n) => join(root, 'scripts', n);
// Commands a person typed and is waiting on may mention an update. The hook
// never does: nothing goes in front of an agent's tool call.
const NOTIFY = new Set(['attach', 'on', 'init', 'record', 'recap', 'post', 'publish']);

const run = async (file, args = []) => {
  const r = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
  if (NOTIFY.has(cmd) && (r.status ?? 0) === 0) {
    try {
      const { checkForUpdate, applyUpdate } = await import('../scripts/update-check.mjs');
      applyUpdate(await checkForUpdate());
    } catch { /* an update notice is never worth an error */ }
  }
  process.exit(r.status ?? 0);
};

// A leading flag is not a command. `nearly --agent=cursor` and `nearly --off`
// are how the docs say to do those things, and both used to land on "Unknown
// command" because the first argument was read as a subcommand name.
const argv = process.argv.slice(2);
const leadingFlag = argv[0]?.startsWith('-') && !['--help', '-h', '--which'].includes(argv[0]);
const [cmd = 'attach', ...rest] = leadingFlag ? ['attach', ...argv] : argv;

async function main() {
switch (cmd) {
  case 'attach': case 'on': case 'init':
    return run(s('attach.mjs'), rest);

  case 'off': case 'detach':
    return run(s('attach.mjs'), [...rest, '--off']);

  // Used by attach to confirm a `nearly` on PATH really is this tool before
  // pointing hooks at a bare command name.
  case '--which':
    console.log(root);
    return process.exit(0);

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

  case 'agents':
    return run(s('agents.mjs'), rest);

  case 'voices':
    return run(s('build-recap.mjs'), ['--voices']);

  case 'server': {
    console.log('Nearly on http://127.0.0.1:47653');
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
  nearly              turn it on for the repo you are in
  nearly off          turn it off again
  nearly open         open the dashboard
  nearly record       build the record for the current branch
  nearly post         put that record on the pull request
  nearly agents       which agents this repo is gated for
  nearly voices       list the narration voices you have
  nearly server       run the server in the foreground
`);
    return process.exit(0);
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Try: nearly help');
    process.exit(1);
}
}

await main();
