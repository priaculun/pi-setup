#!/usr/bin/env node
/**
 * Pi requires host-provided packages in extension peerDependencies with "*".
 * Upstream packages often still list them under dependencies — re-apply after install.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const HOST = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-mcp",
  "typebox",
]);

const targets = [
  "node_modules/remote-pi/package.json",
  "node_modules/@tintinweb/pi-tasks/package.json",
];

function fix(rel) {
  const pkgPath = path.join(root, rel);
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const deps = { ...(pkg.dependencies || {}) };
  const peers = { ...(pkg.peerDependencies || {}) };
  let changed = false;
  for (const name of Object.keys(deps)) {
    if (HOST.has(name)) {
      delete deps[name];
      peers[name] = "*";
      changed = true;
    }
  }
  for (const name of Object.keys(peers)) {
    if (HOST.has(name) && peers[name] !== "*") {
      peers[name] = "*";
      changed = true;
    }
  }
  if (!changed) {
    console.log(`[fix-extension-peers] ok: ${pkg.name}`);
    return;
  }
  if (Object.keys(deps).length) pkg.dependencies = deps;
  else delete pkg.dependencies;
  if (Object.keys(peers).length) pkg.peerDependencies = peers;
  else delete pkg.peerDependencies;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`[fix-extension-peers] fixed: ${pkg.name}`);
}

for (const t of targets) fix(t);
