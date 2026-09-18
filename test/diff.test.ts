import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { createTwoFilesPatch, parsePatch } from "diff";
import {
  collectLocalDiff,
  collectPullRequestDiff,
  parseDiff,
} from "../pi/diff.ts";

function gitPatch(path: string, old: string, next: string) {
  return `diff --git a/${path} b/${path}\n${createTwoFilesPatch(`a/${path}`, `b/${path}`, old, next, undefined, undefined, { headerOptions: { includeIndex: false, includeUnderline: false, includeFileHeaders: true } })}`;
}

function assertRanges(
  patch: string,
  chunk: ReturnType<typeof parseDiff>["chunks"][number],
) {
  const hunk = parsePatch(patch)[0]!.hunks[0]!;
  assert.equal(chunk.oldStart, hunk.oldStart - (hunk.oldLines ? 0 : 1));
  assert.equal(chunk.newStart, hunk.newStart - (hunk.newLines ? 0 : 1));
  assert.equal(chunk.oldLines, hunk.oldLines);
  assert.equal(chunk.newLines, hunk.newLines);
  assert.equal(
    chunk.added,
    hunk.lines.filter((line) => line.startsWith("+")).length,
  );
  assert.equal(
    chunk.deleted,
    hunk.lines.filter((line) => line.startsWith("-")).length,
  );
  assert.ok(Buffer.byteLength(patch) <= 8000);
}

test("parses additions, deletions, renames, mode changes and quoted paths without losing headings or EOF markers", () => {
  const modified = gitPatch("src/a.ts", "old", "new").replace(
    "@@ -1,1 +1,1 @@",
    "@@ -1,1 +1,1 @@ function example()",
  );
  const addition =
    "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n";
  const deletion =
    "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n";
  const rename =
    "diff --git a/old name.ts b/new name.ts\nsimilarity index 100%\nrename from old name.ts\nrename to new name.ts\n";
  const mode = "diff --git a/run b/run\nold mode 100644\nnew mode 100755\n";
  const quoted =
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"\n--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-old\n+new\n';
  const snapshot = parseDiff(
    modified + addition + deletion + rename + mode + quoted,
    "base..head",
  );
  assert.deepEqual(snapshot.omitted, []);
  assert.deepEqual(snapshot.files, [
    "src/a.ts",
    "new.ts",
    "gone.ts",
    "new name.ts",
    "run",
    "café.ts",
  ]);
  assert.equal(snapshot.chunks.length, 6);
  assert.match(snapshot.chunks[0]!.patch, /@@ function example\(\)/);
  assert.match(snapshot.chunks[0]!.patch, /\\ No newline at end of file/);
  assert.equal(snapshot.chunks[1]!.oldPath, "/dev/null");
  assert.equal(snapshot.chunks[1]!.oldStart, 0);
  assert.equal(snapshot.chunks[2]!.newStart, 0);
  assert.equal(snapshot.chunks[3]!.oldPath, "old name.ts");
  assert.match(snapshot.chunks[3]!.patch, /rename from old name.ts/);
  assert.match(snapshot.chunks[4]!.patch, /new mode 100755/);
  for (const i of [0, 1, 2, 5])
    assertRanges(snapshot.chunks[i]!.patch, snapshot.chunks[i]!);
});

test("fingerprints exact selected patch bytes and revision identity, while filtering literal paths on both sides of renames", () => {
  const a = gitPatch("src/a.ts", "old\n", "new\n");
  const b = gitPatch("other/b.ts", "before\n", "after\n");
  const first = parseDiff(a + b, "revision-one", ["src"]);
  assert.deepEqual(first.files, ["src/a.ts"]);
  assert.equal(
    first.fingerprint,
    parseDiff(a + b.replace("after", "changed"), "revision-one", ["src"])
      .fingerprint,
  );
  assert.notEqual(
    first.fingerprint,
    parseDiff(a + b, "revision-two", ["src"]).fingerprint,
  );
  assert.notEqual(
    first.fingerprint,
    parseDiff(a.replace("@@\n", "@@ heading\n") + b, "revision-one", ["src"])
      .fingerprint,
  );
  const rename =
    "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n";
  assert.deepEqual(parseDiff(rename, "r", ["old.ts"]).files, ["new.ts"]);
  assert.deepEqual(parseDiff(a + b, "r", ["s"]).files, []);
});

test("chunks large UTF-8 hunks with exact ranges and complete changed-row coverage", () => {
  const old = Array.from(
    { length: 1000 },
    (_, i) => `old-${i} ${"λ".repeat(30)}\n`,
  ).join("");
  const next = Array.from(
    { length: 1000 },
    (_, i) => `new-${i} ${"語".repeat(30)}\n`,
  ).join("");
  const raw = gitPatch("large.ts", old, next);
  assert.ok(Buffer.byteLength(raw) > 32_000);
  const snapshot = parseDiff(raw, "r");
  assert.deepEqual(snapshot.omitted, []);
  assert.ok(snapshot.chunks.length > 10);
  const removed = new Set<string>(),
    added = new Set<string>();
  let oldPosition = 1,
    newPosition = 1;
  for (const chunk of snapshot.chunks) {
    assertRanges(chunk.patch, chunk);
    const hunk = parsePatch(chunk.patch)[0]!.hunks[0]!;
    assert.equal(hunk.oldStart, oldPosition);
    assert.equal(hunk.newStart, newPosition);
    oldPosition += hunk.oldLines;
    newPosition += hunk.newLines;
    for (const row of parsePatch(chunk.patch)[0]!.hunks[0]!.lines) {
      if (row.startsWith("-")) {
        assert.ok(!removed.has(row));
        removed.add(row);
      }
      if (row.startsWith("+")) {
        assert.ok(!added.has(row));
        added.add(row);
      }
    }
  }
  assert.equal(removed.size, 1000);
  assert.equal(added.size, 1000);
  assert.equal(
    snapshot.chunks.reduce((sum, c) => sum + c.added, 0),
    1000,
  );
  assert.equal(
    snapshot.chunks.reduce((sum, c) => sum + c.deleted, 0),
    1000,
  );
});

test("keeps small replacement runs intact and overlaps available unchanged context", () => {
  const context = Array.from(
    { length: 150 },
    (_, i) => ` unchanged-${i} ${"x".repeat(60)}`,
  );
  const rows = [
    ...context.slice(0, 100),
    "-before",
    "+after",
    ...context.slice(100),
  ];
  const raw = `--- a/a.ts\n+++ b/a.ts\n@@ -1,151 +1,151 @@ heading\n${rows.join("\n")}\n`;
  const snapshot = parseDiff(raw, "r");
  assert.deepEqual(snapshot.omitted, []);
  assert.ok(snapshot.chunks.length > 1);
  assert.ok(
    snapshot.chunks.some((chunk) => chunk.patch.includes("-before\n+after\n")),
  );
  for (const chunk of snapshot.chunks) assertRanges(chunk.patch, chunk);
  for (let i = 1; i < snapshot.chunks.length; i++) {
    const previous = parsePatch(snapshot.chunks[i - 1]!.patch)[0]!.hunks[0]!
      .lines;
    const current = parsePatch(snapshot.chunks[i]!.patch)[0]!.hunks[0]!.lines;
    assert.deepEqual(current.slice(0, 3), previous.slice(-3));
  }
});

test("omits sensitive old and new paths, binary changes, malformed patches and unsupported giant rows explicitly", () => {
  const rename =
    "diff --git a/.env b/public.txt\nrename from .env\nrename to public.txt\n";
  const binary =
    "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n";
  for (const raw of [
    rename,
    rename
      .replaceAll("a/.env", "a/public.txt")
      .replaceAll("b/public.txt", "b/.env")
      .replace("rename from .env", "rename from public.txt")
      .replace("rename to public.txt", "rename to .env"),
    binary,
    "not a patch",
    "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n",
    gitPatch("big.ts", "old\n", "x".repeat(9000) + "\n"),
  ]) {
    const snapshot = parseDiff(raw, "r");
    assert.equal(snapshot.chunks.length, 0);
    assert.ok(snapshot.omitted.length > 0);
  }
  const hidden = parseDiff(rename, "r");
  assert.doesNotMatch(JSON.stringify(hidden), /\.env/);
  assert.throws(
    () => parseDiff("x".repeat(4 * 1024 * 1024 + 1), "r"),
    /oversized/,
  );
});

async function fakeCommands(t: TestContext, data: object) {
  const root = await fs.mkdtemp(join(tmpdir(), "jevons-diff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await fs.mkdir(bin);
  const fixture = join(root, "fixture.json"),
    calls = join(root, "calls.jsonl");
  await fs.writeFile(fixture, JSON.stringify(data));
  for (const binary of ["jj", "git", "gh"]) {
    await fs.writeFile(
      join(bin, binary),
      `#!/usr/bin/env node
import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({binary:${JSON.stringify(binary)},args})+'\\n');
let output;
if (args.includes('log')) output = data.revision;
else if (args.includes('rev-parse')) output = data.head;
else if (args.includes('ls-files')) output = data.untracked ?? '';
else if (args.includes('diff')) output = args.includes('--ignore-working-copy') ? '' : data.patch;
else if (args.at(-1).includes('/compare/')) output = data.patch;
else {
 const seen = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').split('\\n').filter(line => line.includes('/pulls/')).length;
 output = JSON.stringify({base:{sha:data.base},head:{sha:seen>1 && data.moved ? data.moved : data.head}});
}
process.stdout.write(output);
`,
      { mode: 0o700 },
    );
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  return { root, fixture, calls };
}

test("local collection prefers jj, snapshots current content, scopes subdirectories, and flags Git untracked files", async (t) => {
  const patch =
    gitPatch("src/a.ts", "old\n", "new\n") + gitPatch("b.ts", "old\n", "new\n");
  const head = "a".repeat(40),
    parent = "b".repeat(40);
  const fixture = await fakeCommands(t, {
    patch,
    head,
    revision: parent,
    untracked: "src/new.ts\0",
  });
  await fs.mkdir(join(fixture.root, ".jj"));
  await fs.mkdir(join(fixture.root, ".git"));
  await fs.mkdir(join(fixture.root, "src"));
  const jj = await collectLocalDiff(join(fixture.root, "src"), []);
  assert.deepEqual(jj.files, ["src/a.ts"]);
  assert.deepEqual(jj.omitted, []);
  assert.match(jj.comparison, /^jj /);
  assert.doesNotMatch(
    await fs.readFile(fixture.calls, "utf8"),
    /"binary":"git"/,
  );
  await fs.rm(join(fixture.root, ".jj"), { recursive: true });
  const git = await collectLocalDiff(fixture.root, ["src"]);
  assert.deepEqual(git.files, ["src/a.ts"]);
  assert.ok(git.omitted.some((reason) => reason.includes("Untracked")));
  assert.match(git.comparison, /^git /);
});

test("real jj selected-path fingerprints ignore unrelated working-copy edits", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "jevons-jj-diff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exec = promisify(execFile);
  await exec("jj", ["--no-pager", "git", "init", "--no-colocate", root], {
    cwd: root,
  });
  await exec("jj", ["--no-pager", "status"], { cwd: root });
  await fs.writeFile(join(root, "selected.ts"), "export const selected = 1;\n");
  await fs.writeFile(
    join(root, "unrelated.ts"),
    "export const unrelated = 1;\n",
  );
  const before = await collectLocalDiff(root, ["selected.ts"]);
  await fs.writeFile(
    join(root, "unrelated.ts"),
    "export const unrelated = 2;\n",
  );
  const after = await collectLocalDiff(root, ["selected.ts"]);
  assert.deepEqual(before.omitted, []);
  assert.deepEqual(after.omitted, []);
  assert.deepEqual(after.files, ["selected.ts"]);
  assert.ok(after.chunks.length > 0);
  assert.equal(after.comparison, before.comparison);
  assert.equal(after.fingerprint, before.fingerprint);
  await fs.writeFile(join(root, "selected.ts"), "export const selected = 2;\n");
  assert.notEqual(
    (await collectLocalDiff(root, ["selected.ts"])).fingerprint,
    before.fingerprint,
  );
});

for (const vcs of ["jj", "git"] as const) {
  test(`real ${vcs} scopes collection before byte limits and treats metacharacters literally`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), `jevons-${vcs}-scope-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const exec = promisify(execFile);
    const run = (args: string[]) => exec(vcs, args, { cwd: root });
    if (vcs === "jj") await run(["git", "init", "--no-colocate", "."]);
    else {
      await run(["init"]);
      await run([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Base",
      ]);
    }
    const names = ["literal[1].ts", "all() | other.ts", 'quoted"name.ts'];
    for (const name of names)
      await fs.writeFile(join(root, name), "selected\n");
    await fs.writeFile(
      join(root, "large.ts"),
      "unrelated line\n".repeat(400000),
    );
    if (vcs === "jj")
      await run(["--config", "snapshot.max-new-file-size=8000000", "status"]);
    else await run(["add", "."]);
    for (const name of names) {
      const snapshot = await collectLocalDiff(root, [name]);
      assert.deepEqual(snapshot.files, [name]);
      assert.deepEqual(snapshot.omitted, []);
      assert.ok(snapshot.chunks.length > 0);
    }
    await assert.rejects(collectLocalDiff(root, []), /bound|failed/);
  });
}

test("remote collection requests only a pinned comparison diff and invalidates moved revisions", async (t) => {
  const base = "a".repeat(40),
    head = "b".repeat(40);
  const patch = gitPatch("gone.ts", "deleted\n", "");
  const fixture = await fakeCommands(t, { base, head, patch });
  const first = await collectPullRequestDiff(
    "https://github.com/example/project/pull/12",
  );
  assert.deepEqual(first.omitted, []);
  assert.equal(first.chunks[0]!.deleted, 1);
  const calls = (await fs.readFile(fixture.calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 3);
  assert.equal(
    calls[1].args.at(-1),
    `repos/example/project/compare/${base}...${head}`,
  );
  assert.ok(calls[1].args.includes("Accept: application/vnd.github.diff"));
  assert.ok(calls.every((call) => call.args.includes("GET")));
  await fs.writeFile(fixture.calls, "");
  await fs.writeFile(
    fixture.fixture,
    JSON.stringify({ base, head, patch, moved: "c".repeat(40) }),
  );
  await assert.rejects(
    collectPullRequestDiff("https://github.com/example/project/pull/12"),
    /revisions changed/,
  );
  await fs.writeFile(
    fixture.fixture,
    JSON.stringify({ base, head: "d".repeat(40), patch }),
  );
  const changed = await collectPullRequestDiff(
    "https://github.com/example/project/pull/12",
  );
  assert.notEqual(changed.fingerprint, first.fingerprint);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    collectPullRequestDiff(
      "https://github.com/example/project/pull/12",
      abort.signal,
    ),
  );
  await assert.rejects(
    collectPullRequestDiff("https://gitlab.com/example/project/pull/12"),
  );
});
