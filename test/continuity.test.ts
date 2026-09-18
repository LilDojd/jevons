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
import { registerContinuity } from "../pi/continuity.ts";
import type { Runtime } from "../pi/runtime.ts";

function user(session: SessionManager, text: string) {
  return session.appendMessage({ role: "user", content: text, timestamp: 1 });
}

function compact(session: SessionManager) {
  const kept = user(session, "Current user request: do not commit.");
  return session.appendCompaction("Native summary", kept, 40_000);
}

function harness(session: SessionManager) {
  type Handler = (
    event: ContextEvent,
    ctx: ExtensionContext,
  ) => { messages: ContextEvent["messages"] } | undefined;
  let handler: Handler;
  const notifications: string[] = [];
  const pi = {
    on(name: string, callback: Handler) {
      if (name === "context") handler = callback;
    },
    setActiveTools() {
      assert.fail("Continuity must not change coding-agent tools");
    },
  } as unknown as ExtensionAPI;
  const runtime = { active: true, taskOmitted: false } as Runtime;
  const ctx = {
    hasUI: true,
    sessionManager: session,
    ui: { notify: (text: string) => notifications.push(text) },
  } as unknown as ExtensionContext;
  registerContinuity(pi, runtime);
  return {
    runtime,
    notifications,
    context(messages = session.buildSessionContext().messages) {
      return handler!({ type: "context", messages }, ctx);
    },
  };
}

function notice(messages: ContextEvent["messages"]) {
  const message = messages.at(-1)!;
  assert.equal(message.role, "custom");
  assert.ok(message.role === "custom");
  assert.equal(message.customType, "jevons.continuity");
  assert.equal(typeof message.content, "string");
  return message.content as string;
}

function legacySupplement(
  content: string,
): Extract<ContextEvent["messages"][number], { role: "custom" }> {
  return {
    role: "custom",
    customType: "jevons.continuity",
    content,
    display: false,
    timestamp: 1,
  };
}

test("native messages and user constraints remain unchanged; no supplement before compaction or while paused", () => {
  const session = SessionManager.inMemory();
  user(session, "Do not commit.\n  Keep whitespace and 🦉 exact.");
  const h = harness(session);
  assert.equal(h.context(), undefined);
  compact(session);
  h.runtime.active = false;
  assert.equal(h.context(), undefined);
  h.runtime.active = true;
  const native = session.buildSessionContext().messages;
  const original = structuredClone(native);
  const entries = structuredClone(session.getBranch());
  const result = h.context(native)!;
  assert.equal(result.messages.length, native.length + 1);
  assert.deepEqual(native, original);
  native.forEach((message, index) =>
    assert.equal(result.messages[index], message),
  );
  assert.ok(Buffer.byteLength(notice(result.messages)) < 2000);
  assert.deepEqual(session.getBranch(), entries);
  assert.equal(h.runtime.active, true);
  assert.equal(h.runtime.taskOmitted, false);
});

test("historical user text, credentials, diagnostics and review/check payloads are not replayed", () => {
  const session = SessionManager.inMemory();
  // Synthetic sentinels, not real credentials. Include non-patterned sensitive
  // text: regex redaction cannot guarantee that arbitrary history is safe.
  const secrets = [
    "test-only-api-key-value-123",
    "private coordinator instruction",
    "diagnostic-private-value",
    "check-private-value",
    "review-private-value",
  ];
  user(session, `API_KEY=${secrets[0]}\n${secrets[1]}`);
  session.appendMessage({
    role: "toolResult",
    toolName: "bash",
    toolCallId: "failed-call",
    isError: true,
    content: [{ type: "text", text: secrets[2]! }],
    timestamp: 2,
  });
  session.appendCustomEntry("jevons.checks", {
    results: [{ passed: false, output: secrets[3] }],
  });
  session.appendCustomMessageEntry("jevons", secrets[4]!, true, {
    fingerprint: "old-revision",
    status: "review",
    findings: [{ criterion: secrets[4] }],
    omitted: [],
    evaluations: [],
  });
  compact(session);
  const h = harness(session);
  const output = JSON.stringify(h.context()!.messages);
  for (const secret of secrets) assert.ok(!output.includes(secret));
  assert.equal(h.notifications.length, 0);
});

test("growing historical user text and repeated compactions cannot overflow the continuity notice", () => {
  const session = SessionManager.inMemory();
  user(session, "Initial request");
  compact(session);
  const h = harness(session);
  const initial = notice(h.context()!.messages);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 100; i++)
      user(session, `Historical coordinator update ${i}: ${"🦉".repeat(1000)}`);
    compact(session);
    const native = session.buildSessionContext().messages;
    for (let request = 0; request < 10; request++) {
      const result = h.context(native)!;
      assert.equal(notice(result.messages), initial);
      assert.equal(result.messages.length, native.length + 1);
    }
  }
  assert.equal(h.notifications.length, 0);
  assert.equal(h.runtime.taskOmitted, false);
  // A separate task-evidence omission must not be silently cleared either.
  h.runtime.taskOmitted = true;
  h.context();
  assert.equal(h.runtime.taskOmitted, true);
});

test("reprocessing context replaces legacy supplements without accumulating duplicate messages", () => {
  const session = SessionManager.inMemory();
  compact(session);
  const h = harness(session);
  const native = session.buildSessionContext().messages;
  const stale = legacySupplement("synthetic-old-sensitive-text");
  const other = { ...stale, customType: "other-extension", content: "Keep me" };
  const input = [...native, stale, other, stale];
  const result = h.context(input)!.messages;
  assert.deepEqual(result.slice(0, -1), [...native, other]);
  assert.ok(!JSON.stringify(result).includes("synthetic-old-sensitive-text"));
  assert.deepEqual(h.context(result)!.messages, result);
  assert.equal(input.length, native.length + 3);
  h.runtime.active = false;
  assert.deepEqual(h.context(result)!.messages, [...native, other]);
});

test("branch navigation uses only current native context, including branch summaries", () => {
  const session = SessionManager.inMemory();
  const root = user(session, "Root request");
  user(session, "Abandoned instruction");
  compact(session);
  const h = harness(session);
  h.context();
  session.branch(root);
  assert.equal(h.context(), undefined);
  // Even a cached supplement must disappear when returning to uncompacted context.
  const native = session.buildSessionContext().messages;
  assert.deepEqual(
    h.context([...native, legacySupplement("abandoned supplement")])!.messages,
    native,
  );
  session.branchWithSummary(root, "Native branch summary");
  const branchContext = session.buildSessionContext().messages;
  const result = h.context(branchContext)!.messages;
  assert.deepEqual(result.slice(0, -1), branchContext);
  assert.ok(!JSON.stringify(result).includes("Abandoned instruction"));
  assert.ok(Buffer.byteLength(notice(result)) < 2000);
  assert.equal(h.notifications.length, 0);
});

test("session reload retains native continuity without restoring old user text", async (t) => {
  const session = SessionManager.inMemory();
  user(session, "synthetic-private-history");
  compact(session);
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
  const result = harness(restored).context()!.messages;
  assert.deepEqual(result, harness(session).context()!.messages);
  assert.ok(!JSON.stringify(result).includes("synthetic-private-history"));
});
