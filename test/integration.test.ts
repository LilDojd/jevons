import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../pi/extension.ts";
import type { Policy, Request } from "../src/contracts.ts";

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

async function fixture(t: TestContext, checks: Policy["checks"] = []) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "jevons-integration-")),
  );
  const previousKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "integration-test-not-a-credential";
  t.after(async () => {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  });
  const requests: Request[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Request;
      requests.push(request);
      return Response.json({
        model: "jev-integration-test",
        usage: { input_tokens: 10, output_tokens: 2 },
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { type: "noul", noul: 0.95 },
          ]),
        ),
      });
    },
  );
  await writeFile(join(root, "jevons.json"), JSON.stringify({ checks }));
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (
      name: string,
      command: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) => commands.set(name, command),
    sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) =>
      sent.push(args),
    registerTool() {},
    registerFlag() {},
    registerEntryRenderer() {},
    registerMessageRenderer() {},
    appendEntry() {},
    getFlag: () => false,
  } as unknown as ExtensionAPI;
  const session = { id: "first" };
  const ctx = {
    cwd: root,
    hasUI: true,
    isProjectTrusted: () => true,
    model: { provider: "test", id: "current" },
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    getContextUsage: () => ({ tokens: 0 }),
    sessionManager: { getSessionId: () => session.id, getBranch: () => [] },
    ui: { confirm: async () => true, setStatus() {}, notify() {} },
  } as unknown as ExtensionCommandContext;
  extension(pi);
  const emit = async (name: string, event: Record<string, unknown>) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? [])
      results.push(await handler(event, ctx));
    return results;
  };
  const command = (args: string) => commands.get("jevons")!.handler(args, ctx);
  await emit("session_start", { reason: "startup" });
  await command("on");
  t.after(() => emit("session_shutdown", { reason: "quit" }).then(() => {}));
  return { root, ctx, session, emit, command, requests, sent };
}

const toolCall = {
  toolName: "bash",
  toolCallId: "test-call",
  input: { command: "inspect database" },
};

test("explicit-only skills never enter shared candidates or selected skill context", async (t) => {
  const h = await fixture(t);
  const hidden = {
    name: "database-private",
    description: "Database private metadata",
    filePath: join(h.root, "hidden.md"),
    disableModelInvocation: true,
  };
  const visible = {
    name: "database-public",
    description: "Database guidance",
    filePath: join(h.root, "visible.md"),
  };
  await writeFile(hidden.filePath, "EXPLICIT_ONLY_BODY");
  await writeFile(visible.filePath, "PUBLIC_SKILL_BODY");
  const task = "Database maintenance";
  const event = {
    prompt: task,
    systemPrompt: "Preserve user constraints; no commits.",
    systemPromptOptions: { skills: [hidden, visible] },
  };
  await h.emit("input", { source: "interactive", text: task });
  const [result] = (await h.emit("before_agent_start", event)) as {
    systemPrompt: string;
  }[];
  assert.equal(h.requests.length, 1);
  const shared = JSON.stringify(h.requests[0]);
  assert.ok(shared.includes(visible.name));
  for (const value of [
    hidden.name,
    hidden.description,
    hidden.filePath,
    "EXPLICIT_ONLY_BODY",
  ])
    assert.ok(!shared.includes(value));
  assert.ok(result!.systemPrompt.includes(event.systemPrompt));
  assert.ok(result!.systemPrompt.includes("PUBLIC_SKILL_BODY"));
  assert.ok(!result!.systemPrompt.includes("EXPLICIT_ONLY_BODY"));
  await h.emit("input", { source: "interactive", text: task });
  await h.emit("before_agent_start", {
    ...event,
    systemPromptOptions: { skills: [hidden] },
  });
  assert.equal(h.requests.length, 1);
});

test("only delivered steering and follow-up constraints affect tool assessments", async (t) => {
  const h = await fixture(t);
  const task = "Maintain the database";
  await h.emit("input", { source: "interactive", text: task });
  await h.emit("message_start", { message: { role: "user", content: task } });
  const delivered: string[] = [];
  for (const streamingBehavior of ["steer", "followUp"]) {
    const update =
      streamingBehavior === "steer"
        ? "Preserve the archive"
        : "Do not change the schema";
    await h.emit("input", {
      source: "interactive",
      text: update,
      streamingBehavior,
    });
    await h.emit("tool_call", toolCall);
    const before = (h.requests.at(-1)!.state as { task: string }).task;
    assert.ok(!before.includes(update));
    await h.emit("message_start", {
      message: { role: "user", content: [{ type: "text", text: update }] },
    });
    await h.emit("tool_call", toolCall);
    delivered.push(update);
    const after = (h.requests.at(-1)!.state as { task: string }).task;
    for (const text of [task, ...delivered]) assert.ok(after.includes(text));
  }
  assert.equal(h.requests.length, 4);
  const feedback = h.sent.at(-1)!;
  assert.equal(feedback[0].display, true);
  assert.equal(feedback[1]?.deliverAs, "steer");
});

for (const replacement of ["policy", "session"] as const) {
  test(`gate confirmation cannot authorize replacement ${replacement}`, async (t) => {
    const check = (name: string) => ({
      name,
      argv: [
        process.execPath,
        "--eval",
        `require('node:fs').writeFileSync('${name}', 'ran'); process.exit(1)`,
      ],
      timeoutMs: 2000,
    });
    const h = await fixture(t, [check("original")]);
    const confirmation = Promise.withResolvers<boolean>();
    const prompted = Promise.withResolvers<void>();
    const pendingConfirm = t.mock.method(h.ctx.ui, "confirm", async () => {
      prompted.resolve();
      return confirmation.promise;
    });
    const pendingGate = h.command("gate");
    await prompted.promise;
    pendingConfirm.mock.restore();
    await writeFile(
      join(h.root, "jevons.json"),
      JSON.stringify({ checks: [check("replacement")] }),
    );
    if (replacement === "session") {
      await h.emit("session_before_switch", { reason: "new" });
      h.session.id = "second";
      await h.emit("session_start", { reason: "new" });
    }
    await h.command("on");
    confirmation.resolve(true);
    await pendingGate;
    const files = await readdir(h.root);
    assert.ok(!files.includes("original") && !files.includes("replacement"));
    await h.command("gate");
    assert.equal(await readFile(join(h.root, "replacement"), "utf8"), "ran");
    assert.ok(!(await readdir(h.root)).includes("original"));
    assert.equal(h.requests.length, 0);
  });
}

test("administrative replies are displayed without waiting for another user turn", async (t) => {
  const h = await fixture(t);
  for (const action of ["settings", "usage", "activity"]) {
    const before = h.sent.length;
    await h.command(action);
    assert.equal(h.sent.length, before + 1);
    const [message, options] = h.sent.at(-1)!;
    assert.equal(message.display, true);
    assert.ok(message.content.length > 0);
    assert.notEqual(options?.deliverAs, "nextTurn");
    assert.equal(options?.triggerTurn, false);
  }
  assert.equal(h.requests.length, 0);
});
