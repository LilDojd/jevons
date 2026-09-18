import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Runtime } from "../pi/runtime.ts";
import { defaultPolicy } from "../pi/policy.ts";
import { collectLocalDiff } from "../pi/diff.ts";
import { verifyConfigured } from "../pi/verify.ts";
import type { CheckConfig, Evaluate, Request } from "../src/contracts.ts";

const exec = promisify(execFile);

async function fixture(t: TestContext, repository = true) {
  const directory = await mkdtemp(join(tmpdir(), "jevons-verify-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "repo");
  await mkdir(root);
  const marker = join(directory, "executed");
  const jj = async (...args: string[]) => {
    const result = await exec(
      "jj",
      ["--no-pager", "--color", "never", ...args],
      { cwd: root },
    );
    return result.stdout;
  };
  if (repository) {
    await jj("git", "init", "--no-colocate", ".");
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    await jj("new", "-m", "Verification fixture");
  }
  const check = (
    name: string,
    options: { mandatory?: boolean; exit?: number; script?: string } = {},
  ): CheckConfig => ({
    name,
    description: `Verify ${name} behavior`,
    ...(options.mandatory === undefined
      ? {}
      : { mandatory: options.mandatory }),
    argv: [
      process.execPath,
      "--eval",
      `import {appendFileSync,writeFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")}); ${options.script ?? ""}; process.exit(${options.exit ?? 0});`,
    ],
    timeoutMs: 5000,
  });
  const requests: Request[] = [];
  let assess: Evaluate = async (request) => ({
    model: "jev-verification-fixture",
    usage: { input_tokens: 10, output_tokens: 2 },
    elapsedMs: 1,
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { type: "noul", noul: 0.01 },
      ]),
    ),
  });
  const runtime = new Runtime({} as ExtensionAPI);
  runtime.active = true;
  runtime.sessionId = "verification-session";
  runtime.task = "Verify the changed program";
  runtime.policy = structuredClone(defaultPolicy);
  runtime.policy.checks = [check("mandatory")];
  runtime.evaluator = () => {
    if (!runtime.active) throw new Error("Jevons is paused.");
    return async (request, signal) => {
      requests.push(request);
      return assess(request, signal);
    };
  };
  let confirm = async (_title: string, _message: string) => true;
  const confirmations: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    sessionManager: {
      getSessionId: () => runtime.sessionId,
      getEntries: () => [],
    },
    ui: {
      confirm: async (title: string, message: string) => {
        confirmations.push(message);
        return confirm(title, message);
      },
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  const executed = async () => {
    try {
      return (await readFile(marker, "utf8")).trim().split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    root,
    runtime,
    ctx,
    check,
    jj,
    requests,
    confirmations,
    executed,
    confirm: (handler: typeof confirm) => {
      confirm = handler;
    },
    assess: (handler: Evaluate) => {
      assess = handler;
    },
  };
}

for (const mode of ["denied", "no-ui", "paused"] as const) {
  test(`${mode} verification never executes configured code`, async (t) => {
    const h = await fixture(t);
    if (mode === "denied") h.confirm(async () => false);
    if (mode === "no-ui") {
      h.ctx.hasUI = false;
      h.runtime.policy!.checks.push(h.check("optional", { mandatory: false }));
    }
    if (mode === "paused") {
      h.runtime.active = false;
      await assert.rejects(verifyConfigured(h.ctx, h.runtime), /paused/i);
    } else assert.equal(await verifyConfigured(h.ctx, h.runtime), undefined);
    assert.deepEqual(await h.executed(), []);
    assert.equal(h.requests.length, 0);
  });
}

test("mandatory defaults cannot be deselected and failure does not skip remaining selected checks", async (t) => {
  const h = await fixture(t);
  h.runtime.policy!.checks = [
    h.check("default-mandatory", { exit: 7 }),
    h.check("explicit-mandatory", { mandatory: true }),
    h.check("unrelated", { mandatory: false }),
  ];
  const run = await verifyConfigured(h.ctx, h.runtime);
  assert.equal(run?.status, "failed");
  assert.deepEqual(await h.executed(), [
    "default-mandatory",
    "explicit-mandatory",
  ]);
  assert.deepEqual(
    run.results.map((result) => result.exitCode),
    [7, 0],
  );
  assert.equal(run.selection.selections[2]!.selected, false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(Object.keys(h.requests[0]!.questions), ["check2"]);
  assert.match(h.confirmations[0]!, /Mandatory.*default-mandatory/);
  assert.match(h.confirmations[0]!, /Not run.*unrelated/);
});

test("failed optional judgment retains all checks and separate confirmation still permits execution", async (t) => {
  const h = await fixture(t);
  h.runtime.policy!.checks = [
    h.check("mandatory"),
    h.check("optional", { mandatory: false }),
  ];
  h.assess(async () => {
    h.runtime.active = false;
    throw new Error("Provider unavailable");
  });
  const run = await verifyConfigured(h.ctx, h.runtime);
  assert.equal(run?.status, "passed");
  assert.equal(run.selection.complete, false);
  assert.deepEqual(await h.executed(), ["mandatory", "optional"]);
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.runtime.controller.signal.aborted, false);
});

for (const change of [
  "workspace",
  "parent",
  "task",
  "policy",
  "session",
  "pause",
] as const) {
  test(`${change} change during confirmation rejects execution`, async (t) => {
    const h = await fixture(t);
    h.confirm(async () => {
      if (change === "workspace")
        await writeFile(
          join(h.root, "unrelated.ts"),
          "export const changed = true;\n",
        );
      if (change === "parent")
        await h.jj("new", "-m", "Same files, new parent");
      if (change === "task") h.runtime.deliveredUser("Do not run old checks");
      if (change === "policy")
        h.runtime.policy = structuredClone(h.runtime.policy!);
      if (change === "session") h.runtime.sessionId = "replacement-session";
      if (change === "pause") h.runtime.pause(h.ctx);
      return true;
    });
    await assert.rejects(verifyConfigured(h.ctx, h.runtime));
    assert.deepEqual(await h.executed(), []);
  });
}

test("task changed while the approved workspace is being rechecked prevents spawning", async (t) => {
  const h = await fixture(t);
  const changed = Promise.withResolvers<void>();
  h.confirm(async () => {
    setTimeout(() => {
      h.runtime.deliveredUser("New execution constraint");
      changed.resolve();
    }, 0);
    return true;
  });
  await assert.rejects(verifyConfigured(h.ctx, h.runtime));
  await changed.promise;
  assert.deepEqual(await h.executed(), []);
});

test("workspace-changing checks return historical results, never a current verification pass", async (t) => {
  const h = await fixture(t);
  h.runtime.policy!.checks = [
    h.check("format", {
      script: "writeFileSync('source.ts', 'export const value = 2;\\n')",
    }),
  ];
  const run = await verifyConfigured(h.ctx, h.runtime);
  assert.equal(run?.status, "stale");
  assert.equal(run.results[0]!.passed, true);
  assert.deepEqual(await h.executed(), ["format"]);
  assert.ok(run.omitted.length);
});

test("unavailable workspace evidence runs confirmed checks but cannot claim fresh verification", async (t) => {
  const h = await fixture(t, false);
  h.runtime.policy!.checks.push(h.check("optional", { mandatory: false }));
  const run = await verifyConfigured(h.ctx, h.runtime);
  assert.equal(run?.status, "unverified");
  assert.deepEqual(await h.executed(), ["mandatory", "optional"]);
  assert.equal(h.requests.length, 0);
  assert.equal(run.fingerprint, undefined);
  assert.ok(run.omitted.length);
});

test(
  "pause kills an executing check and prevents delayed effects or later checks",
  { timeout: 5000 },
  async (t) => {
    const h = await fixture(t);
    h.runtime.policy!.checks = [
      h.check("running", {
        script:
          "await new Promise(resolve => setTimeout(resolve, 500)); writeFileSync('source.ts', 'late mutation')",
      }),
      h.check("never-started"),
    ];
    const pending = verifyConfigured(h.ctx, h.runtime);
    const rejected = assert.rejects(pending, /abort|cancel/i);
    const deadline = Date.now() + 2000;
    while (!(await h.executed()).length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await h.executed(), ["running"]);
    h.runtime.pause(h.ctx);
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.deepEqual(await h.executed(), ["running"]);
    assert.equal(
      await readFile(join(h.root, "source.ts"), "utf8"),
      "export const value = 1;\n",
    );
  },
);

test("unchanged patch bytes with a new parent invalidate workspace freshness", async (t) => {
  const h = await fixture(t);
  const before = await collectLocalDiff(h.root, []);
  await h.jj("new", "-m", "Another identical tree");
  const after = await collectLocalDiff(h.root, []);
  assert.deepEqual(before.chunks, after.chunks);
  assert.notEqual(before.comparison, after.comparison);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("a selection that excludes every optional check is unverified, not a deterministic pass", async (t) => {
  const h = await fixture(t);
  h.runtime.policy!.checks = [h.check("unrelated", { mandatory: false })];
  const run = await verifyConfigured(h.ctx, h.runtime);
  assert.equal(run?.status, "unverified");
  assert.deepEqual(run.results, []);
  assert.deepEqual(await h.executed(), []);
});
