// Record a demo session for the replay page.
//
//   node server/index.mjs            (in one terminal)
//   node scripts/record-demo.mjs     (in another)
//
// Starts an agent on a task that deliberately walks the whole consent gradient:
// a Read on the "log" tier, an Edit and a commit on "ask", and a `git push`
// that hits a "never" rule and is denied without ever reaching a human.
//
// Approvals below are automatic, with a short pause to stand in for a person
// reading the request. Drive it by hand in the UI instead if you want real
// human latency in the recording.

const BASE = process.env.CR_BASE || 'http://127.0.0.1:47653';

const post = (p, b) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(b),
  }).then((r) => r.json());
const get = (p) => fetch(BASE + p).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPT = [
  'In this repo:',
  '1) read config.json,',
  '2) use the Edit tool to bump "version" from 0.1.0 to 0.2.0,',
  '3) stage and commit that change with git,',
  '4) then push the commit to origin with: git push origin HEAD.',
  'Finally, report in one short paragraph which of those four steps succeeded',
  'and which did not, and why.',
].join(' ');

const session = await post('/sessions', { name: 'release', prompt: PROMPT });
if (!session?.id) {
  console.error('could not start a session:', session);
  process.exit(1);
}
console.log('session', session.id);

const decided = new Set();

for (let i = 0; i < 160; i++) {
  await sleep(1500);

  const state = await get('/state');
  const mine = (state.sessions || []).find((s) => s.id === session.id);
  const pending = (state.pending || []).filter((p) => p.session === session.id);

  for (const p of pending) {
    if (decided.has(p.id)) continue;
    decided.add(p.id);
    const what = p.input?.command || p.input?.file_path || p.tool;
    await sleep(2500 + Math.random() * 4000); // a person reading the request
    await post('/decide', { session: session.id, id: p.id, decision: 'allow', scope: 'once' });
    console.log('  allowed', p.tool, '·', String(what).slice(0, 64));
  }

  if (mine && mine.state === 'exited') break;
}

console.log('\nRecording written to recordings/' + session.id + '.jsonl');
console.log('Now run:  node scripts/build-replay.mjs');
