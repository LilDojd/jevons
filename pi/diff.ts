import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parsePatch } from "diff";
import type { StructuredPatchHunk } from "diff";
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
    !/[\\\x00-\x1f\x7f-\x9f]/.test(path) &&
    !isAbsolute(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part && part !== "." && part !== ".." && !sensitive.test(part),
      )
  );
}

function selected(
  path: string,
  oldPath: string,
  paths: readonly string[],
): boolean {
  return (
    !paths.length ||
    paths.some((scope) =>
      [path, oldPath].some(
        (name) => name === scope || name.startsWith(`${scope}/`),
      ),
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

function chunksForHunk(
  prefix: string,
  heading: string,
  hunk: StructuredPatchHunk,
): Omit<DiffChunk, "id" | "path" | "oldPath">[] {
  const rows: string[] = [];
  for (const line of hunk.lines) {
    if (line === "\\ No newline at end of file") {
      if (!rows.length || rows.at(-1)!.includes("\n"))
        throw new Error("Invalid newline marker");
      rows[rows.length - 1] += `\n${line}`;
    } else if (/^[ +\-]/.test(line) || line === "") rows.push(line || " ");
    else throw new Error("Invalid diff row");
  }
  const old = [0],
    next = [0],
    sizes = [0],
    added = [0],
    deleted = [0];
  for (const row of rows) {
    old.push(old.at(-1)! + (row[0] !== "+" ? 1 : 0));
    next.push(next.at(-1)! + (row[0] !== "-" ? 1 : 0));
    added.push(added.at(-1)! + (row[0] === "+" ? 1 : 0));
    deleted.push(deleted.at(-1)! + (row[0] === "-" ? 1 : 0));
    sizes.push(sizes.at(-1)! + Buffer.byteLength(row) + 1);
  }
  if (old.at(-1) !== hunk.oldLines || next.at(-1) !== hunk.newLines)
    throw new Error("Invalid hunk ranges");
  const render = (start: number, end: number) => {
    const oldLines = old[end]! - old[start]!;
    const newLines = next[end]! - next[start]!;
    const oldStart = hunk.oldStart + old[start]! - (oldLines ? 0 : 1);
    const newStart = hunk.newStart + next[start]! - (newLines ? 0 : 1);
    return {
      oldStart,
      newStart,
      oldLines,
      newLines,
      added: added[end]! - added[start]!,
      deleted: deleted[end]! - deleted[start]!,
      patch: `${prefix}@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${heading}\n${rows.slice(start, end).join("\n")}\n`,
    };
  };
  const complete = render(0, rows.length);
  if (Buffer.byteLength(complete.patch) <= MAX_CHUNK_BYTES) return [complete];
  const budget = MAX_CHUNK_BYTES - Buffer.byteLength(prefix + heading) - 100;
  if (budget < 1 || rows.some((_, i) => sizes[i + 1]! - sizes[i]! > budget))
    throw new Error("Oversized diff row or heading");
  const runStart: number[] = [],
    runEnd: number[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    if (rows[start]![0] !== " ")
      while (end < rows.length && rows[end]![0] !== " ") end++;
    for (let i = start; i < end; i++) {
      runStart[i] = start;
      runEnd[i] = end;
    }
    start = end;
  }
  const chunks: ReturnType<typeof render>[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start;
    while (end < rows.length && sizes[end + 1]! - sizes[start]! <= budget)
      end++;
    if (
      end < rows.length &&
      runStart[end]! > start &&
      sizes[runEnd[end]!]! - sizes[runStart[end]!]! <= budget
    )
      end = runStart[end]!;
    if (end <= start) throw new Error("Unsupported diff split");
    chunks.push(render(start, end));
    if (end === rows.length) break;
    let overlap = end;
    const nextEnd =
      sizes[runEnd[end]!]! - sizes[end]! <= budget ? runEnd[end]! : end + 1;
    while (
      overlap > start + 1 &&
      end - overlap < 3 &&
      rows[overlap - 1]![0] === " " &&
      sizes[nextEnd]! - sizes[overlap - 1]! <= budget
    )
      overlap--;
    start = overlap;
  }
  return chunks;
}

export function parseDiff(
  patch: string,
  comparison: string,
  paths: string[] = [],
): DiffSnapshot {
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
  const hash = createHash("sha256")
    .update(JSON.stringify(comparison))
    .update("\0");
  for (const raw of sections(patch)) {
    let files;
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
      snapshot.omitted.push(
        "Unsupported diff section without unambiguous file paths.",
      );
      continue;
    }
    const prefixed =
      file.isGit ||
      ((file.oldFileName === "/dev/null" ||
        file.oldFileName.startsWith("a/")) &&
        (file.newFileName === "/dev/null" ||
          file.newFileName.startsWith("b/")));
    const oldPath = prefixed
      ? file.oldFileName.replace(/^a\//, "")
      : file.oldFileName;
    const newPath = prefixed
      ? file.newFileName.replace(/^b\//, "")
      : file.newFileName;
    const path = newPath === "/dev/null" ? oldPath : newPath;
    if (!selected(path, oldPath, paths)) continue;
    hash.update(raw);
    if (
      [oldPath, newPath].some(
        (name) => name !== "/dev/null" && !safePath(name),
      ) ||
      path === "/dev/null"
    ) {
      snapshot.omitted.push("Sensitive or unsafe old/new diff path omitted.");
      continue;
    }
    if (
      file.isBinary ||
      /^GIT binary patch$/m.test(raw) ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)
    ) {
      snapshot.omitted.push(`${path}: binary diff omitted.`);
      continue;
    }
    if (!seenFiles.has(path)) {
      seenFiles.add(path);
      snapshot.files.push(path);
    }
    const headers = [
      ...raw.matchAll(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)(?:\n|$)/gm,
      ),
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
      snapshot.omitted.push(
        `${path}: unsupported diff metadata or hunk heading.`,
      );
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
      const header = headers[index]!;
      const body = raw.slice(
        header.index! + header[0].length,
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
        (body !== expected && body !== expected + "\n")
      ) {
        snapshot.omitted.push(
          `${path}: malformed or unsupported hunk content.`,
        );
        continue;
      }
      try {
        const chunks = chunksForHunk(prefix, header[5]!, hunk);
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
        snapshot.omitted.push(
          `${path}: unsupported oversized row, heading or malformed hunk.`,
        );
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
        GH_PROMPT_DISABLED: "1",
        GH_DEBUG: "",
      },
    });
    signal.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      stdout,
    );
  } catch {
    throw new Error(
      "Diff command failed, exceeded its bound or was cancelled.",
    );
  }
}

export async function collectLocalDiff(
  root: string,
  paths: string[],
  lifetime?: AbortSignal,
): Promise<DiffSnapshot> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(lifetime ? [lifetime] : []),
  ]);
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
    if (jj || dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  const directory = jj ?? git;
  if (!directory)
    throw new Error("No repository available for diff collection.");
  if (paths.length > 4096) throw new Error("Too many diff selections.");
  const selections = (paths.length ? paths : ["."]).map((path) => {
    if (
      typeof path !== "string" ||
      /[\x00-\x1f\x7f]/.test(path) ||
      path.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid diff selection.");
    const local = relative(directory, resolve(requested, path))
      .split(sep)
      .join("/");
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
    const before = (
      await command("jj", [...args, ...revision], directory, signal)
    ).trim();
    patch = await command(
      "jj",
      [...args, "diff", "--git", "--context", "3"],
      directory,
      signal,
    );
    const after = (
      await command("jj", [...args, ...revision], directory, signal)
    ).trim();
    if (!/^[a-f0-9]{40}( [a-f0-9]{40})*$/.test(before))
      throw new Error("Invalid Jujutsu comparison identity.");
    comparison = `jj ${directory} ${before}..working-copy`;
    if (after !== before)
      throw new Error("Working-copy parents changed during diff collection.");
  } else {
    const args = ["-c", "core.fsmonitor=false"];
    const before = (
      await command(
        "git",
        [...args, "rev-parse", "--verify", "HEAD"],
        directory,
        signal,
      )
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
      ],
      directory,
      signal,
    );
    const untracked = await command(
      "git",
      [...args, "ls-files", "--others", "--exclude-standard", "-z"],
      directory,
      signal,
    );
    if (
      untracked.split("\0").some((path) => path && selected(path, path, scope))
    )
      omitted.push(
        "Untracked files omitted; they are not part of git diff HEAD.",
      );
    const after = (
      await command(
        "git",
        [...args, "rev-parse", "--verify", "HEAD"],
        directory,
        signal,
      )
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(before))
      throw new Error("Invalid Git comparison identity.");
    comparison = `git ${directory} ${before}..working-copy`;
    if (after !== before)
      throw new Error("HEAD changed during diff collection.");
  }
  signal.throwIfAborted();
  const snapshot = parseDiff(patch, comparison, scope);
  snapshot.omitted.push(...omitted);
  return snapshot;
}

export async function collectPullRequestDiff(
  url: string,
  lifetime?: AbortSignal,
): Promise<DiffSnapshot> {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/pull\/([1-9][0-9]{0,9})\/?$/.exec(
      url,
    );
  if (!match) throw new Error("Expected a GitHub pull request URL.");
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(lifetime ? [lifetime] : []),
  ]);
  const repository = match[1]!;
  const api = (endpoint: string, diff = false) =>
    command(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "-H",
        `Accept: ${diff ? "application/vnd.github.diff" : "application/vnd.github+json"}`,
        endpoint,
      ],
      "/",
      signal,
    );
  const metadata = async () => {
    try {
      const value = JSON.parse(
        await api(`repos/${repository}/pulls/${match[2]}`),
      );
      const base: unknown = value?.base?.sha,
        head: unknown = value?.head?.sha;
      if (
        typeof base !== "string" ||
        typeof head !== "string" ||
        !/^[a-f0-9]{40}$/.test(base) ||
        !/^[a-f0-9]{40}$/.test(head)
      )
        throw new Error("Invalid revision");
      return `${base}...${head}`;
    } catch {
      throw new Error("Pull request revisions unavailable or cancelled.");
    }
  };
  const revisions = await metadata();
  const patch = await api(`repos/${repository}/compare/${revisions}`, true);
  const current = await metadata();
  signal.throwIfAborted();
  const snapshot = parseDiff(
    patch,
    `github ${repository}#${match[2]} ${revisions}`,
  );
  if (current !== revisions)
    throw new Error("Pull request revisions changed during diff collection.");
  return snapshot;
}
