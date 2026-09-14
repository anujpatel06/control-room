// Build ui/replay.html from every recording in recordings/.
//
//   node scripts/build-replay.mjs
//
// The output is a single self-contained file: the recordings are embedded, so
// it opens anywhere with no server and no API key. That is the shareable link.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordingsDir = join(root, "recordings");
const templatePath = join(root, "ui", "replay.template.html");
const outPath = join(root, "ui", "replay.html");

const files = readdirSync(recordingsDir).filter((f) => f.endsWith(".jsonl"));
if (!files.length) {
  console.error("No recordings found. Run an agent first, then try again.");
  process.exit(1);
}

const sessions = [];
for (const file of files) {
  const events = readFileSync(join(recordingsDir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);

  if (events.length < 2) {
    console.warn("skipping", file, "(too short)");
    continue;
  }
  sessions.push({ id: file.replace(/\.jsonl$/, ""), events });
}

// Oldest first, so the picker reads left to right in the order they were run.
sessions.sort((a, b) => a.events[0].at - b.events[0].at);

const html = readFileSync(templatePath, "utf8").replace(
  "__SESSIONS__",
  JSON.stringify(sessions).replace(/<\/script>/gi, "<\\/script>")
);

writeFileSync(outPath, html);

console.log(`Built ui/replay.html — ${sessions.length} session(s), ${Math.round(html.length / 1024)} KB`);
for (const s of sessions) {
  const created = s.events.find((e) => e.type === "session" && e.subtype === "created");
  const secs = ((s.events.at(-1).at - s.events[0].at) / 1000).toFixed(1);
  console.log(`  ${created?.name ?? s.id.slice(0, 8)}  ${s.events.length} events  ${secs}s`);
}
