#!/usr/bin/env node
/**
 * pi-setup — reproducible Pi coding-agent setup (macOS, Ubuntu, Arch/Omarchy, Windows 11).
 *
 *   node scripts/setup.mjs apply   [--force] [--dry-run] [--no-packages] [--no-post]
 *   node scripts/setup.mjs render  [--force] [--dry-run]     # files only
 *   node scripts/setup.mjs doctor  [--json]                  # health check (exit 1 on errors)
 *   node scripts/setup.mjs capture [--prune] [--dry-run]     # live machine -> repo (redacted)
 *   node scripts/setup.mjs scan                              # secret scan of the repo
 *   node scripts/setup.mjs secrets <init|pull|push|check|path>
 *   node scripts/setup.mjs reset   [--dry-run] [--yes]       # move old Pi config to ~/.pi-backup-<stamp>
 *   node scripts/setup.mjs selftest                          # CI: render into a temp HOME
 *
 * Templates (*.tmpl) contain ${NAME} placeholders filled from secrets.env.
 * Secrets never live in this repo; see SECRETS.md.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- paths
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WIN = process.platform === "win32";

/** Recomputed by selftest, which points PI_SETUP_HOME at a temp dir. */
function paths() {
	const home = process.env.PI_SETUP_HOME || os.homedir();
	const fake = Boolean(process.env.PI_SETUP_HOME);
	const agent = (!fake && process.env.PI_CODING_AGENT_DIR) || path.join(home, ".pi", "agent");
	const appData = fake || !process.env.APPDATA ? path.join(home, "AppData", "Roaming") : process.env.APPDATA;
	const cfg = path.join(home, ".config", "pi-setup");
	return {
		home,
		agent,
		remote: path.join(home, ".pi", "remote"),
		herdrCore: IS_WIN ? path.join(appData, "herdr-core") : path.join(home, ".config", "herdr-core"),
		bin: path.join(home, ".local", "bin"),
		cfg,
		state: path.join(cfg, "state.json"),
		secrets: process.env.PI_SETUP_SECRETS || path.join(cfg, "secrets.env"),
	};
}

/** Repo dir -> live dir. `files`: explicit allow-list; `dirs`: tracked recursively. */
function mappings(P = paths()) {
	return [
		{
			repo: "home/pi-agent",
			live: P.agent,
			files: [
				"AGENTS.md", "settings.json", "models.json", "mcp.json", "web-search.json",
				"better-custom.state.json", "ontoken-auto.json", "npm/package.json", "npm/fix-extension-peers.mjs",
			],
			dirs: ["agents", "skills", "extensions", "prompts", "themes"],
		},
		{ repo: "home/pi-remote", live: P.remote, files: ["config.json"], dirs: [] },
		// hc = herdr-core: its config and its role templates (worker/reviewer/planner).
		{ repo: "home/herdr-core", live: P.herdrCore, files: ["config.toml"], dirs: ["templates"] },
		{ repo: "bin", live: P.bin, files: ["pr-gate"], dirs: [], exec: true },
	];
}

/** Live files installed/managed by other tools — never captured. */
const IGNORE = [
	/^skills\/tsk-cli(\/|$)/, // written by the `tsk` CLI (no longer installed)
	/^extensions\/herdr-agent-state\.ts$/, // written by `herdr integration install pi`; a machine that still has it must not push it back
	/(^|\/)\.DS_Store$/,
	/\.bak(-\d+)?$/,
	/(^|\/)node_modules(\/|$)/,
];
/** settings.json keys Pi rewrites on its own. */
const VOLATILE_SETTINGS = ["lastChangelogVersion", "extensionChangelogVersions"];
/** Files that hold credentials once rendered -> chmod 600. */
const SENSITIVE = new Set(["models.json", "mcp.json", "web-search.json", "config.json"]);

// ---------------------------------------------------------------- utils
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const c = (n, s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const log = {
	ok: (m) => console.log(`${c(32, "ok   ")} ${m}`),
	info: (m) => console.log(`${c(36, "info ")} ${m}`),
	warn: (m) => console.log(`${c(33, "warn ")} ${m}`),
	err: (m) => console.log(`${c(31, "error")} ${m}`),
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rel = (p) => p.split(path.sep).join("/");
const readJSON = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d);
const writeFile = (p, s, mode) => {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, s);
	if (mode && !IS_WIN) fs.chmodSync(p, mode);
};
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

/** On Windows, CLIs are often .cmd shims that need a shell; quote args ourselves then. */
const winQuote = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function run(cmd, args, opts = {}) {
	const r = IS_WIN
		? spawnSync([cmd, ...args].map(winQuote).join(" "), { encoding: "utf8", shell: true, ...opts })
		: spawnSync(cmd, args, { encoding: "utf8", ...opts });
	return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), missing: r.error?.code === "ENOENT" };
}
const has = (cmd) => {
	const r = run(IS_WIN ? "where" : "sh", IS_WIN ? [cmd] : ["-c", `command -v ${cmd}`]);
	return r.code === 0;
};

function walk(dir, base = dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, base));
		else if (e.isFile()) out.push(rel(path.relative(base, p)));
	}
	return out;
}

// ---------------------------------------------------------------- secrets
function parseEnv(text) {
	const env = {};
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		let v = m[2];
		if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
		env[m[1]] = v;
	}
	return env;
}
function loadSecrets() {
	const P = paths();
	const file = fs.existsSync(P.secrets) ? P.secrets : fs.existsSync(path.join(REPO, "secrets.env")) ? path.join(REPO, "secrets.env") : null;
	return { file, vars: file ? parseEnv(fs.readFileSync(file, "utf8")) : {} };
}
/** Value lookup: secrets.env first, then the process environment. */
const lookup = (vars, name) => vars[name] ?? process.env[name];

function writeSecrets(file, vars, header) {
	const lines = [header ?? "# pi-setup secrets — NEVER commit. See SECRETS.md.", ""];
	for (const k of Object.keys(vars).sort()) lines.push(`${k}=${vars[k]}`);
	writeFile(file, `${lines.join("\n")}\n`, 0o600);
}

// ---------------------------------------------------------------- templating
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;
function renderTemplate(text, vars) {
	const missing = new Set();
	const out = text.replace(PLACEHOLDER, (_, name) => {
		const v = lookup(vars, name);
		if (v === undefined || v === "") {
			missing.add(name);
			return `\${${name}}`;
		}
		// Values land inside JSON strings: escape so a quote/backslash cannot break the file.
		return JSON.stringify(v).slice(1, -1);
	});
	return { out, missing: [...missing] };
}
const templateVars = (text) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];

/** All repo files with their live destination. */
function plan(P = paths()) {
	const items = [];
	for (const m of mappings(P)) {
		for (const f of walk(path.join(REPO, m.repo))) {
			const tmpl = f.endsWith(".tmpl");
			const liveRel = tmpl ? f.slice(0, -5) : f;
			items.push({
				m,
				src: path.join(REPO, m.repo, f),
				repoRel: `${m.repo}/${f}`,
				liveRel,
				dst: path.join(m.live, liveRel),
				tmpl,
				merge: m.repo === "home/pi-agent" && liveRel === "settings.json",
				// models.json: repo providers win, providers kept local to this machine survive a render.
				mergeProviders: m.repo === "home/pi-agent" && liveRel === "models.json",
				sensitive: tmpl && SENSITIVE.has(path.basename(liveRel)),
				exec: Boolean(m.exec),
			});
		}
	}
	return items;
}

/** Desired content for one file, plus the "managed view" of the current live content. */
function desired(item, vars) {
	const raw = fs.readFileSync(item.src, "utf8");
	if (item.merge) {
		// settings.json: repo keys win, local-only keys (e.g. lastChangelogVersion) are kept.
		const repo = JSON.parse(raw);
		const cur = readJSON(item.dst, {});
		const next = { ...cur, ...repo };
		const managed = (o) => JSON.stringify(Object.fromEntries(Object.keys(repo).map((k) => [k, o[k]])));
		return { text: `${JSON.stringify(next, null, 2)}\n`, view: managed(next), curView: fs.existsSync(item.dst) ? managed(cur) : null, missing: [] };
	}
	const { out, missing } = item.tmpl ? renderTemplate(raw, vars) : { out: raw, missing: [] };
	if (item.mergeProviders && !missing.length) {
		const repo = JSON.parse(out);
		const cur = readJSON(item.dst, {});
		const next = { ...cur, ...repo, providers: { ...(cur.providers ?? {}), ...(repo.providers ?? {}) } };
		// Only the providers the repo manages are compared, so local-only ones are not drift.
		const managed = (o) => JSON.stringify(Object.fromEntries(Object.keys(repo.providers ?? {}).map((k) => [k, o.providers?.[k]])));
		return { text: `${JSON.stringify(next, null, 2)}\n`, view: managed(next), curView: fs.existsSync(item.dst) ? managed(cur) : null, missing: [] };
	}
	const cur = fs.existsSync(item.dst) ? fs.readFileSync(item.dst, "utf8") : null;
	// Compare ignoring trailing whitespace / CRLF so editor newline habits are not "drift".
	const norm = (s) => (s === null ? null : s.replace(/\r\n/g, "\n").replace(/\s*$/, "\n"));
	return { text: out, view: norm(out), curView: norm(cur), missing };
}

// ---------------------------------------------------------------- render
function render({ force = flag("--force"), dry = flag("--dry-run") } = {}) {
	const P = paths();
	const { file, vars } = loadSecrets();
	log.info(`secrets: ${file ? file : "none found (templates needing secrets are skipped)"}`);
	const state = readJSON(P.state, { files: {} });
	const res = { written: 0, same: 0, drift: [], missing: new Set() };

	for (const it of plan(P)) {
		const d = desired(it, vars);
		const label = rel(path.relative(P.home, it.dst));
		if (d.missing.length) {
			d.missing.forEach((v) => res.missing.add(v));
			log.warn(`skip ${label}: missing ${d.missing.join(", ")}`);
			continue;
		}
		if (d.curView === d.view) {
			res.same++;
			state.files[it.dst] = sha(d.view);
			continue;
		}
		// 3-way check: overwrite only if the live file is still what we last wrote.
		// A file we never managed (fresh machine, created by an installer) is adopted with a backup.
		const adopt = d.curView !== null && !(it.dst in state.files);
		const untouched = d.curView === null || adopt || state.files[it.dst] === sha(d.curView);
		if (!untouched && !force) {
			res.drift.push(label);
			log.warn(`drift ${label} (changed locally; run \`capture\` to keep it, or --force to overwrite)`);
			continue;
		}
		if (dry) {
			log.info(`would write ${label}${d.curView === null ? " (new)" : ""}`);
			continue;
		}
		if (d.curView !== null && (adopt || state.files[it.dst] !== sha(d.curView))) {
			const bak = `${it.dst}.bak-${stamp()}`;
			fs.copyFileSync(it.dst, bak);
			log.info(`backup ${rel(path.relative(P.home, bak))}`);
		}
		writeFile(it.dst, d.text, it.sensitive ? 0o600 : it.exec ? 0o755 : undefined);
		state.files[it.dst] = sha(d.view);
		res.written++;
		log.ok(`wrote ${label}`);
	}

	if (!dry) {
		writeExtras(P, vars);
		writeFile(P.state, `${JSON.stringify(state, null, 2)}\n`);
	}
	log.info(`render: ${res.written} written, ${res.same} unchanged, ${res.drift.length} drift, ${res.missing.size} missing vars`);
	return res;
}

/** Files that are not 1:1 copies of the repo. */
function writeExtras(P, vars) {
	// ontoken-auto reads its JEV key from ~/.pi/agent/secrets/typesafe_api_key (portable; no absolute keyFile path).
	const key = lookup(vars, "TYPESAFE_API_KEY");
	if (key) {
		const f = path.join(P.agent, "secrets", "typesafe_api_key");
		if (!fs.existsSync(f) || fs.readFileSync(f, "utf8").trim() !== key) {
			writeFile(f, `${key}\n`, 0o600);
			log.ok("wrote .pi/agent/secrets/typesafe_api_key");
		}
	}
	// Windows has no shebang support: add a .cmd shim that runs pr-gate through Git Bash.
	if (IS_WIN) {
		const shim = path.join(P.bin, "pr-gate.cmd");
		const body = [
			"@echo off",
			'set "PG_BASH=%ProgramFiles%\\Git\\bin\\bash.exe"',
			'if not exist "%PG_BASH%" set "PG_BASH=bash"',
			'"%PG_BASH%" "%~dp0pr-gate" %*',
			"",
		].join("\r\n");
		if (!fs.existsSync(shim) || fs.readFileSync(shim, "utf8") !== body) writeFile(shim, body);
	}
}

// ---------------------------------------------------------------- apply
function apply() {
	const P = paths();
	// Fetch secrets from the private repo when they are not on this machine yet.
	if (!loadSecrets().file && has("gh") && run("gh", ["auth", "status"]).code === 0) {
		log.info("no secrets.env yet — trying `secrets pull`");
		secretsPull({ quiet: true });
	}
	// Fresh machine: link `pi` where hc's core can find it BEFORE any terminal is spawned. The core
	// starts programs with its own PATH (no ~/.bun/bin), so `hc run … pi` fails without this.
	if (!flag("--dry-run") && !flag("--no-post")) linkPi();
	const r = render();
	if (flag("--dry-run")) return;

	if (!flag("--no-packages")) {
		if (!has("pi")) log.err("`pi` not on PATH — install Pi first (see README), then re-run apply");
		else {
			log.info("pi update --extensions (installs every package in settings.json)");
			const u = run("pi", ["update", "--extensions"], { stdio: "inherit" });
			if (u.code !== 0) log.err("pi update --extensions failed");
			const fix = path.join(P.agent, "npm", "fix-extension-peers.mjs");
			if (fs.existsSync(fix)) run(process.execPath, [fix]).code === 0 ? log.ok("fix-extension-peers") : log.warn("fix-extension-peers failed");
		}
	}

	if (!flag("--no-post")) {
		const step = (name, ok, cmd, args) => {
			if (!ok) return log.warn(`skip ${name} (${cmd} not installed)`);
			const x = run(cmd, args);
			x.code === 0 ? log.ok(name) : log.warn(`${name} failed: ${(x.err || x.out).split("\n")[0]}`);
		};
		step("hc (herdr-core)", has("hc"), "hc", ["--version"]);
		const cbm = has("codebase-memory-mcp") ? "codebase-memory-mcp" : path.join(P.bin, "codebase-memory-mcp");
		for (const [k, v] of Object.entries(CBM_CONFIG)) step(`cbm config ${k}=${v}`, has("codebase-memory-mcp") || fs.existsSync(cbm), cbm, ["config", "set", k, v]);
	}
	if (r.drift.length) log.warn(`${r.drift.length} file(s) skipped because of local drift — review, then \`apply --force\` or \`capture\``);
	doctor();
}
const CBM_CONFIG = { auto_index: "true", auto_watch: "true", ui_enabled: "false" };

/**
 * `pi` on the PATH that hc's core uses. The core inherits the login environment, which on macOS
 * does not include ~/.bun/bin (bun) or ~/.pi/agent/bin (the official installer), so an interactive
 * agent started with `hc run … pi` dies with spawn_failed. A link in ~/.local/bin (always first on
 * that PATH) fixes it for both installers.
 */
/**
 * Returns how `pi` became reachable for hc: "present" (already in ~/.local/bin),
 * "linked" (symlink / pi.cmd written), "path" (directory added to the user PATH
 * because a Windows shim cannot carry a non-ASCII path), or null (not resolvable).
 */
function linkPi() {
	const P = paths();
	const dst = path.join(P.bin, IS_WIN ? "pi.cmd" : "pi");
	const onPath = run(IS_WIN ? "where" : "sh", IS_WIN ? ["pi"] : ["-c", "command -v pi"]);
	if (onPath.code !== 0) {
		log.warn("`pi` not on PATH — hc templates cannot start an agent (install Pi first)");
		return null;
	}
	// `where` can list an extension-less npm shim first; a .cmd that calls it would fail.
	const lines = onPath.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const src = (IS_WIN ? lines.find((l) => /\.(cmd|exe)$/i.test(l)) : lines[0]) ?? lines[0];
	if (!src) {
		log.warn("could not resolve `pi` on PATH — hc templates cannot start an agent");
		return null;
	}
	if (path.dirname(src) === P.bin) return "present"; // already reachable where hc looks
	if (IS_WIN) {
		// cmd.exe reads a .cmd in the OEM code page, so a non-ASCII path cannot be embedded;
		// put its directory on the user PATH for hc's core instead (same as bootstrap.ps1).
		if (/[^\x00-\x7F]/.test(src)) {
			const dir = path.dirname(src);
			// pass the directory as data: interpolating it into PowerShell source breaks on `'` and expands `$`.
			const r = run(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					"$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($p -notlike \"*$env:PI_LINK_DIR*\") { [Environment]::SetEnvironmentVariable('Path', \"$p;$env:PI_LINK_DIR\", 'User') }",
				],
				{ env: { ...process.env, PI_LINK_DIR: dir } },
			);
			if (r.code === 0) log.ok(`${src} is not ASCII — added ${dir} to the user PATH for hc`);
			else log.warn(`${src} is not ASCII and the PATH update failed — add ${dir} to PATH by hand`);
			return r.code === 0 ? "path" : null;
		}
		const body = `@echo off\r\n"${src}" %*\r\n`;
		if (fs.existsSync(dst) && fs.readFileSync(dst, "utf8") === body) return "linked";
		writeFile(dst, body);
		log.ok(`linked ${rel(path.relative(P.home, dst))} -> ${src} (hc needs pi on its PATH)`);
		return "linked";
	}
	const cur = isLink(dst) ? fs.readlinkSync(dst) : null;
	if (cur === src) return "linked";
	if (cur === null && fs.existsSync(dst)) {
		log.warn(`${rel(path.relative(P.home, dst))} is a real file, not our link — leaving it alone`);
		return "present";
	}
	fs.mkdirSync(P.bin, { recursive: true });
	if (cur !== null) fs.rmSync(dst, { force: true });
	fs.symlinkSync(src, dst);
	log.ok(`linked ${rel(path.relative(P.home, dst))} -> ${src} (hc needs pi on its PATH)`);
	return "linked";
}
const isLink = (p) => {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------- doctor
function versionOf(cmd, args = ["--version"]) {
	const r = run(cmd, args);
	if (r.code !== 0 && r.missing) return null;
	const m = `${r.out}\n${r.err}`.match(/\d+\.\d+(\.\d+)?/);
	return m ? m[0] : r.code === 0 ? "?" : null;
}
const gte = (a, b) => {
	const x = [...a.split(".").map(Number), 0, 0];
	const y = [...b.split(".").map(Number), 0, 0];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
	return true;
};

function doctor() {
	const P = paths();
	const lock = readJSON(path.join(REPO, "packages.lock.json"), { packages: {}, tools: {} });
	const rows = [];
	const add = (level, area, item, detail) => rows.push({ level, area, item, detail });

	// tools
	const node = process.versions.node;
	add(gte(node, "22.19.0") ? "ok" : "error", "tool", "node", `${node} (need >= 22.19.0)`);
	const tools = [
		["pi", true], ["git", true], ["gh", true], ["jq", true],
		["hc", false], ["codebase-memory-mcp", false],
	];
	for (const [t, required] of tools) {
		const v = versionOf(t === "codebase-memory-mcp" && !has(t) ? path.join(P.bin, t) : t);
		const want = lock.tools?.[t];
		add(v ? (want && v !== want ? "info" : "ok") : required ? "error" : "warn", "tool", t, v ? `${v}${want && v !== want ? ` (lock ${want})` : ""}` : "not installed");
	}
	if (IS_WIN) add(has("bash") || fs.existsSync(path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")) ? "ok" : "error", "tool", "bash (Git Bash, for pr-gate)", "");
	if (has("gh")) add(run("gh", ["auth", "status"]).code === 0 ? "ok" : "warn", "tool", "gh auth", "run `gh auth login` if warn");

	// secrets
	const { file, vars } = loadSecrets();
	const need = new Set(plan(P).filter((i) => i.tmpl).flatMap((i) => templateVars(fs.readFileSync(i.src, "utf8"))));
	const miss = [...need].filter((n) => !lookup(vars, n));
	add(file ? "ok" : "warn", "secrets", "secrets.env", file ?? "not found (see SECRETS.md)");
	add(miss.length ? "error" : "ok", "secrets", "template vars", miss.length ? `missing: ${miss.join(", ")}` : `${need.size} set`);

	// files
	const state = readJSON(P.state, { files: {} });
	for (const it of plan(P)) {
		const d = desired(it, vars);
		const label = rel(path.relative(P.home, it.dst));
		if (d.curView === null) add("error", "file", label, "missing — run apply");
		else if (d.missing.length) add("warn", "file", label, "cannot verify (secrets missing)");
		else if (d.curView === d.view) continue;
		else if (!(it.dst in state.files) || state.files[it.dst] === sha(d.curView)) add("warn", "file", label, "repo is newer — run apply");
		else add("warn", "file", label, "local drift — run capture (keep) or apply --force (discard)");
	}

	// packages
	const settings = readJSON(path.join(P.agent, "settings.json"), {});
	for (const entry of settings.packages ?? []) {
		const src = packageSource(entry);
		const loc = packageDir(P, entry);
		const v = loc && fs.existsSync(loc) ? packageVersion(loc, entry) : null;
		const want = src && lock.packages?.[src];
		const label = src ?? JSON.stringify(entry);
		add(v ? (want && want !== v ? "info" : "ok") : "error", "package", label, v ? `${v}${want && want !== v ? ` (lock ${want})` : ""}` : "not installed — run `pi update --extensions`");
	}
	const repoPkgs = readJSON(path.join(REPO, "home/pi-agent/settings.json"), {}).packages ?? [];
	const localSources = new Set((settings.packages ?? []).map(packageSource).filter(Boolean));
	const repoSources = new Set(repoPkgs.map(packageSource).filter(Boolean));
	for (const entry of settings.packages ?? []) if (packageSource(entry) && !repoSources.has(packageSource(entry))) add("warn", "package", packageSource(entry), "installed locally but not in repo — run capture");
	for (const entry of repoPkgs) if (packageSource(entry) && !localSources.has(packageSource(entry))) add("warn", "package", packageSource(entry), "in repo but not in local settings — run apply");

	// tool-managed resources: hc reads the roles we ship and Pi reports its status to it over OSC 7501.
	// Count the rendered files instead of running `hc templates`: asking hc can start a core on a fresh machine.
	const tplRepo = walk(path.join(REPO, "home/herdr-core/templates")).filter((f) => f.endsWith(".md")).length;
	if (!has("hc")) add("warn", "integration", "hc templates", "hc not installed — ./bootstrap.sh");
	else {
		const tplLive = walk(path.join(P.herdrCore, "templates")).filter((f) => f.endsWith(".md")).length;
		add(tplLive >= tplRepo ? "ok" : "warn", "integration", "hc templates", `${tplLive} rendered, repo has ${tplRepo} — hc run <name>`);
	}

	if (flag("--json")) console.log(JSON.stringify(rows, null, 2));
	else {
		const color = { ok: 32, info: 36, warn: 33, error: 31 };
		for (const r of rows) console.log(`${c(color[r.level], r.level.padEnd(5))} ${r.area.padEnd(11)} ${r.item}${r.detail ? `  — ${r.detail}` : ""}`);
	}
	const errors = rows.filter((r) => r.level === "error").length;
	console.log(`\ndoctor: ${errors} error(s), ${rows.filter((r) => r.level === "warn").length} warning(s)`);
	if (errors) process.exitCode = 1;
	return rows;
}

// ---------------------------------------------------------------- packages / lock
/** Pi accepts either a package source string or an object with a `source` field. */
function packageSource(entry) {
	return typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : null;
}
function packageDir(P, entry) {
	const src = packageSource(entry);
	if (!src) return null;
	if (src.startsWith("npm:")) {
		const name = src.slice(4).replace(/(?<=.)@[^/]*$/, ""); // strip @version
		return path.join(P.agent, "npm", "node_modules", ...name.split("/"));
	}
	const m = src.replace(/^git:/, "https://").match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/@#]+?)(?:\.git)?(?:[@#].*)?$/);
	return m ? path.join(P.agent, "git", m[1], m[2], m[3]) : null;
}
function packageVersion(dir, entry) {
	const src = packageSource(entry);
	if (!src) return null;
	if (src.startsWith("npm:")) return readJSON(path.join(dir, "package.json"), {}).version ?? "?";
	const r = run("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
	const v = readJSON(path.join(dir, "package.json"), {}).version;
	return r.code === 0 ? `${v ? `${v}@` : ""}${r.out}` : "?";
}
function buildLock(P) {
	const settings = readJSON(path.join(P.agent, "settings.json"), {});
	const packages = {};
	for (const entry of settings.packages ?? []) {
		const src = packageSource(entry);
		if (!src) continue;
		const d = packageDir(P, entry);
		packages[src] = d && fs.existsSync(d) ? packageVersion(d, entry) : "not-installed";
	}
	const tools = {};
	for (const t of ["pi", "hc", "codebase-memory-mcp", "gh"]) {
		const v = versionOf(t === "codebase-memory-mcp" && !has(t) ? path.join(P.bin, t) : t);
		if (v) tools[t] = v;
	}
	return { comment: "Generated by `setup.mjs capture`. Informational pins; doctor reports differences.", packages, tools };
}
function diffLock(a, b) {
	const out = [];
	for (const k of Object.keys(b.packages)) {
		if (!(k in (a.packages ?? {}))) out.push(`added ${k} (${b.packages[k]})`);
		else if (a.packages[k] !== b.packages[k]) out.push(`updated ${k}: ${a.packages[k]} -> ${b.packages[k]}`);
	}
	for (const k of Object.keys(a.packages ?? {})) if (!(k in b.packages)) out.push(`removed ${k}`);
	for (const k of Object.keys(b.tools)) if (a.tools?.[k] && a.tools[k] !== b.tools[k]) out.push(`tool ${k}: ${a.tools[k]} -> ${b.tools[k]}`);
	return out;
}

// ---------------------------------------------------------------- capture (live -> repo)
const envName = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
const PRIVATE_HOST = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[a-z0-9-]+\.[a-z0-9-]+\.ts\.net)$/i;

/** Replace a private (LAN/Tailscale) host in a URL with ${VAR}; records the value. */
function redactHost(url, varName, found) {
	let host;
	try {
		host = new URL(url).hostname;
	} catch {
		return url;
	}
	if (!PRIVATE_HOST.test(host)) return url;
	found[varName] = host;
	return url.replace(host, `\${${varName}}`);
}
const isRef = (v) => typeof v === "string" && (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(v) || v.startsWith("!") || /^Bearer \$\{[A-Z0-9_]+\}$/.test(v));

/**
 * Providers that get captured into the repo. Everything else stays local to this machine, so a
 * plain `capture` cannot leak a personal router setup (or its keys) back into the templates.
 * Override with PI_CAPTURE_PROVIDERS="ontoken,other"; `*` captures every provider.
 */
const captureProviders = () =>
	new Set((process.env.PI_CAPTURE_PROVIDERS ?? "ontoken").split(",").map((s) => s.trim()).filter(Boolean));

/** Structural redaction per known file. Returns new text + discovered secret values. */
function redact(liveRel, text, dropped = []) {
	const found = {};
	const base = path.basename(liveRel);
	if (!liveRel.endsWith(".json")) return { text, found };
	const j = JSON.parse(text);
	if (liveRel === "settings.json") for (const k of VOLATILE_SETTINGS) delete j[k];
	if (liveRel === "ontoken-auto.json" && j.jev) {
		delete j.jev.keyFile; // replaced by ~/.pi/agent/secrets/typesafe_api_key
		if (!Object.keys(j.jev).length) delete j.jev;
	}
	if (base === "models.json") {
		const keep = captureProviders();
		for (const name of Object.keys(j.providers ?? {})) {
			if (keep.has("*") || keep.has(name)) continue;
			dropped.push(name);
			delete j.providers[name];
		}
		for (const [name, p] of Object.entries(j.providers ?? {})) {
			const v = `PI_KEY_${envName(name)}`;
			if (p.apiKey && !isRef(p.apiKey)) [found[v], p.apiKey] = [p.apiKey, `\${${v}}`];
			if (p.baseUrl) p.baseUrl = redactHost(p.baseUrl, `PI_HOST_${envName(name)}`, found);
			for (const [h, hv] of Object.entries(p.headers ?? {})) {
				if (typeof hv === "string" && !isRef(hv) && /auth|key|token|secret/i.test(h)) {
					const n = `PI_HDR_${envName(name)}_${envName(h)}`;
					[found[n], p.headers[h]] = [hv, `\${${n}}`];
				}
			}
		}
	}
	if (base === "mcp.json") {
		for (const [name, s] of Object.entries(j.mcpServers ?? {})) {
			if (s.url) s.url = redactHost(s.url, `MCP_HOST_${envName(name)}`, found);
			for (const [h, hv] of Object.entries(s.headers ?? {})) {
				if (typeof hv !== "string" || isRef(hv)) continue;
				if (/^authorization$/i.test(h)) {
					const n = `MCP_${envName(name)}_TOKEN`;
					const bearer = hv.match(/^Bearer\s+(.+)$/);
					[found[n], s.headers[h]] = bearer ? [bearer[1], `Bearer \${${n}}`] : [hv, `\${${n}}`];
				} else if (/key|token|secret|cookie/i.test(h)) {
					const n = `MCP_${envName(name)}_${envName(h)}`;
					[found[n], s.headers[h]] = [hv, `\${${n}}`];
				}
			}
			for (const [k, ev] of Object.entries(s.env ?? {})) {
				if (typeof ev === "string" && !isRef(ev) && /key|token|secret|pass/i.test(k)) {
					const n = `MCP_${envName(name)}_${envName(k)}`;
					[found[n], s.env[k]] = [ev, `\${${n}}`];
				}
			}
		}
	}
	if (base === "web-search.json") {
		const visit = (o, pfx) => {
			for (const [k, v] of Object.entries(o)) {
				if (v && typeof v === "object") visit(v, `${pfx}_${envName(k)}`);
				else if (typeof v === "string" && !isRef(v) && /key|token|secret/i.test(k)) {
					const n = `WEBSEARCH${pfx}_${envName(k)}`;
					[found[n], o[k]] = [v, `\${${n}}`];
				}
			}
		};
		visit(j, "");
	}
	if (liveRel === "config.json" && j.relay) j.relay = redactHost(j.relay, "REMOTE_PI_RELAY_HOST", found);
	return { text: `${JSON.stringify(j, null, liveRel === "settings.json" ? 2 : detectIndent(text))}\n`, found };
}
const detectIndent = (t) => (t.match(/^\{\n(\t| +)/)?.[1] ?? "  ");

function capture() {
	const P = paths();
	const dry = flag("--dry-run");
	const { file: secFile, vars } = loadSecrets();
	const newSecrets = {};
	const changes = [];
	const seen = new Set();
	const dropped = [];

	for (const m of mappings(P)) {
		const liveFiles = new Set(m.files.filter((f) => fs.existsSync(path.join(m.live, f))));
		for (const d of m.dirs) for (const f of walk(path.join(m.live, d))) liveFiles.add(`${d}/${f}`);
		for (const f of liveFiles) {
			if (IGNORE.some((r) => r.test(f))) continue;
			const raw = fs.readFileSync(path.join(m.live, f), "utf8");
			const { text, found } = redact(f, raw, dropped);
			Object.assign(newSecrets, found);
			// Only files we redacted become templates (scripts like pr-gate use ${VAR} legitimately).
			const isTmpl = Object.keys(found).length > 0;
			const target = path.join(REPO, m.repo, isTmpl ? `${f}.tmpl` : f);
			const other = path.join(REPO, m.repo, isTmpl ? f : `${f}.tmpl`);
			seen.add(target);
			const cur = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
			if (cur !== text) {
				changes.push(`${cur === null ? "add" : "update"} ${m.repo}/${f}${isTmpl ? ".tmpl" : ""}`);
				if (!dry) writeFile(target, text, m.exec ? 0o755 : undefined);
			}
			if (fs.existsSync(other) && !dry) fs.rmSync(other);
		}
		// repo files that no longer exist live
		for (const f of walk(path.join(REPO, m.repo))) {
			const abs = path.join(REPO, m.repo, f);
			if (seen.has(abs)) continue;
			changes.push(`${flag("--prune") ? "remove" : "stale (use --prune)"} ${m.repo}/${f}`);
			if (flag("--prune") && !dry) fs.rmSync(abs);
		}
	}

	// typesafe key for ontoken-auto
	const ts = process.env.TYPESAFE_API_KEY || (fs.existsSync(path.join(P.agent, "secrets", "typesafe_api_key")) ? fs.readFileSync(path.join(P.agent, "secrets", "typesafe_api_key"), "utf8").trim() : "");
	if (ts) newSecrets.TYPESAFE_API_KEY = ts;

	// secrets.env (local only): add new names / changed values; report names only.
	const merged = { ...vars };
	const secChanges = [];
	for (const [k, v] of Object.entries(newSecrets)) if (merged[k] !== v) [merged[k], secChanges[secChanges.length]] = [v, `${k in vars ? "changed" : "new"} ${k}`];
	if (secChanges.length && !dry) writeSecrets(secFile ?? P.secrets, merged);

	// lock + changelog
	const lockFile = path.join(REPO, "packages.lock.json");
	const oldLock = readJSON(lockFile, { packages: {}, tools: {} });
	const newLock = buildLock(P);
	const lockDiff = diffLock(oldLock, newLock);
	if (!dry) {
		writeFile(lockFile, `${JSON.stringify(newLock, null, 2)}\n`);
		if (lockDiff.length) {
			const cl = path.join(REPO, "CHANGELOG.md");
			const old = fs.existsSync(cl) ? fs.readFileSync(cl, "utf8") : "# Changelog\n";
			const entry = `\n## ${new Date().toISOString().slice(0, 10)} (capture)\n\n${lockDiff.map((l) => `- ${l}`).join("\n")}\n`;
			fs.writeFileSync(cl, old.replace(/^# Changelog\n/, `# Changelog\n${entry}`));
		}
	}

	changes.forEach((x) => log.info(x));
	if (dropped.length) log.info(`providers kept local (PI_CAPTURE_PROVIDERS=${process.env.PI_CAPTURE_PROVIDERS ?? "ontoken"}): ${[...new Set(dropped)].sort().join(", ")}`);
	lockDiff.forEach((x) => log.info(`lock: ${x}`));
	secChanges.forEach((x) => log.warn(`secrets.env: ${x} — run \`secrets push\` to update the private store`));
	if (!changes.length && !lockDiff.length) log.ok("repo already matches this machine");
	const hits = scan({ quiet: true });
	if (hits) {
		log.err(`secret scan found ${hits} issue(s) after capture — fix before committing (node scripts/setup.mjs scan)`);
		process.exitCode = 1;
	} else log.ok("secret scan clean");
	// keep the render state in sync so the next `apply` does not report drift for captured files
	if (!dry) {
		const state = readJSON(P.state, { files: {} });
		for (const it of plan(P)) {
			const d = desired(it, merged);
			if (!d.missing.length && d.curView !== null) state.files[it.dst] = sha(d.curView);
		}
		writeFile(P.state, `${JSON.stringify(state, null, 2)}\n`);
	}
}

// ---------------------------------------------------------------- scan
const RULES = [
	["literal apiKey", /"apiKey"\s*:\s*"(?!\$\{|\$[A-Z_]|!)[^"]+"/],
	["literal bearer token", /Bearer\s+(?!\$\{|\$[A-Z_]|<)[A-Za-z0-9._~+/-]{12,}/],
	["sk- style key", /\bsk-[A-Za-z0-9_-]{20,}/],
	["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
	["hindsight token", /\bhs-local-[A-Za-z0-9]{6,}/],
	["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["Tailscale IP", /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
	["absolute home path", /\/Users\/[a-z][\w.-]+\/|\/home\/[a-z][\w.-]+\/|C:\\\\?Users\\\\?[A-Za-z]/],
];
function repoFiles() {
	const r = run("git", ["-C", REPO, "ls-files", "-co", "--exclude-standard"]);
	const list = r.code === 0 && r.out ? r.out.split("\n") : walk(REPO).filter((f) => !f.startsWith(".git/"));
	return list.filter((f) => fs.existsSync(path.join(REPO, f)));
}
function scan({ quiet = false } = {}) {
	const { vars } = loadSecrets();
	const known = Object.entries(vars).filter(([, v]) => v.length >= 8);
	let hits = 0;
	for (const f of repoFiles()) {
		const text = fs.readFileSync(path.join(REPO, f), "utf8");
		const lines = text.split("\n");
		// setup.mjs holds the rule regexes + synthetic test data: check it for real values only.
		if (f !== "scripts/setup.mjs") lines.forEach((line, i) => {
			for (const [name, re] of RULES) if (re.test(line)) [hits] = [hits + 1, log.err(`${f}:${i + 1} ${name}`)];
		});
		for (const [k, v] of known) if (text.includes(v)) [hits] = [hits + 1, log.err(`${f}: contains the value of ${k}`)];
	}
	if (!quiet) hits ? log.err(`${hits} finding(s)`) : log.ok(`scan clean (${repoFiles().length} files, ${known.length} known secret values checked)`);
	if (!quiet && hits) process.exitCode = 1;
	return hits;
}

// ---------------------------------------------------------------- secrets store (private GitHub repo)
const SECRETS_REPO = process.env.PI_SETUP_SECRETS_REPO || "priaculun/pi-setup-secrets";
function secretsPull({ quiet = false } = {}) {
	const P = paths();
	const r = run("gh", ["api", `repos/${SECRETS_REPO}/contents/secrets.env`, "-H", "Accept: application/vnd.github.raw"]);
	if (r.code !== 0) {
		(quiet ? log.warn : log.err)(`cannot read ${SECRETS_REPO}/secrets.env via gh (${r.err.split("\n")[0]})`);
		if (!quiet) process.exitCode = 1;
		return false;
	}
	writeFile(P.secrets, `${r.out}\n`, 0o600);
	log.ok(`secrets pulled -> ${P.secrets} (${Object.keys(parseEnv(r.out)).length} vars)`);
	return true;
}
function secretsPush() {
	const { file } = loadSecrets();
	if (!file) return log.err("no secrets.env to push");
	const exists = run("gh", ["api", `repos/${SECRETS_REPO}`, "--jq", ".private"]);
	if (exists.code !== 0) return log.err(`${SECRETS_REPO} not found — create it: gh repo create ${SECRETS_REPO} --private`);
	if (exists.out !== "true") return log.err(`${SECRETS_REPO} is NOT private — refusing to push`);
	const cur = run("gh", ["api", `repos/${SECRETS_REPO}/contents/secrets.env`, "--jq", ".sha"]);
	const content = fs.readFileSync(file).toString("base64");
	const body = JSON.stringify({ message: `secrets: update ${new Date().toISOString().slice(0, 10)}`, content, ...(cur.code === 0 ? { sha: cur.out } : {}) });
	const r = run("gh", ["api", "-X", "PUT", `repos/${SECRETS_REPO}/contents/secrets.env`, "--input", "-"], { input: body });
	r.code === 0 ? log.ok(`pushed secrets.env to ${SECRETS_REPO}`) : log.err(`push failed: ${r.err.split("\n")[0]}`);
}
function secretsCheck() {
	const { file, vars } = loadSecrets();
	const need = new Set(plan().filter((i) => i.tmpl).flatMap((i) => templateVars(fs.readFileSync(i.src, "utf8"))));
	need.add("TYPESAFE_API_KEY");
	log.info(`secrets file: ${file ?? "none"}`);
	for (const n of [...need].sort()) (lookup(vars, n) ? log.ok : log.err)(`${n}${lookup(vars, n) ? "" : " missing"}`);
	for (const n of Object.keys(vars).filter((n) => !need.has(n))) log.info(`${n} unused by templates`);
}

// ---------------------------------------------------------------- reset
/** Running Pi processes (excluding us). Best effort: [] if the process list is unavailable. */
function runningPi() {
	const r = IS_WIN
		? run("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"])
		: run("ps", ["-Ao", "pid=,args="]);
	if (r.code !== 0) return [];
	const re = /pi-coding-agent|(^|[\\/\s])pi(\.cmd|\.exe)?(\s|$)/;
	return r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => {
		const pid = Number(l.split(/\s+/)[0]);
		return pid && pid !== process.pid && pid !== process.ppid && re.test(l.slice(String(pid).length)) && !l.includes("setup.mjs");
	});
}

/**
 * Entries of the agent dir that belong to the Pi installation itself, not to the config.
 * The official installer (pi.dev/install.sh|ps1) uses bin/ (launcher), install/ (releases +
 * current-version) and, on Windows, win-git-bash/. Kept only if they exist.
 */
const PI_INSTALL_ENTRIES = ["bin", "install", "win-git-bash"];
function piInstallEntries(dir) {
	return PI_INSTALL_ENTRIES.filter((e) => fs.existsSync(path.join(dir, e)));
}

function moveInto(src, dst) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	try {
		fs.renameSync(src, dst);
	} catch (e) {
		if (e.code !== "EXDEV") throw e; // different filesystem: copy, then delete
		fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
		fs.rmSync(src, { recursive: true, force: true });
	}
}

/**
 * Clean slate before apply. Nothing is deleted: old config moves to ~/.pi-backup-<stamp>/.
 * Kept in place: the Pi install itself (bin/, install/, win-git-bash/ of the official installer), ~/.pi/remote (phone pairing),
 * secrets.env. Removed: state.json (so render treats the machine as new).
 */
function reset({ dry = flag("--dry-run"), yes = flag("--yes") } = {}) {
	const P = paths();
	const busy = process.env.PI_SETUP_HOME ? [] : runningPi();
	if (busy.length && !yes) {
		log.err(`Pi is running (${busy.length} process(es)) — close every pi session, or rerun with --yes:`);
		busy.slice(0, 5).forEach((l) => console.log(`      ${l.slice(0, 120)}`));
		process.exitCode = 1;
		return null;
	}
	const backup = path.join(P.home, `.pi-backup-${stamp()}`);
	const keep = fs.existsSync(P.agent) ? piInstallEntries(P.agent) : [];
	const moves = [];
	if (fs.existsSync(P.agent)) {
		for (const e of fs.readdirSync(P.agent)) {
			if (keep.includes(e)) continue;
			moves.push([path.join(P.agent, e), path.join(backup, "agent", e)]);
		}
	}
	const hcCfg = path.join(P.herdrCore, "config.toml");
	if (fs.existsSync(hcCfg)) moves.push([hcCfg, path.join(backup, "herdr-core", "config.toml")]);

	log.info(`${dry ? "[dry-run] " : ""}backup -> ${backup}`);
	if (keep.length) log.info(`keep  ${keep.map((e) => path.join(P.agent, e)).join(", ")} (Pi install)`);
	log.info(`keep  ${P.remote} (remote-pi pairing), ${P.secrets}`);
	for (const [src, dst] of moves) {
		log.info(`move  ${path.relative(P.home, src)}`);
		if (!dry) moveInto(src, dst);
	}
	if (fs.existsSync(P.state)) {
		log.info(`remove ${path.relative(P.home, P.state)}`);
		if (!dry) fs.rmSync(P.state);
	}
	if (dry) return { backup, moves, keep };
	if (moves.length) {
		writeFile(path.join(backup, "README.txt"),
			`pi-setup reset backup (${new Date().toISOString()})\n` +
			`agent/  = old ${P.agent}\nherdr-core/  = old ${P.herdrCore}\n` +
			`Restore sessions: copy agent/sessions back into ${P.agent}/sessions\n`);
		log.ok(`reset done: ${moves.length} item(s) moved to ${backup}`);
	} else log.ok("reset: nothing to move");
	log.info("next: ./bootstrap.sh (Windows: bootstrap.ps1) or node scripts/setup.mjs apply");
	return { backup, moves, keep };
}

// ---------------------------------------------------------------- selftest
function selftest() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-setup-"));
	process.env.PI_SETUP_HOME = tmp;
	const P = paths();
	// fake values for every placeholder
	const names = new Set(plan(P).filter((i) => i.tmpl).flatMap((i) => templateVars(fs.readFileSync(i.src, "utf8"))));
	const fake = Object.fromEntries([...names, "TYPESAFE_API_KEY"].map((n) => [n, n.includes("HOST") ? "10.0.0.1" : `test-${n.toLowerCase()}`]));
	writeSecrets(P.secrets, fake);
	let fail = 0;
	const r1 = render({ force: false, dry: false });
	if (r1.missing.size || r1.drift.length) [fail] = [fail + 1, log.err("first render incomplete")];
	for (const it of plan(P)) {
		const t = fs.readFileSync(it.dst, "utf8");
		if (PLACEHOLDER.test(t)) [fail] = [fail + 1, log.err(`placeholder left in ${it.liveRel}`)];
		PLACEHOLDER.lastIndex = 0;
		if (it.dst.endsWith(".json")) {
			try {
				JSON.parse(t);
			} catch (e) {
				[fail] = [fail + 1, log.err(`invalid JSON ${it.liveRel}: ${e.message}`)];
			}
		}
	}
	// idempotent: second render writes nothing
	if (render().written !== 0) [fail] = [fail + 1, log.err("second render was not a no-op")];
	// drift protection: local edit must not be overwritten without --force
	const agentsMd = path.join(P.agent, "AGENTS.md");
	fs.appendFileSync(agentsMd, "\nlocal edit\n");
	const st = readJSON(P.state, { files: {} });
	st.files[agentsMd] = "stale";
	writeFile(P.state, JSON.stringify(st));
	if (!render().drift.length || !fs.readFileSync(agentsMd, "utf8").includes("local edit")) [fail] = [fail + 1, log.err("drift was overwritten")];
	// missing secret -> template skipped, nothing half-rendered
	writeSecrets(P.secrets, {});
	fs.rmSync(path.join(P.agent, "models.json"), { force: true });
	const saved = Object.fromEntries([...names].map((n) => [n, process.env[n]]));
	for (const n of names) delete process.env[n];
	if (!render().missing.size || fs.existsSync(path.join(P.agent, "models.json"))) [fail] = [fail + 1, log.err("missing secrets did not block template")];
	Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
	// redaction round-trip on a synthetic models/mcp file
	const sample = JSON.stringify({ providers: { "x-y": { baseUrl: "http://100.100.1.2:4000/v1", apiKey: "sk-abcdefghijklmnopqrstuvwxyz" } } });
	process.env.PI_CAPTURE_PROVIDERS = "*";
	const red = redact("models.json", sample);
	if (red.text.includes("sk-abc") || red.text.includes("100.100") || red.found.PI_KEY_X_Y !== "sk-abcdefghijklmnopqrstuvwxyz" || red.found.PI_HOST_X_Y !== "100.100.1.2") [fail] = [fail + 1, log.err("redaction failed")];
	delete process.env.PI_CAPTURE_PROVIDERS;
	// only the allowlisted provider survives capture; the rest never reach the repo
	const two = JSON.stringify({ providers: { ontoken: { baseUrl: "https://api.ontoken.id/v1", apiKey: "sk-abcdefghijklmnopqrstuvwxyz" }, local: { baseUrl: "http://10.0.0.2:4000/v1", apiKey: "sk-localonlykey000000000000" } } });
	const drop = [];
	const one = redact("models.json", two, drop);
	const parsed = JSON.parse(one.text);
	if (Object.keys(parsed.providers).join() !== "ontoken" || drop.join() !== "local" || "PI_KEY_LOCAL" in one.found) [fail] = [fail + 1, log.err("provider allowlist failed")];
	const mcp = redact("mcp.json", JSON.stringify({ mcpServers: { a: { url: "https://x.dev/mcp", headers: { Authorization: "Bearer hs-local-zzz" } } } }));
	if (mcp.text.includes("hs-local") || !mcp.text.includes("Bearer ${MCP_A_TOKEN}")) [fail] = [fail + 1, log.err("mcp redaction failed")];
	// package entries may be objects (e.g. remote-pi with a filtered extension)
	if (packageSource("npm:x") !== "npm:x" || packageSource({ source: "npm:y", extensions: ["-dist/index.js"] }) !== "npm:y" || packageSource({}) !== null) [fail] = [fail + 1, log.err("package entry normalization failed")];
	// hc role templates ship in the repo: they must render with a usable command, or `hc run <name>` breaks
	const tplDir = path.join(P.herdrCore, "templates");
	for (const name of ["worker", "reviewer", "planner"]) {
		const t = fs.existsSync(path.join(tplDir, `${name}.md`)) ? fs.readFileSync(path.join(tplDir, `${name}.md`), "utf8").replace(/\r\n/g, "\n") : "";
		const cmd = t.match(/^command:\s*(.+)$/m)?.[1] ?? "";
		if (!cmd.startsWith("pi ") || !cmd.includes("--model ")) [fail] = [fail + 1, log.err(`hc template ${name}: needs a \`command: pi --model <provider/model>\``)];
		if (!/^---\n[\s\S]*?\n---\n/.test(t)) [fail] = [fail + 1, log.err(`hc template ${name}: frontmatter missing`)];
		// a template body is expanded by the CHILD's shell: `$HC_TERMINAL_ID` there reports into itself
		if (/hc send\s+\$HC_TERMINAL_ID/.test(t)) [fail] = [fail + 1, log.err(`hc template ${name}: report to the parent, not to $HC_TERMINAL_ID`)];
	}
	// `pi` must be reachable where hc's core looks (~/.local/bin is first on its PATH)
	if (has("pi")) {
		const linked = linkPi();
		if (!linked) [fail] = [fail + 1, log.err("linkPi could not make pi reachable for hc")];
		else if (linked === "linked" && !isLink(path.join(P.bin, IS_WIN ? "pi.cmd" : "pi")) && !fs.existsSync(path.join(P.bin, IS_WIN ? "pi.cmd" : "pi"))) [fail] = [fail + 1, log.err("linkPi reported a link it did not create")];
	}
	// models.json: providers kept local to this machine survive render/apply
	const models = path.join(P.agent, "models.json");
	const before = readJSON(models, {}).providers ?? {};
	const localOnly = Object.keys(before).filter((k) => !captureProviders().has("*") && !captureProviders().has(k));
	const savedProviders = Object.fromEntries(localOnly.map((k) => [k, before[k]]));
	fs.writeFileSync(models, JSON.stringify({ ...readJSON(models, {}), providers: { local: { apiKey: "sk-localonly0000000000000000" }, ontoken: {} } }));
	const stm = readJSON(P.state, { files: {} });
	delete stm.files[models];
	writeFile(P.state, JSON.stringify(stm));
	const r4 = render();
	const after = readJSON(models, {}).providers ?? {};
	if (r4.drift.includes(".pi/agent/models.json") || !("local" in after) || !("ontoken" in after)) [fail] = [fail + 1, log.err("render dropped a local-only provider")];
	if (render().written !== 0 || !("local" in (readJSON(models, {}).providers ?? {}))) [fail] = [fail + 1, log.err("merge render is not idempotent")];
	fs.writeFileSync(models, JSON.stringify({ ...readJSON(models, {}), providers: { ...after, ...savedProviders } }));
	// reset: everything moves to the backup, remote + secrets stay, re-render works from scratch
	writeSecrets(P.secrets, fake);
	writeFile(path.join(P.agent, "sessions", "s1.jsonl"), "{}\n");
	writeFile(path.join(P.remote, "peers.json"), "{}");
	writeFile(path.join(P.agent, "bin", "pi"), "#!/bin/sh\n");
	writeFile(path.join(P.agent, "install", "current-version"), "1.4.0\n");
	const dryRes = reset({ dry: true, yes: true });
	if (!fs.existsSync(path.join(P.agent, "AGENTS.md")) || !dryRes.moves.length) [fail] = [fail + 1, log.err("reset --dry-run changed files")];
	const rs = reset({ dry: false, yes: true });
	const leftover = fs.existsSync(P.agent) ? fs.readdirSync(P.agent).sort() : [];
	if (leftover.join() !== "bin,install") [fail] = [fail + 1, log.err(`reset left: ${leftover.join(", ")}`)];
	if (!fs.existsSync(path.join(rs.backup, "agent", "sessions", "s1.jsonl"))) [fail] = [fail + 1, log.err("reset lost sessions")];
	if (!fs.existsSync(path.join(rs.backup, "herdr-core", "config.toml"))) [fail] = [fail + 1, log.err("reset missed herdr-core config")];
	if (!fs.existsSync(path.join(P.remote, "peers.json")) || !fs.existsSync(P.secrets) || fs.existsSync(P.state)) [fail] = [fail + 1, log.err("reset touched remote/secrets or kept state")];
	const r3 = render({ force: false, dry: false });
	if (r3.drift.length || r3.missing.size || !fs.existsSync(path.join(P.agent, "models.json"))) [fail] = [fail + 1, log.err("render after reset failed")];
	fs.rmSync(tmp, { recursive: true, force: true });
	fail ? (log.err(`selftest: ${fail} failure(s)`), (process.exitCode = 1)) : log.ok("selftest passed");
}

// ---------------------------------------------------------------- main
const cmd = argv[0];
const sub = argv[1];
switch (cmd) {
	case "apply": apply(); break;
	case "render": render(); break;
	case "doctor": doctor(); break;
	case "capture": capture(); break;
	case "scan": scan(); break;
	case "reset": reset(); break;
	case "selftest": selftest(); break;
	case "secrets":
		if (sub === "pull") secretsPull();
		else if (sub === "push") secretsPush();
		else if (sub === "check") secretsCheck();
		else if (sub === "path") console.log(paths().secrets);
		else if (sub === "init") {
			// Same as capture's secret extraction, without touching the repo.
			const P = paths();
			const found = {};
			for (const m of mappings(P)) for (const f of m.files) {
				const p = path.join(m.live, f);
				if (fs.existsSync(p)) Object.assign(found, redact(f, fs.readFileSync(p, "utf8")).found);
			}
			const ts = process.env.TYPESAFE_API_KEY;
			if (ts) found.TYPESAFE_API_KEY = ts;
			const { vars } = loadSecrets();
			writeSecrets(P.secrets, { ...vars, ...found });
			log.ok(`wrote ${P.secrets}: ${Object.keys({ ...vars, ...found }).sort().join(", ")}`);
		} else console.log("usage: secrets <init|pull|push|check|path>");
		break;
	default:
		console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
		if (cmd) process.exitCode = 2;
}
