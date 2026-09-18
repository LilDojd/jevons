import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { defaultPolicy, parsePolicy } from "../pi/policy.ts";
import { Runtime } from "../pi/runtime.ts";
import { changeSetting, openSettings, settingsItems } from "../pi/settings.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "jevons-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = SessionManager.inMemory(root);
  const pi = {
    appendEntry: (type: string, data: unknown) =>
      session.appendCustomEntry(type, data),
  } as unknown as ExtensionAPI;
  const runtime = new Runtime(pi);
  const notifications: string[] = [];
  const ctx = {
    cwd: root,
    mode: "rpc",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: session,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus() {},
      editor: async () => undefined,
      custom: async () => undefined,
    },
  } as unknown as ExtensionContext;
  t.after(() => runtime.pause(ctx));
  return { root, session, pi, runtime, ctx, notifications };
}

const saved = (session: SessionManager) =>
  session
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "jevons.settings",
    );

test("settings change immediately, stay paused and persist only in the session branch", async (t) => {
  const { root, session, runtime, ctx, pi } = await fixture(t);
  const project = JSON.stringify({ recovery: { mode: "off" } });
  await writeFile(join(root, "jevons.json"), project);
  const start = session.appendMessage({
    role: "user",
    content: "Task",
    timestamp: 1,
  });
  const input = parsePolicy({
    autopilot: { skills: false },
    recovery: { mode: "steer" },
  });
  runtime.updateSettings(ctx, input);
  input.autopilot.skills = true;
  assert.equal(runtime.policy!.autopilot.skills, false);
  assert.equal(runtime.active, false);
  assert.equal(runtime.jev, undefined);
  assert.equal(saved(session).length, 1);
  const selected = session.getLeafId()!;
  assert.equal((await new Runtime(pi).readPolicy(ctx)).recovery.mode, "steer");
  session.branch(start);
  assert.equal((await runtime.readPolicy(ctx)).recovery.mode, "off");
  session.branch(selected);
  assert.equal((await runtime.readPolicy(ctx)).recovery.mode, "steer");
  const other = {
    ...ctx,
    cwd: join(root, "another-project"),
  } as ExtensionContext;
  assert.equal((await runtime.readPolicy(other)).recovery.mode, "shadow");
  await runtime.resetSettings(ctx);
  assert.equal(runtime.policy!.recovery.mode, "off");
  assert.equal((await new Runtime(pi).readPolicy(ctx)).recovery.mode, "off");
  assert.equal(runtime.active, false);
  assert.equal(await readFile(join(root, "jevons.json"), "utf8"), project);
  assert.deepEqual(await readdir(root), ["jevons.json"]);
});

test("live settings invalidate old evaluators without pausing the replacement or losing history", async (t) => {
  const { session, runtime, ctx } = await fixture(t);
  const key = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "settings-test-not-a-credential";
  t.after(() => {
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
  });
  let network = 0;
  t.mock.method(globalThis, "fetch", async () => {
    network++;
    throw new Error("Unexpected network");
  });
  await runtime.enable(ctx, true);
  const evaluate = runtime.evaluator(ctx, "old work");
  const old = runtime.controller;
  session.appendCustomEntry("jevons.recovery.state", { interventions: 2 });
  session.appendCustomEntry("jevons.receipt", {
    accounting: "reported",
    usage: { input_tokens: 12, output_tokens: 3 },
  });
  const history = session.getEntries();
  const next = structuredClone(runtime.policy!);
  next.review.automatic = false;
  runtime.updateSettings(ctx, next);
  assert.equal(old.signal.aborted, true);
  assert.equal(runtime.active, true);
  assert.equal(runtime.controller.signal.aborted, false);
  assert.equal(runtime.policy!.review.automatic, false);
  await assert.rejects(
    evaluate({
      state: {},
      questions: { q: { type: "noul", instructions: "Relevant?" } },
    }),
  );
  assert.equal(runtime.active, true);
  assert.deepEqual(session.getEntries().slice(0, history.length), history);
  assert.equal(network, 0);
});

test("invalid settings, lost trust and failed persistence leave the current generation intact", async (t) => {
  const { runtime, ctx, pi, session } = await fixture(t);
  runtime.updateSettings(ctx, defaultPolicy);
  const old = runtime.controller;
  const policy = structuredClone(runtime.policy);
  for (const invalid of [
    [],
    { model: "invalid model" },
    { recovery: { maxInterventions: -1 } },
    { review: { clear: 0.9, concern: 0.8 } },
    { autopilot: null },
    { recovery: "" },
    { extra: "x".repeat(32001) },
  ])
    assert.throws(() => runtime.updateSettings(ctx, invalid));
  assert.throws(() =>
    runtime.updateSettings({ ...ctx, isProjectTrusted: () => false }, {}),
  );
  t.mock.method(pi, "appendEntry", () => {
    throw new Error("Cannot persist");
  });
  assert.throws(() => runtime.updateSettings(ctx, {}), /persist/);
  assert.equal(runtime.controller, old);
  assert.deepEqual(runtime.policy, policy);
  assert.equal(saved(session).length, 1);
});

test("every quick setting updates its policy field without discarding custom configuration", () => {
  const original = parsePolicy({
    autopilot: { threshold: 0.83 },
    writer: { provider: "test", model: "author" },
    checks: [{ name: "test", argv: ["echo", "a b"], timeoutMs: 100 }],
  });
  for (const item of settingsItems(original)) {
    assert.ok(item.values!.includes(item.currentValue));
    const nextValue = item.values!.find(
      (value) => value !== item.currentValue,
    )!;
    const next = parsePolicy(changeSetting(original, item.id, nextValue));
    assert.equal(
      settingsItems(next).find((row) => row.id === item.id)!.currentValue,
      nextValue,
    );
    assert.deepEqual(next.writer, original.writer);
    assert.deepEqual(next.checks, original.checks);
  }
  assert.equal(original.autopilot.threshold, 0.83);
  assert.throws(() => changeSetting(original, "__proto__", "on"));
  assert.throws(() =>
    changeSetting(original, "autopilot.skills", "unexpected"),
  );
});

test("native settings list applies a toggle before closing and preserves it on Escape", async (t) => {
  const { runtime, ctx, session } = await fixture(t);
  const packageDir = process.env.PI_PACKAGE_DIR;
  delete process.env.PI_PACKAGE_DIR;
  t.after(() => {
    if (packageDir !== undefined) process.env.PI_PACKAGE_DIR = packageDir;
  });
  initTheme("dark");
  Object.assign(ctx, { mode: "tui" });
  t.mock.method(ctx.ui, "custom", async (factory: any) => {
    let closed = false;
    const component = await factory(
      { terminal: { rows: 40 }, requestRender() {} },
      { fg: (_color: string, text: string) => text },
      getKeybindings(),
      () => {
        closed = true;
      },
    );
    assert.ok(component.render(80).length);
    component.handleInput("\r");
    assert.equal(runtime.policy!.autopilot.skills, false);
    assert.equal(closed, false);
    component.handleInput("\x1b");
    assert.equal(closed, true);
    return undefined;
  });
  await openSettings(ctx, runtime);
  assert.equal(runtime.active, false);
  assert.equal(saved(session).length, 1);
});

test("JSON editing keeps invalid input for correction; cancellation and stale dialogs do not save", async (t) => {
  const { ctx, runtime, session, notifications } = await fixture(t);
  const edits = ["not JSON", '{"recovery":{"mode":"off"}}'];
  const prefills: string[] = [];
  t.mock.method(ctx.ui, "editor", async (_title: string, prefill?: string) => {
    prefills.push(prefill!);
    return edits.shift();
  });
  await openSettings(ctx, runtime);
  assert.equal(prefills[1], "not JSON");
  assert.equal(runtime.policy!.recovery.mode, "off");
  assert.equal(notifications.length, 2);
  await openSettings(ctx, runtime);
  assert.equal(saved(session).length, 1);
  t.mock.method(ctx.ui, "editor", async () => {
    runtime.pause(ctx);
    return '{"recovery":{"mode":"steer"}}';
  });
  await openSettings(ctx, runtime);
  assert.equal(saved(session).length, 1);
  assert.equal(runtime.policy!.recovery.mode, "off");
});
