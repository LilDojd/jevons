import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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

test("ordinary context does not replay compacted user text, credentials, diagnostics or review/check payloads", () => {
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

test("native retained text and summaries are preserved, not sanitized", () => {
  const session = SessionManager.inMemory();
  const kept = user(session, "synthetic-sensitive-retained-user-text");
  session.appendCompaction("synthetic-sensitive-native-summary", kept, 40_000);
  const native = session.buildSessionContext().messages;
  const result = harness(session).context()!.messages;
  assert.deepEqual(result.slice(0, -1), native);
  const output = JSON.stringify(result);
  assert.ok(output.includes("synthetic-sensitive-retained-user-text"));
  assert.ok(output.includes("synthetic-sensitive-native-summary"));
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

test("fresh SDK consumer filters ordinary context without replacing native compaction or tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-continuity-sdk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model: Model<"openai-completions"> = {
    id: "fixture",
    name: "Offline continuity fixture",
    api: "openai-completions",
    provider: "offline-continuity",
    baseUrl: "https://offline.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 512,
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 180 },
    retry: { enabled: false },
  });
  const runtime = { active: true, taskOmitted: true } as Runtime;
  const contexts: ContextEvent["messages"][] = [];
  const errors: unknown[] = [];
  const summaryInputs: string[] = [];
  let providerInput = "";
  let nativeCompactions = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Offline continuity test.",
    extensionFactories: [
      (pi) => {
        registerContinuity(pi, runtime);
        pi.on("context", (event) => {
          contexts.push(structuredClone(event.messages));
        });
        pi.on("session_compact", (event) => {
          if (!event.fromExtension) nativeCompactions++;
        });
        pi.registerProvider(model.provider, {
          api: model.api,
          apiKey: "synthetic-test-only",
          baseUrl: model.baseUrl,
          models: [model],
          streamSimple(selected, context) {
            const summary = !context.tools?.length;
            providerInput = JSON.stringify(context.messages);
            if (summary) summaryInputs.push(providerInput);
            // This fixture tests native plumbing, not a model's summary quality.
            const message: AssistantMessage = {
              role: "assistant",
              api: selected.api,
              provider: selected.provider,
              model: selected.id,
              content: [
                {
                  type: "text",
                  text: summary
                    ? "Constraint: do not commit. Verification unknown."
                    : "Offline response. " + "padding ".repeat(90),
                },
              ],
              usage: {
                input: 10,
                output: 10,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 20,
                cost: { ...model.cost, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "done", reason: "stop", message });
            stream.end();
            return stream;
          },
        });
      },
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(dir);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager,
  });
  t.after(() => session.dispose());
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const tools = session.getActiveToolNames();
  assert.deepEqual([...tools].sort(), ["bash", "edit", "read", "write"]);
  await session.prompt(
    "Do not commit. synthetic-old-private-source " + "old ".repeat(300),
  );
  const root = sessionManager.getLeafId()!;
  let firstNotice: string | undefined;
  for (let round = 0; round < 3; round++) {
    await session.prompt(
      `Retained constraint ${round}: never publish. ` + "recent ".repeat(100),
    );
    await session.compact();
    await session.prompt("Continue safely.");
    const context = contexts.at(-1)!;
    const text = notice(context);
    firstNotice ??= text;
    assert.equal(text, firstNotice);
    assert.equal(
      context.filter(
        (m) => m.role === "custom" && m.customType === "jevons.continuity",
      ).length,
      1,
    );
    assert.ok(!providerInput.includes("synthetic-old-private-source"));
    assert.ok(providerInput.includes("do not commit"));
    // The final assistant response was appended after the context hook ran.
    assert.deepEqual(
      context.slice(0, -1),
      sessionManager.buildSessionContext().messages.slice(0, -1),
    );
    assert.equal(runtime.taskOmitted, true);
  }
  assert.equal(nativeCompactions, 3);
  assert.ok(
    summaryInputs
      .slice(1)
      .some((input) => input.includes("Verification unknown.")),
  );
  assert.ok(summaryInputs.every((input) => !input.includes(firstNotice!)));
  await session.sendCustomMessage(
    {
      customType: "jevons.continuity",
      content: "synthetic-legacy-private-text",
      display: false,
    },
    { triggerTurn: false },
  );
  await session.prompt("Continue without legacy supplement.");
  assert.ok(!providerInput.includes("synthetic-legacy-private-text"));
  await session.navigateTree(root, { summarize: false });
  await session.prompt("New branch.");
  assert.ok(!providerInput.includes("Retained constraint 2"));
  assert.ok(
    !contexts
      .at(-1)!
      .some((m) => m.role === "custom" && m.customType === "jevons.continuity"),
  );
  await session.navigateTree(root, { summarize: true });
  await session.prompt("Continue from native branch summary.");
  assert.ok(contexts.at(-1)!.some((m) => m.role === "branchSummary"));
  assert.equal(notice(contexts.at(-1)!), firstNotice);
  assert.deepEqual(session.getActiveToolNames(), tools);
  assert.equal(runtime.taskOmitted, true);
  assert.deepEqual(errors, []);
});

test("ordinary context after session reload adds no original historical text", async (t) => {
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
