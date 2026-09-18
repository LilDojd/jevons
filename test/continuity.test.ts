import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONTINUITY_BYTES,
  continuityEvidence,
  registerContinuity,
} from "../pi/continuity.ts";
import type { Runtime } from "../pi/runtime.ts";
import type { DiffReport } from "../src/diff-review.ts";

function user(session: SessionManager, text: string) {
  return session.appendMessage({ role: "user", content: text, timestamp: 1 });
}

function compact(session: SessionManager) {
  session.appendCompaction(
    "Native summary, intentionally lossy",
    session.getLeafId()!,
    40_000,
  );
}

function records(session: SessionManager): Record<string, any>[] {
  const content = continuityEvidence(session.getBranch())!.content;
  return JSON.parse(content.slice(content.indexOf("\n[") + 1));
}

function harness(session: SessionManager) {
  let handler: (
    event: ContextEvent,
    ctx: ExtensionContext,
  ) => { messages?: ContextEvent["messages"] } | undefined;
  let reads = 0;
  const notifications: string[] = [];
  const registered: string[] = [];
  const pi = {
    on(name: string, callback: typeof handler) {
      registered.push(name);
      if (name === "context") handler = callback;
    },
  } as unknown as ExtensionAPI;
  const runtime = { active: true, taskOmitted: false } as Runtime;
  const ctx = {
    hasUI: true,
    sessionManager: {
      getBranch() {
        reads++;
        return session.getBranch();
      },
    },
    ui: { notify: (text: string) => notifications.push(text) },
  } as unknown as ExtensionContext;
  registerContinuity(pi, runtime);
  return {
    runtime,
    registered,
    notifications,
    reads: () => reads,
    context(messages = session.buildSessionContext().messages) {
      return handler!({ type: "context", messages }, ctx);
    },
  };
}

test("continuity is opt-in and supplements native compaction without replacing its messages", () => {
  const session = SessionManager.inMemory();
  user(
    session,
    "Do not commit.\n  Keep whitespace, 🦉, and constraints exact.\n",
  );
  const h = harness(session);
  assert.equal(h.context(), undefined);
  compact(session);
  h.runtime.active = false;
  const reads = h.reads();
  assert.equal(h.context(), undefined);
  assert.equal(h.reads(), reads);
  h.runtime.active = true;
  const native = session.buildSessionContext().messages;
  const original = structuredClone(native);
  const result = h.context(native)!;
  assert.equal(result.messages!.length, native.length + 1);
  assert.deepEqual(native, original);
  native.forEach((message, index) =>
    assert.equal(result.messages![index], message),
  );
  assert.equal(result.messages!.at(-1)!.role, "custom");
  assert.equal(
    session.getBranch().filter((entry) => entry.type === "custom_message")
      .length,
    0,
  );
});

test("exact original user blocks survive repeated compaction and session reload", async (t) => {
  const session = SessionManager.inMemory();
  const original = "Only pi/continuity.ts.\r\n  No commits.\n";
  const first = user(session, original);
  const second = session.appendMessage({
    role: "user",
    content: [
      { type: "text", text: 'Check "quoted" constraints' },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "text", text: "\nThen stop. " },
    ],
    timestamp: 2,
  });
  compact(session);
  const firstEvidence = records(session);
  user(session, "Continue");
  compact(session);
  const evidence = records(session);
  assert.deepEqual(evidence.slice(0, firstEvidence.length), firstEvidence);
  assert.deepEqual(
    evidence.find((item) => item.entryId === first)?.textBlocks,
    [{ index: 0, text: original }],
  );
  assert.deepEqual(
    evidence.find((item) => item.entryId === second)?.textBlocks,
    [
      { index: 0, text: 'Check "quoted" constraints' },
      { index: 2, text: "\nThen stop. " },
    ],
  );
  assert.equal(
    evidence.find((item) => item.entryId === second)?.omittedNonTextBlocks,
    1,
  );
  const dir = await mkdtemp(join(tmpdir(), "jevons-continuity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  await writeFile(
    file,
    [session.getHeader(), ...session.getBranch()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const restored = SessionManager.open(file);
  assert.deepEqual(
    continuityEvidence(restored.getBranch()),
    continuityEvidence(session.getBranch()),
  );
});

test("branch navigation excludes abandoned evidence, including after re-registration", () => {
  const session = SessionManager.inMemory();
  const root = user(session, "Shared original constraint");
  user(session, "ABANDONED_USER_TEXT");
  session.appendMessage({
    role: "toolResult",
    toolName: "bash",
    toolCallId: "abandoned-call",
    isError: true,
    content: [{ type: "text", text: "ABANDONED_FAILURE" }],
    timestamp: 2,
  });
  compact(session);
  const h = harness(session);
  const abandoned = h.context()!.messages!.at(-1)!;
  assert.ok(abandoned.role === "custom");
  assert.match(abandoned.content as string, /ABANDONED_FAILURE/);
  session.branch(root);
  assert.equal(h.context(), undefined);
  user(session, "Current branch constraint");
  compact(session);
  assert.ok(session.getEntries().length > session.getBranch().length);
  for (const instance of [h, harness(session)]) {
    const message = instance.context()!.messages!.at(-1)!;
    assert.ok(message.role === "custom");
    assert.match(message.content as string, /Current branch constraint/);
    assert.doesNotMatch(message.content as string, /ABANDONED/);
  }
});

test("failed tool call IDs and bounded diagnostic excerpts persist despite later success", () => {
  const session = SessionManager.inMemory();
  user(session, "Fix failing checks");
  const output =
    "Failure start: " + "🦉".repeat(2000) + "\nExpected 2 but got 3";
  session.appendMessage({
    role: "toolResult",
    toolName: "bash",
    toolCallId: "failed-call",
    isError: true,
    content: [{ type: "text", text: output }],
    timestamp: 2,
  });
  session.appendMessage({
    role: "toolResult",
    toolName: "bash",
    toolCallId: "successful-call",
    isError: false,
    content: [{ type: "text", text: "unrelated success" }],
    timestamp: 3,
  });
  compact(session);
  const failure = records(session).find((item) => item.kind === "toolFailure")!;
  assert.equal(failure.toolCallId, "failed-call");
  assert.equal(failure.resolution, "unknown");
  assert.ok(output.startsWith(failure.diagnostic.head));
  assert.ok(output.endsWith(failure.diagnostic.tail));
  assert.equal(failure.diagnostic.sourceBytes, Buffer.byteLength(output));
  assert.equal(
    failure.diagnostic.omittedBytes,
    Buffer.byteLength(output) -
      Buffer.byteLength(failure.diagnostic.head) -
      Buffer.byteLength(failure.diagnostic.tail),
  );
  assert.doesNotMatch(JSON.stringify(failure), /�/);
  assert.ok(continuityEvidence(session.getBranch())!.bytes <= CONTINUITY_BYTES);
});

test("custom and tool reviews preserve findings, probabilities, models and historical check provenance", () => {
  const session = SessionManager.inMemory();
  user(session, "Review changes and run checks");
  const report: DiffReport = {
    status: "review",
    complete: false,
    fingerprint: "reviewed-revision",
    comparison: "working copy",
    files: ["src/a.ts"],
    reviewedChunks: 1,
    totalChunks: 2,
    findings: [
      {
        id: "chunk-1",
        path: "src/a.ts",
        oldPath: "src/a.ts",
        oldStart: 1,
        newStart: 1,
        oldLines: 1,
        newLines: 1,
        added: 1,
        deleted: 1,
        rule: "correctness",
        label: "Correctness",
        criterion: "Visible defect",
        probability: 0.91,
        status: "concern",
      },
    ],
    omitted: ["second chunk not reviewed"],
    evaluations: [
      {
        model: "jev-actual-version",
        answers: { q: { type: "noul", noul: 0.91 } },
        usage: { input_tokens: 20, output_tokens: 5 },
        elapsedMs: 10,
      },
    ],
    questionMaps: [],
  };
  const customId = session.appendCustomMessageEntry(
    "jevons",
    "Review text",
    true,
    report,
  );
  session.appendMessage({
    role: "toolResult",
    toolName: "jevons_review",
    toolCallId: "review-call",
    isError: false,
    content: [{ type: "text", text: "Review text" }],
    details: report,
    timestamp: 2,
  });
  session.appendCustomEntry("jevons.checks", {
    results: [
      {
        name: "tests",
        passed: false,
        output: "Expected true",
        elapsedMs: 12,
        exitCode: null,
        termination: "timeout",
        omittedBytes: 137,
      },
    ],
    revision: "old-revision",
    taskRevision: 4,
    observedAt: 100,
  });
  session.appendCustomEntry("jevons.checks", {
    results: [
      {
        name: "tests",
        passed: true,
        output: "passed",
        elapsedMs: 12,
        exitCode: 0,
        termination: "exit",
        omittedBytes: 0,
      },
    ],
    revision: "later-revision",
    taskRevision: 5,
    observedAt: 200,
  });
  compact(session);
  const evidence = records(session);
  const reviews = evidence.filter((item) => item.kind === "review");
  assert.equal(reviews.length, 2);
  assert.equal(
    reviews.find((item) => item.entryId === customId)?.complete,
    false,
  );
  assert.deepEqual(reviews[0]!.omitted, report.omitted);
  const findings = evidence.filter((item) => item.kind === "reviewFinding");
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0]!.finding, report.findings[0]);
  assert.deepEqual(findings[0]!.models, ["jev-actual-version"]);
  assert.equal(findings[0]!.fingerprint, "reviewed-revision");
  assert.equal(findings[0]!.toolCallId, "review-call");
  const checks = evidence.filter((item) => item.kind === "check");
  assert.equal(checks.length, 2);
  assert.equal(checks[0]!.passed, true);
  assert.equal(checks[1]!.passed, false);
  assert.equal(checks[1]!.revision, "old-revision");
  assert.equal(checks[1]!.taskRevision, 4);
  assert.equal(checks[1]!.checkObservedAt, 100);
  assert.equal(checks[1]!.exitCode, null);
  assert.equal(checks[1]!.termination, "timeout");
  assert.equal(checks[1]!.omittedBytes, 137);
  assert.equal(checks[1]!.diagnostic.omittedBytes, 0);
  assert.equal(checks[0]!.exitCode, 0);
  assert.equal(checks[0]!.termination, "exit");
  assert.equal(checks[0]!.omittedBytes, 0);
  checks.forEach((check) => assert.match(check.freshness, /not current proof/));
});

test("protected evidence overflow stays bounded and disables only Jevons automation, not native tools", () => {
  const session = SessionManager.inMemory();
  const oversized = user(session, "🦉".repeat(CONTINUITY_BYTES));
  for (let i = 0; i < 300; i++)
    user(session, `Constraint ${i}: ${"x".repeat(300)}`);
  compact(session);
  const evidence = continuityEvidence(session.getBranch())!;
  assert.ok(evidence.overflow);
  assert.ok(evidence.bytes <= CONTINUITY_BYTES);
  assert.equal(evidence.bytes, Buffer.byteLength(evidence.content));
  assert.ok(evidence.omitted.records > 1);
  assert.ok(evidence.omitted.bytes > CONTINUITY_BYTES);
  assert.ok(evidence.omitted.firstEntryIds.includes(oversized));
  assert.ok(evidence.omitted.firstEntryIds.length <= 8);
  assert.match(evidence.content, /Consult original session entries/);
  const h = harness(session);
  const native = session.buildSessionContext().messages;
  assert.equal(h.context(native)!.messages!.length, native.length + 1);
  assert.equal(h.runtime.taskOmitted, true);
  assert.equal(h.runtime.active, true);
  assert.equal(h.notifications.length, 1);
  assert.deepEqual(h.registered, ["context"]);
});
