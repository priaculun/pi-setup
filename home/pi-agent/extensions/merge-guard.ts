/**
 * merge-guard — blocks agents from merging or pushing to protected branches
 * any way other than `pr-gate merge`.
 *
 * Replaces server-side branch protection (unavailable for private repos on
 * GitHub Free). Only *agent* tool calls are inspected: commands the user types
 * with `!cmd` in pi go through `user_bash`, not `tool_call`, so the human can
 * still run e.g. `!pr-gate approve 12`.
 *
 * Best effort: a determined agent could hide a command in a script file. The
 * guard stops the normal paths; pr-gate's SHA-pinned checks stop the rest.
 *
 * Commands: /merge-guard [status|off|on]  (off lasts for this session only)
 */
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROTECTED = new Set(
	(process.env.MERGE_GUARD_PROTECTED ?? "main,master,production,release").split(",").map((s) => s.trim()).filter(Boolean),
);

export type Verdict = { block: false } | { block: true; reason: string };
type BranchOf = (dir: string) => string | undefined;

function currentBranch(dir: string): string | undefined {
	try {
		return execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined; // not a repo / detached HEAD
	}
}

/** Split a shell command into simple segments (on ; && || | and newlines). */
function segments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Rough tokenizer: whitespace split with simple quote stripping. */
function tokens(segment: string): string[] {
	return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
}

function refTarget(spec: string): string {
	const target = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
	return target.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

const block = (reason: string): Verdict => ({ block: true, reason: `merge-guard: ${reason}` });

/** Inspect one `git push` invocation (tokens start right after `push`). */
function checkPush(args: string[], dir: string, branchOf: BranchOf): Verdict {
	const opts = args.filter((a) => a.startsWith("-"));
	const positional = args.filter((a) => !a.startsWith("-"));
	if (opts.some((o) => o === "--all" || o === "--mirror")) return block("`git push --all/--mirror` is not allowed.");
	const plainForce = opts.some((o) => o === "-f" || o === "--force" || /^-[a-z]*f[a-z]*$/.test(o));
	if (plainForce || positional.slice(1).some((p) => p.startsWith("+"))) {
		return block("plain force push is not allowed; use `git push --force-with-lease` on your own branch.");
	}
	const refspecs = positional.slice(1); // positional[0] is the remote
	const targets = refspecs.length > 0 ? refspecs.map(refTarget) : [branchOf(dir) ?? ""];
	const hit = targets.find((t) => t === "HEAD" ? PROTECTED.has(branchOf(dir) ?? "") : PROTECTED.has(t));
	if (hit !== undefined) {
		return block(
			`pushing to a protected branch (${hit === "HEAD" || hit === "" ? branchOf(dir) : hit}) is not allowed. ` +
				"Push your task branch and open a PR; merges go through `pr-gate merge <pr>`.",
		);
	}
	return { block: false };
}

/** Pure decision function (exported for tests). */
export function checkCommand(command: string, cwd: string, branchOf: BranchOf = currentBranch): Verdict {
	// Forging review/human approval markers or labels.
	if (/pr-gate-human|human:approved/.test(command)) {
		return block("human approval can only be given by the user (`!pr-gate approve <pr>` typed in pi).");
	}
	if (/--add-label[\s=]+["']?[^\s"']*review:/.test(command) || /pr-gate-review\s+sha=/.test(command)) {
		return block("record reviews with `pr-gate review <pr> approve|changes --body ...`, not by editing labels/markers.");
	}

	let dir = cwd;
	for (const seg of segments(command)) {
		const t = tokens(seg);
		if (t.length === 0) continue;

		// Track `cd` so a bare `git push` is resolved against the right repo.
		if (t[0] === "cd" && t[1]) {
			dir = isAbsolute(t[1]) ? t[1] : resolve(dir, t[1].replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
			continue;
		}

		// pr-gate: everything allowed except the human-only command.
		const pg = t.findIndex((x) => /(^|\/)pr-gate$/.test(x));
		if (pg >= 0) {
			const sub = t.slice(pg + 1).filter((x, i, a) => !x.startsWith("-") && a[i - 1] !== "-R" && a[i - 1] !== "--repo")[0];
			if (sub === "approve") return block("`pr-gate approve` is human-only; ask the user to run it.");
			continue;
		}

		// gh pr merge / API merges / auto-merge.
		const gh = t.findIndex((x) => /(^|\/)gh$/.test(x));
		if (gh >= 0) {
			const rest = t.slice(gh + 1);
			if (rest[0] === "pr" && rest[1] === "merge") return block("use `pr-gate merge <pr>` instead of `gh pr merge`.");
			if (rest[0] === "api") {
				const joined = rest.join(" ");
				if (/\/pulls\/\d+\/merge\b|\/merges\b/.test(joined) || /mergePullRequest|enablePullRequestAutoMerge|mergeBranch/.test(joined)) {
					return block("merging through the GitHub API is not allowed; use `pr-gate merge <pr>`.");
				}
				if (/git\/refs\/heads\/([\w./-]+)/.test(joined) && /-X\s*(PATCH|DELETE|PUT|POST)|--method\s*(PATCH|DELETE|PUT|POST)/i.test(joined)) {
					const ref = joined.match(/git\/refs\/heads\/([\w./-]+)/)?.[1] ?? "";
					if (PROTECTED.has(ref)) return block(`modifying refs/heads/${ref} through the API is not allowed.`);
				}
			}
			continue;
		}

		// git [-C dir] [-c k=v]... push ...
		const g = t.findIndex((x) => /(^|\/)git$/.test(x));
		if (g >= 0) {
			let i = g + 1;
			let gdir = dir;
			while (i < t.length && t[i].startsWith("-")) {
				if (t[i] === "-C" && t[i + 1]) {
					gdir = isAbsolute(t[i + 1]) ? t[i + 1] : resolve(dir, t[i + 1]);
					i += 2;
				} else if (t[i] === "-c") i += 2;
				else i += 1;
			}
			if (t[i] === "push") {
				const v = checkPush(t.slice(i + 1), gdir, branchOf);
				if (v.block) return v;
			}
		}
	}
	return { block: false };
}

export default function mergeGuard(pi: ExtensionAPI) {
	let enabled = true;

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return undefined;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;
		const verdict = checkCommand(command, ctx.cwd);
		if (!verdict.block) return undefined;
		if (ctx.hasUI) ctx.ui.notify(verdict.reason, "warning");
		return { block: true, reason: verdict.reason };
	});

	pi.registerCommand("merge-guard", {
		description: "merge-guard status | off (this session) | on",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off") enabled = false;
			else if (arg === "on") enabled = true;
			ctx.ui.notify(`merge-guard: ${enabled ? "ON" : "OFF (this session)"} · protected: ${[...PROTECTED].join(", ")}`, enabled ? "info" : "warning");
		},
	});
}
