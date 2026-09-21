import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { StructuredPatchHunk } from "diff";
import { parsePatch } from "diff";
import type { DiffChunk, DiffSnapshot } from "../src/contracts.ts";

const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 8000;
const MAX_CHUNKS = 2048;
const sensitive =
	/^(?:\.env(?:\..*)?|\.envrc|auth\.json|\.(?:npmrc|netrc|pypirc|ssh|aws|azure|gnupg|docker|kube|git|git-credentials|jj)|(?:secrets?|credentials?|tokens?)(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)$/;
const exec = promisify(execFile);

function safePath(path: string): boolean {
	return (
		path.length > 0 &&
		path.length <= 4096 &&
		!/[\\\p{Cc}]/u.test(path) &&
		!isAbsolute(path) &&
		path.split("/").every((part) => part && part !== "." && part !== ".." && !sensitive.test(part))
	);
}

function selected(path: string, oldPath: string, paths: readonly string[]): boolean {
	return (
		!paths.length ||
		paths.some((scope) =>
			[path, oldPath].some((name) => name === scope || name.startsWith(`${scope}/`)),
		)
	);
}

function sections(patch: string): string[] {
	const result: string[] = [];
	let start = 0,
		offset = 0,
		old = 0,
		next = 0;
	let fileHeader = false;
	for (const line of patch.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		if (old > 0 || next > 0) {
			if (line[0] === " " || line[0] === "-" || line === "\n") old--;
			if (line[0] === " " || line[0] === "+" || line === "\n") next--;
		} else {
			const boundary =
				/^(?:diff --git |Index: |diff --cc |diff --combined )/.test(line) ||
				(fileHeader && line.startsWith("--- "));
			if (boundary && offset > start) {
				result.push(patch.slice(start, offset));
				start = offset;
				fileHeader = false;
			}
			if (line.startsWith("--- ")) fileHeader = true;
			const header = hunkHeader.exec(line.replace(/\n$/, ""));
			if (header) {
				old = Number(header[2] ?? 1);
				next = Number(header[4] ?? 1);
			}
		}
		offset += line.length;
	}
	if (offset > start) result.push(patch.slice(start));
	return result;
}

function at<T>(items: readonly T[], index: number): T {
	const item = items.at(index);
	if (item === undefined) throw new Error("Invalid diff index");
	return item;
}

function chunksForHunk(
	prefix: string,
	heading: string,
	hunk: StructuredPatchHunk,
): Omit<DiffChunk, "id" | "path" | "oldPath">[] {
	const rows: string[] = [];
	for (const line of hunk.lines) {
		if (line === "\\ No newline at end of file") {
			if (!rows.length || at(rows, -1).includes("\n")) throw new Error("Invalid newline marker");
			rows[rows.length - 1] += `\n${line}`;
		} else if (/^[ +-]/.test(line) || line === "") rows.push(line || " ");
		else throw new Error("Invalid diff row");
	}
	const old = [0],
		next = [0],
		sizes = [0],
		added = [0],
		deleted = [0];
	for (const row of rows) {
		old.push(at(old, -1) + (row[0] !== "+" ? 1 : 0));
		next.push(at(next, -1) + (row[0] !== "-" ? 1 : 0));
		added.push(at(added, -1) + (row[0] === "+" ? 1 : 0));
		deleted.push(at(deleted, -1) + (row[0] === "-" ? 1 : 0));
		sizes.push(at(sizes, -1) + Buffer.byteLength(row) + 1);
	}
	if (old.at(-1) !== hunk.oldLines || next.at(-1) !== hunk.newLines)
		throw new Error("Invalid hunk ranges");
	const render = (start: number, end: number) => {
		const oldLines = at(old, end) - at(old, start);
		const newLines = at(next, end) - at(next, start);
		const oldStart = hunk.oldStart + at(old, start) - (oldLines ? 0 : 1);
		const newStart = hunk.newStart + at(next, start) - (newLines ? 0 : 1);
		return {
			oldStart,
			newStart,
			oldLines,
			newLines,
			added: at(added, end) - at(added, start),
			deleted: at(deleted, end) - at(deleted, start),
			patch: `${prefix}@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${heading}\n${rows.slice(start, end).join("\n")}\n`,
		};
	};
	const complete = render(0, rows.length);
	if (Buffer.byteLength(complete.patch) <= MAX_CHUNK_BYTES) return [complete];
	const budget = MAX_CHUNK_BYTES - Buffer.byteLength(prefix + heading) - 100;
	if (budget < 1 || rows.some((_, i) => at(sizes, i + 1) - at(sizes, i) > budget))
		throw new Error("Oversized diff row or heading");
	const runStart: number[] = [],
		runEnd: number[] = [];
	for (let start = 0; start < rows.length; ) {
		let end = start + 1;
		if (at(rows, start)[0] !== " ") while (end < rows.length && at(rows, end)[0] !== " ") end++;
		for (let i = start; i < end; i++) {
			runStart[i] = start;
			runEnd[i] = end;
		}
		start = end;
	}
	const chunks: ReturnType<typeof render>[] = [];
	for (let start = 0; start < rows.length; ) {
		let end = start;
		while (end < rows.length && at(sizes, end + 1) - at(sizes, start) <= budget) end++;
		if (
			end < rows.length &&
			at(runStart, end) > start &&
			at(sizes, at(runEnd, end)) - at(sizes, at(runStart, end)) <= budget
		)
			end = at(runStart, end);
		if (end <= start) throw new Error("Unsupported diff split");
		chunks.push(render(start, end));
		if (end === rows.length) break;
		let overlap = end;
		const nextEnd =
			at(sizes, at(runEnd, end)) - at(sizes, end) <= budget ? at(runEnd, end) : end + 1;
		while (
			overlap > start + 1 &&
			end - overlap < 3 &&
			at(rows, overlap - 1)[0] === " " &&
			at(sizes, nextEnd) - at(sizes, overlap - 1) <= budget
		)
			overlap--;
		start = overlap;
	}
	return chunks;
}

export function parseDiff(patch: string, comparison: string, paths: string[] = []): DiffSnapshot {
	if (
		typeof patch !== "string" ||
		Buffer.byteLength(patch) > MAX_PATCH_BYTES ||
		typeof comparison !== "string" ||
		comparison.length > 4096 ||
		paths.length > 4096 ||
		paths.some((path) => !safePath(path))
	)
		throw new Error("Invalid or oversized diff input.");
	const snapshot: DiffSnapshot = {
		fingerprint: "",
		comparison,
		files: [],
		chunks: [],
		omitted: [],
	};
	const seenFiles = new Set<string>();
	const hash = createHash("sha256").update(JSON.stringify(comparison)).update("\0");
	for (const raw of sections(patch)) {
		let files: ReturnType<typeof parsePatch>;
		try {
			files = parsePatch(raw);
		} catch {
			hash.update(raw);
			snapshot.omitted.push("Malformed diff section omitted.");
			continue;
		}
		const file = files[0];
		if (files.length !== 1 || !file?.oldFileName || !file.newFileName) {
			hash.update(raw);
			snapshot.omitted.push("Unsupported diff section without unambiguous file paths.");
			continue;
		}
		const prefixed =
			file.isGit ||
			((file.oldFileName === "/dev/null" || file.oldFileName.startsWith("a/")) &&
				(file.newFileName === "/dev/null" || file.newFileName.startsWith("b/")));
		const oldPath = prefixed ? file.oldFileName.replace(/^a\//, "") : file.oldFileName;
		const newPath = prefixed ? file.newFileName.replace(/^b\//, "") : file.newFileName;
		const path = newPath === "/dev/null" ? oldPath : newPath;
		if (!selected(path, oldPath, paths)) continue;
		hash.update(raw);
		if (
			[oldPath, newPath].some((name) => name !== "/dev/null" && !safePath(name)) ||
			path === "/dev/null"
		) {
			snapshot.omitted.push("Sensitive or unsafe old/new diff path omitted.");
			continue;
		}
		if (
			file.isBinary ||
			/^GIT binary patch$/m.test(raw) ||
			/(?![\t\n\r\x80-\x9f])\p{Cc}/u.test(raw)
		) {
			snapshot.omitted.push(`${path}: binary diff omitted.`);
			continue;
		}
		if (!seenFiles.has(path)) {
			seenFiles.add(path);
			snapshot.files.push(path);
		}
		const headers = [
			...raw.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)(?:\n|$)/gm),
		];
		const prefix = raw.slice(0, headers[0]?.index ?? raw.length);
		if (
			prefix
				.split("\n")
				.some(
					(line) =>
						line &&
						!/^(?:diff --git |Index: |={3,}|--- |\+\+\+ |(?:old|new|deleted file|new file) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |index )/.test(
							line,
						),
				)
		) {
			snapshot.omitted.push(`${path}: unsupported diff metadata or hunk heading.`);
			continue;
		}
		if (headers.length !== file.hunks.length) {
			snapshot.omitted.push(`${path}: malformed hunk headings.`);
			continue;
		}
		if (!file.hunks.length) {
			if (
				(!file.isRename &&
					!file.isCopy &&
					!file.isCreate &&
					!file.isDelete &&
					!file.oldMode &&
					!file.newMode) ||
				Buffer.byteLength(raw) > MAX_CHUNK_BYTES
			)
				snapshot.omitted.push(`${path}: unsupported metadata-only diff.`);
			else if (snapshot.chunks.length < MAX_CHUNKS)
				snapshot.chunks.push({
					id: `c${snapshot.chunks.length}`,
					path,
					oldPath,
					oldStart: 0,
					newStart: 0,
					oldLines: 0,
					newLines: 0,
					added: 0,
					deleted: 0,
					patch: raw,
				});
			else snapshot.omitted.push("Diff chunk limit exceeded.");
			continue;
		}
		for (const [index, hunk] of file.hunks.entries()) {
			const header = headers[index];
			if (!header || header.index === undefined || header[5] === undefined) {
				snapshot.omitted.push(`${path}: malformed hunk heading.`);
				continue;
			}
			const body = raw.slice(
				header.index + header[0].length,
				headers[index + 1]?.index ?? raw.length,
			);
			const expected = hunk.lines.join("\n");
			if (
				hunk.oldStart < 1 ||
				hunk.newStart < 1 ||
				![
					hunk.oldStart,
					hunk.newStart,
					hunk.oldLines,
					hunk.newLines,
					hunk.oldStart + hunk.oldLines,
					hunk.newStart + hunk.newLines,
				].every((value) => Number.isSafeInteger(value) && value >= 0) ||
				Number(header[2] ?? 1) !== hunk.oldLines ||
				Number(header[4] ?? 1) !== hunk.newLines ||
				(body !== expected && body !== `${expected}\n`)
			) {
				snapshot.omitted.push(`${path}: malformed or unsupported hunk content.`);
				continue;
			}
			try {
				const chunks = chunksForHunk(prefix, header[5], hunk);
				if (snapshot.chunks.length + chunks.length > MAX_CHUNKS) {
					snapshot.omitted.push("Diff chunk limit exceeded; hunk omitted.");
					continue;
				}
				for (const chunk of chunks)
					snapshot.chunks.push({
						...chunk,
						id: `c${snapshot.chunks.length}`,
						path,
						oldPath,
					});
			} catch {
				snapshot.omitted.push(`${path}: unsupported oversized row, heading or malformed hunk.`);
			}
		}
	}
	snapshot.fingerprint = hash.digest("hex");
	return snapshot;
}

async function command(
	binary: string,
	argv: string[],
	cwd: string,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	try {
		const { stdout } = await exec(binary, argv, {
			cwd,
			signal,
			timeout: 20_000,
			maxBuffer: MAX_PATCH_BYTES,
			encoding: "buffer",
			env: {
				...process.env,
				GIT_OPTIONAL_LOCKS: "0",
				GIT_NO_LAZY_FETCH: "1",
			},
		});
		signal.throwIfAborted();
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
	} catch {
		throw new Error("Diff command failed, exceeded its bound or was cancelled.");
	}
}

export async function collectLocalDiff(
	root: string,
	paths: string[],
	lifetime?: AbortSignal,
): Promise<DiffSnapshot> {
	const signal = AbortSignal.any([AbortSignal.timeout(60_000), ...(lifetime ? [lifetime] : [])]);
	signal.throwIfAborted();
	const requested = await fs.realpath(root);
	let cursor = requested;
	let git: string | undefined, jj: string | undefined;
	while (true) {
		for (const vcs of ["jj", "git"]) {
			try {
				await fs.lstat(join(cursor, `.${vcs}`));
				if (vcs === "jj") jj ??= cursor;
				else git ??= cursor;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					throw new Error("Repository unavailable.");
			}
		}
		if (jj || git || dirname(cursor) === cursor) break;
		cursor = dirname(cursor);
	}
	const directory = jj ?? git;
	if (!directory) throw new Error("No repository available for diff collection.");
	if (paths.length > 4096) throw new Error("Too many diff selections.");
	const selections = (paths.length ? paths : ["."]).map((path) => {
		if (
			typeof path !== "string" ||
			/(?![\x80-\x9f])\p{Cc}/u.test(path) ||
			path.split(/[\\/]/).includes("..")
		)
			throw new Error("Invalid diff selection.");
		const local = relative(directory, resolve(requested, path)).split(sep).join("/");
		if (local && !safePath(local)) throw new Error("Invalid diff selection.");
		return local;
	});
	const scope = selections.includes("") ? [] : selections;
	let patch: string, comparison: string;
	const omitted: string[] = [];
	if (jj) {
		const args = ["--no-pager", "--color", "never"];
		const revision = [
			"log",
			"--no-graph",
			"-r",
			"@",
			"-T",
			'parents.map(|p| p.commit_id()).join(" ")',
		];
		const before = (await command("jj", [...args, ...revision], directory, signal)).trim();
		patch = await command(
			"jj",
			[
				...args,
				"diff",
				"--git",
				"--context",
				"3",
				"--",
				...scope.map((path) => `root:${JSON.stringify(path)}`),
			],
			directory,
			signal,
		);
		const after = (await command("jj", [...args, ...revision], directory, signal)).trim();
		if (!/^[a-f0-9]{40}( [a-f0-9]{40})*$/.test(before))
			throw new Error("Invalid Jujutsu comparison identity.");
		comparison = `jj ${directory} ${before}..working-copy`;
		if (after !== before) throw new Error("Working-copy parents changed during diff collection.");
	} else {
		const args = ["-c", "core.fsmonitor=false"];
		const before = (
			await command("git", [...args, "rev-parse", "--verify", "HEAD"], directory, signal)
		).trim();
		patch = await command(
			"git",
			[
				...args,
				"diff",
				"HEAD",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"--unified=3",
				"--",
				...scope.map((path) => `:(top,literal)${path}`),
			],
			directory,
			signal,
		);
		const untracked = await command(
			"git",
			[
				...args,
				"ls-files",
				"--others",
				"--exclude-standard",
				"-z",
				"--",
				...scope.map((path) => `:(top,literal)${path}`),
			],
			directory,
			signal,
		);
		if (untracked.split("\0").some((path) => path && selected(path, path, scope)))
			omitted.push("Untracked files omitted; they are not part of git diff HEAD.");
		const after = (
			await command("git", [...args, "rev-parse", "--verify", "HEAD"], directory, signal)
		).trim();
		if (!/^[a-f0-9]{40,64}$/.test(before)) throw new Error("Invalid Git comparison identity.");
		comparison = `git ${directory} ${before}..working-copy`;
		if (after !== before) throw new Error("HEAD changed during diff collection.");
	}
	signal.throwIfAborted();
	const snapshot = parseDiff(patch, comparison, scope);
	snapshot.omitted.push(...omitted);
	return snapshot;
}
