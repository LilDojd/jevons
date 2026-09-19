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
import type { Evaluate, Request } from "../src/contracts.ts";
import { registerCompaction } from "../pi/compaction.ts";
import { parseRequest } from "../pi/schema.ts";
import { Runtime } from "../pi/runtime.ts";
import { Jev } from "../pi/service.ts";

type Message = ContextEvent["messages"][number];
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const userMessage = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 1,
});
function pair(
  id: string,
  output = "result ".repeat(200),
): [AssistantMessage, Extract<Message, { role: "toolResult" }>] {
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: "  exact assistant text 🦉\n" },
        {
          type: "toolCall",
          id,
          name: "read",
          arguments: { path: `file-${id}` },
        },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      timestamp: 2,
      stopReason: "toolUse",
      usage,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: output }],
      isError: false,
      timestamp: 3,
      details: { retained: "opaque details" },
    },
  ];
}
const tail = () =>
  Array.from({ length: 6 }, (_, i) => userMessage(`Recent instruction ${i}`));
const consumed = (): AssistantMessage => ({
  ...pair("unused")[0],
  content: [{ type: "text", text: "I have consumed those results." }],
  stopReason: "stop",
});
const history = (...middle: Message[]): Message[] => [
  userMessage("Never publish. Preserve whitespace."),
  ...middle,
  consumed(),
  ...tail(),
];
function fixture(evaluate?: Evaluate) {
  type Handler = (event: any, ctx: ExtensionContext) => any;
  const handlers = new Map<string, Handler[]>();
  const entries: Record<string, unknown>[] = [];
  const requests: Request[] = [];
  const abort = new AbortController();
  let trusted = true;
  let session = "one";
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry(_type: string, data: Record<string, unknown>) {
      entries.push(data);
    },
  } as unknown as ExtensionAPI;
  const runtime = {
    active: true,
    controller: new AbortController(),
    evaluator: () => async (request: Request, signal?: AbortSignal) => {
      requests.push(parseRequest(request));
      if (evaluate) return evaluate(request, signal);
      return {
        model: "actual-jev",
        usage: { input_tokens: 10, output_tokens: 2 },
        elapsedMs: 1,
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", noul: 0.1 },
          ]),
        ),
      };
    },
  } as unknown as Runtime;
  const ctx = {
    signal: abort.signal,
    model: { api: "anthropic-messages" },
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => session },
  } as unknown as ExtensionContext;
  registerCompaction(pi, runtime);
  const emit = async (name: string, event: unknown = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? [])
      result = await handler(event, ctx);
    return result;
  };
  return {
    runtime,
    ctx,
    abort,
    entries,
    requests,
    handlers,
    emit,
    trust: (value: boolean) => {
      trusted = value;
    },
    session: (value: string) => {
      session = value;
    },
    async context(messages: Message[]) {
      const result = await emit("context", { type: "context", messages });
      return (result?.messages as Message[]) ?? messages;
    },
  };
}

test("deletes only paired calls/results, preserving original non-tool blocks and avoiding identical billing", async () => {
  const h = fixture();
  const [call, result] = pair("old");
  const input = history(call, result);
  const before = structuredClone(input);
  const output = await h.context(input);
  assert.equal(output.length, input.length - 1);
  assert.equal(output[0], input[0]);
  assert.ok(output[1]?.role === "assistant");
  assert.deepEqual(output[1].content, [call.content[0]]);
  assert.equal(output[1].content[0], call.content[0]);
  assert.deepEqual(input, before);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(await h.context(structuredClone(input)), output);
  assert.equal(h.requests.length, 1);
  assert.equal(h.entries[0]!.proposedDroppedCalls, 1);
  assert.equal(h.entries[0]!.fullEvidence, false);
  assert.ok(!JSON.stringify(h.entries).includes("file-old"));
});

test("a parallel batch larger than recent pinning stays untouched until a successful assistant consumes it", async () => {
  const pairs = Array.from({ length: 9 }, (_, i) => pair(`parallel-${i}`));
  const assistant = {
    ...pairs[0]![0],
    content: pairs.flatMap(([call]) =>
      call.content.filter((block) => block.type === "toolCall"),
    ),
  };
  const batch = [
    userMessage("task"),
    assistant,
    ...pairs.map(([, result]) => result),
  ];
  for (const stopReason of [undefined, "error", "aborted"] as const) {
    const h = fixture();
    const input = [
      ...batch,
      ...(stopReason ? [{ ...consumed(), stopReason }] : []),
      ...tail(),
    ];
    assert.equal(await h.context(input), input);
    assert.equal(h.requests.length, 0);
  }
  const h = fixture();
  const input = [...batch, consumed(), ...tail()];
  const output = await h.context(input);
  assert.ok(h.requests.length > 0);
  assert.equal(
    output.filter((message) => message.role === "toolResult").length,
    0,
  );
  assert.ok(!output.includes(assistant));
});

test("whitespace-only assistant text survives even when upstream drops its projected message", async () => {
  const h = fixture();
  const [call, result] = pair("whitespace");
  call.content[0] = { type: "text", text: " \t\n  " };
  const output = await h.context(history(call, result));
  const assistant = output.find((message) => message.role === "assistant");
  assert.ok(assistant?.role === "assistant");
  assert.deepEqual(assistant.content, [call.content[0]]);
  assert.equal(assistant.content[0], call.content[0]);
});

test("thinking and signatures retain the entire assistant while upstream abridges a plain result", async () => {
  const h = fixture();
  const [call, result] = pair("signed");
  call.content.unshift({
    type: "thinking",
    thinking: "private reasoning",
    thinkingSignature: "opaque-signature",
  });
  const tool = call.content.find((block) => block.type === "toolCall")!;
  tool.thoughtSignature = "tool-signature";
  const input = history(call, result);
  const output = await h.context(input);
  assert.equal(output[1], call);
  const abridged = output[2];
  assert.ok(abridged?.role === "toolResult");
  assert.equal(abridged.toolCallId, result.toolCallId);
  assert.equal(abridged.details, result.details);
  assert.ok(abridged.content[0]?.type === "text");
  assert.match(abridged.content[0].text, /fast-jev-compaction truncated/);
  assert.ok(
    abridged.content[0].text.length <
      (result.content[0] as { text: string }).text.length,
  );
  assert.ok(!JSON.stringify(h.requests).includes("private reasoning"));
  const unknown = fixture();
  unknown.ctx.model = {
    api: "unknown-api",
  } as unknown as typeof unknown.ctx.model;
  assert.deepEqual(await unknown.context(input), input);
  assert.equal(unknown.requests.length, 0);
});

test("images, opaque results, errors, discovery outputs, duplicate/orphan IDs, custom and user content stay intact", async () => {
  const h = fixture();
  const image = pair("image");
  image[1].content.push({
    type: "image",
    data: "opaque-image",
    mimeType: "image/png",
  });
  const error = pair("error");
  error[1].isError = true;
  const discovery = pair("discovery");
  discovery[1].addedToolNames = ["new-tool"];
  const duplicate = pair("duplicate");
  const orphan = pair("orphan");
  const custom: Message = {
    role: "custom",
    customType: "other",
    content: "Preserve this.",
    display: false,
    timestamp: 4,
  };
  const user: Message = {
    role: "user",
    content: [
      { type: "text", text: "  exact user text" },
      { type: "image", data: "user-image", mimeType: "image/png" },
    ],
    timestamp: 5,
  };
  const valid = pair("valid");
  const input = history(
    ...image,
    ...error,
    ...discovery,
    ...duplicate,
    duplicate[1],
    orphan[0],
    custom,
    user,
    ...valid,
  );
  const output = await h.context(input);
  for (const original of [
    ...image,
    ...error,
    ...discovery,
    ...duplicate,
    orphan[0],
    custom,
    user,
  ])
    assert.ok(output.includes(original));
  assert.ok(!output.includes(valid[1]));
  assert.equal(h.requests.length, 1);
});

test("upstream no-action and recent protection preserve native objects", async () => {
  const h = fixture(async (request) => ({
    model: "actual",
    elapsedMs: 1,
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { type: "noul", noul: 1 },
      ]),
    ),
  }));
  const input = history(...pair("kept"));
  assert.equal(await h.context(input), input);
  assert.equal(h.requests.length, 1);
  const recent = fixture();
  const short = [userMessage("task"), ...pair("recent")];
  assert.equal(await recent.context(short), short);
  assert.equal(recent.requests.length, 0);
});

for (const change of [
  "pause",
  "trust",
  "controller",
  "session",
  "turn",
  "cancel",
  "tree",
  "compact",
  "model",
  "cwd",
  "snapshot",
] as const) {
  test(`late ${change} changes discard completed judgments`, async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const h = fixture(async (request) => {
      started.resolve();
      await gate.promise;
      return {
        model: "actual",
        elapsedMs: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            { type: "noul", noul: 0 },
          ]),
        ),
      };
    });
    const input = history(...pair("late"));
    const pending = h.context(input);
    await started.promise;
    if (change === "pause") h.runtime.active = false;
    if (change === "trust") h.trust(false);
    if (change === "controller") h.runtime.controller = new AbortController();
    if (change === "session") h.session("two");
    if (change === "turn") await h.emit("turn_start");
    if (change === "cancel") h.abort.abort();
    if (change === "tree") await h.emit("session_before_tree");
    if (change === "compact") await h.emit("session_before_compact");
    if (change === "model")
      h.ctx.model = { api: "google-generative-ai" } as typeof h.ctx.model;
    if (change === "cwd") h.ctx.cwd = "/changed";
    if (change === "snapshot")
      Object.assign(input[0]!, { content: "Changed while evaluating" });
    gate.resolve();
    assert.equal(await pending, input);
    assert.ok(!h.entries.some((entry) => entry.status === "assessed"));
  });
}

test("cached patches are scoped to transport and cwd and concurrent identical requests share billing", async () => {
  const gate = Promise.withResolvers<void>();
  const h = fixture(async (request) => {
    await gate.promise;
    return {
      model: "actual",
      elapsedMs: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          { type: "noul", noul: 0 },
        ]),
      ),
    };
  });
  const [call, result] = pair("memo");
  call.content.unshift({
    type: "thinking",
    thinking: "original reasoning",
    thinkingSignature: "signed",
  });
  const input = history(call, result);
  const first = h.context(input);
  const second = h.context(structuredClone(input));
  gate.resolve();
  assert.deepEqual(await first, await second);
  assert.equal(h.requests.length, 1);
  h.ctx.cwd = "/other";
  await h.context(input);
  assert.equal(h.requests.length, 2);
  h.ctx.model = { api: "unsupported" } as unknown as typeof h.ctx.model;
  assert.equal(await h.context(input), input);
  assert.equal(h.requests.length, 2);
  assert.equal(h.entries.at(-1)!.reason, "no-safe-pairs");
});

test("cancellation reaches evaluator and returns original context without waiting for a result", async () => {
  const started = Promise.withResolvers<void>();
  const h = fixture(async (_request, signal) => {
    started.resolve();
    return new Promise((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), {
        once: true,
      }),
    );
  });
  const input = history(...pair("cancel-immediately"));
  const pending = h.context(input);
  await started.promise;
  h.runtime.controller.abort();
  assert.equal(await pending, input);
});

test("paused/untrusted contexts only remove legacy owned supplements and never assess", async () => {
  for (const trusted of [true, false]) {
    const h = fixture();
    h.trust(trusted);
    h.runtime.active = !trusted;
    const input = history(...pair("idle"));
    const supplement: Message = {
      role: "custom",
      customType: "jevons.continuity",
      content: "legacy source",
      display: false,
      timestamp: 1,
    };
    assert.deepEqual(await h.context([...input, supplement]), input);
    assert.equal(h.requests.length, 0);
  }
});

test("upstream concurrent batches are serialized and split to exact host schema bounds", async () => {
  let active = 0;
  let peak = 0;
  const h = fixture(async (request) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return {
      model: "actual",
      elapsedMs: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          { type: "noul", noul: 0 },
        ]),
      ),
    };
  });
  const input = history(
    ...Array.from({ length: 160 }, (_, i) =>
      pair(`batch-${i}`, "small output"),
    ).flat(),
  );
  const output = await h.context(input);
  assert.ok(h.requests.length >= 10);
  assert.equal(peak, 1);
  for (const request of h.requests)
    assert.deepEqual(parseRequest(request), request);
  assert.equal(
    new Set(h.requests.flatMap((request) => Object.keys(request.questions)))
      .size,
    320,
  );
  assert.equal(
    output.filter((message) => message.role === "toolResult").length,
    0,
  );
});

test("failed later subrequest applies nothing and suppresses remaining queued dispatches", async () => {
  let count = 0;
  const h = fixture(async (request) => {
    if (++count === 2) throw new Error("private service failure");
    return {
      model: "actual",
      elapsedMs: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [
          id,
          { type: "noul", noul: 0 },
        ]),
      ),
    };
  });
  const input = history(
    ...Array.from({ length: 40 }, (_, i) => pair(`failure-${i}`)).flat(),
  );
  assert.equal(await h.context(input), input);
  assert.equal(count, 2);
  assert.equal(await h.context(input), input);
  assert.equal(count, 2);
  assert.ok(!JSON.stringify(h.entries).includes("private service failure"));
});

test("large shared state is fitted locally before first dispatch and omissions remain explicit", async () => {
  const h = fixture();
  const input = history(
    userMessage("old context ".repeat(8000)),
    ...pair("fit"),
  );
  const output = await h.context(input);
  assert.ok(h.requests.length > 0);
  assert.equal(output[1], input[1]);
  assert.notEqual(h.entries[0]!.stateStage, "full");
  assert.equal(h.entries[0]!.fullEvidence, false);
  assert.ok(Buffer.byteLength(JSON.stringify(h.requests[0]!.state)) < 24000);
});

test("credentials are screened before fitter truncation but unshared result bodies are not transmitted", async () => {
  const secret = "sk-" + "a".repeat(30);
  for (const inArguments of [true, false]) {
    const h = fixture();
    const calls = pair("secret");
    if (inArguments) {
      const block = calls[0].content.find(
        (block) => block.type === "toolCall",
      )!;
      block.arguments = { path: "x".repeat(989) + " " + secret };
    }
    const input = history(
      userMessage(inArguments ? "task" : "x".repeat(989) + " " + secret),
      ...calls,
    );
    assert.equal(await h.context(input), input);
    assert.equal(h.requests.length, 0);
    assert.ok(!JSON.stringify(h.entries).includes(secret));
  }
  const h = fixture();
  await h.context(history(...pair("unshared", secret.repeat(30))));
  assert.equal(h.requests.length, 1);
  assert.ok(!JSON.stringify(h.requests).includes(secret));
});

test("fresh SDK consumer filters ordinary context without replacing native compaction or tools", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevons-compaction-sdk-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const model: Model<"openai-completions"> = {
    id: "fixture",
    name: "Offline compaction fixture",
    api: "openai-completions",
    provider: "offline-compaction",
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
  settingsManager.setProjectTrusted(true);
  let runtime!: Runtime;
  let failJev = false;
  let jevDispatches = 0;
  let issuedTool = false;
  const resultMarker = "synthetic-tool-result-to-prune";
  const fixturePath = join(dir, "fixture.txt");
  await writeFile(fixturePath, resultMarker.repeat(80));
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
    systemPrompt: "Offline compaction test.",
    extensionFactories: [
      (pi) => {
        runtime = new Runtime(pi);
        runtime.active = true;
        runtime.taskOmitted = true;
        runtime.jev = new Jev({
          model: "jev-fixture",
          apiKey: "synthetic-test-only",
          record: (receipt) => pi.appendEntry("jevons.receipt", receipt),
          fetch: async (_url, init) => {
            jevDispatches++;
            if (failJev)
              return new Response("offline failure", { status: 503 });
            const request = JSON.parse(String(init?.body)) as Request;
            assert.ok(!JSON.stringify(request).includes(resultMarker));
            return Response.json({
              model: "jev-fixture-actual",
              usage: { input_tokens: 10, output_tokens: 2 },
              answers: Object.fromEntries(
                Object.keys(request.questions).map((id) => [
                  id,
                  { type: "noul", noul: 0 },
                ]),
              ),
            });
          },
        });
        registerCompaction(pi, runtime);
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
            if (!summary && !issuedTool) {
              issuedTool = true;
              message.content.push({
                type: "toolCall",
                id: "sdk-read",
                name: "read",
                arguments: { path: fixturePath },
              });
              message.stopReason = "toolUse";
            }
            const stream = createAssistantMessageEventStream();
            stream.push({
              type: "done",
              reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
              message,
            });
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
  for (let i = 0; i < 4; i++) await session.prompt(`Continue step ${i}`);
  assert.ok(jevDispatches > 0);
  assert.ok(!providerInput.includes(resultMarker));
  assert.ok(JSON.stringify(sessionManager.getBranch()).includes(resultMarker));
  const receipts = sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "jevons.receipt",
    );
  assert.ok(
    receipts.some(
      (entry) =>
        entry.type === "custom" &&
        (entry.data as { model: string }).model === "jev-fixture-actual",
    ),
  );
  failJev = true;
  await session.prompt("Keep native fallback available after a Jev failure.");
  assert.equal(runtime.active, false);
  for (let round = 0; round < 3; round++) {
    await session.prompt(
      `Retained constraint ${round}: never publish. ` + "recent ".repeat(100),
    );
    await session.compact();
    await session.prompt("Continue safely.");
    const context = contexts.at(-1)!;
    assert.equal(
      context.filter(
        (m) => m.role === "custom" && m.customType === "jevons.continuity",
      ).length,
      0,
    );
    assert.ok(!providerInput.includes("synthetic-old-private-source"));
    assert.ok(providerInput.includes("do not commit"));
    // The final assistant response was appended after the context hook ran.
    assert.deepEqual(
      context,
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
  assert.ok(
    !contexts
      .at(-1)!
      .some((m) => m.role === "custom" && m.customType === "jevons.continuity"),
  );
  assert.deepEqual(session.getActiveToolNames(), tools);
  assert.equal(runtime.taskOmitted, true);
  assert.deepEqual(errors, []);
});
