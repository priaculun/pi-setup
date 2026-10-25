#!/usr/bin/env node
// Sinkronkan prompt & description agent bawaan @tintinweb/pi-subagents ke override lokal
// (Explore.md, Plan.md, general-purpose.md). Frontmatter milik user (model, thinking,
// extensions, prompt_mode, dst.) TIDAK diubah — hanya `description` dan body prompt.
//
//   node ~/.pi/agent/agents/sync-defaults.mjs          # cek saja (exit 1 bila ada beda)
//   node ~/.pi/agent/agents/sync-defaults.mjs --write  # terapkan
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG = join(homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-subagents");
const DIR = join(homedir(), ".pi/agent/agents");
const WRITE = process.argv.includes("--write");

const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;
const src = readFileSync(join(PKG, "src/default-agents.ts"), "utf8");

/** Ambil blok satu agent bawaan (dari `name: "X"` sampai agent berikutnya). */
function block(name) {
  const start = src.indexOf(`name: "${name}"`);
  if (start < 0) throw new Error(`agent bawaan "${name}" tidak ditemukan di v${version} — format berubah, cek manual`);
  const next = src.indexOf('name: "', start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}
function defaults(name) {
  const b = block(name);
  const desc = JSON.parse(`"${b.match(/description: "((?:[^"\\]|\\.)*)"/)[1]}"`);
  // systemPrompt: template literal (Explore/Plan) atau string kosong (general-purpose).
  const tpl = b.match(/systemPrompt: `([\s\S]*?)`,/);
  if (tpl && /\$\{/.test(tpl[1])) throw new Error(`prompt "${name}" memakai interpolasi — cek manual`);
  const prompt = tpl ? tpl[1].replace(/\\`/g, "`") : "";
  return { desc, prompt };
}

/** Pisah file override jadi baris frontmatter + body. */
function parse(file) {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: frontmatter tidak valid`);
  return { fm: m[1].split("\n"), body: m[2] };
}

let drift = 0;
for (const name of ["Explore", "Plan", "general-purpose"]) {
  const file = join(DIR, `${name}.md`);
  const { desc, prompt } = defaults(name);
  const { fm, body } = parse(file);

  const descLine = `description: ${JSON.stringify(desc)}`;
  const descIdx = fm.findIndex((l) => l.startsWith("description:"));
  const newFm = [...fm];
  if (descIdx >= 0) newFm[descIdx] = descLine;
  else newFm.splice(1, 0, descLine);
  // general-purpose bawaan tidak punya prompt (prompt_mode append) → body kosong.
  const newBody = prompt ? `${prompt}\n` : "";

  const changes = [];
  if (newFm.join("\n") !== fm.join("\n")) changes.push("description");
  if (newBody !== body) changes.push("prompt");
  if (!changes.length) {
    console.log(`OK     ${name}.md sama dengan bawaan v${version}`);
    continue;
  }
  drift++;
  console.log(`BEDA   ${name}.md: ${changes.join(" + ")} berubah di v${version}`);
  if (WRITE) {
    writeFileSync(file, `---\n${newFm.join("\n")}\n---\n${newBody}`);
    console.log(`       → diperbarui (model/thinking/extensions tetap)`);
  }
}
if (drift && !WRITE) {
  console.log("\nJalankan dengan --write untuk menerapkan.");
  process.exit(1);
}
