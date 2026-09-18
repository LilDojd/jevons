import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

type RpcEvent = {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  method?: string;
  statusKey?: string;
  statusText?: string;
  prefill?: string;
  data?: {
    commands?: { name: string; source: string }[];
    entries?: {
      type: string;
      customType?: string;
      data?: { policy?: { autopilot: { skills: boolean } } };
    }[];
    assistantMessages?: number;
    toolCalls?: number;
  };
};

test(
  "real Node 24 Pi loads the extension and handles paused commands without network access",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jevons-host-"));
    const project = fileURLToPath(new URL("../", import.meta.url));
    const state = join(root, "pi-state");
    const audit = join(root, "network.json");
    const preload = join(root, "offline.mjs");
    await mkdir(state);
    await writeFile(join(state, "auth.json"), "{}");
    await writeFile(
      preload,
      [
        'import { writeFileSync } from "node:fs";',
        'import { syncBuiltinESMExports } from "node:module";',
        'import http from "node:http";',
        'import https from "node:https";',
        'import net from "node:net";',
        "const audit = { node: process.version, attempts: 0 };",
        `const save = () => writeFileSync(${JSON.stringify(audit)}, JSON.stringify(audit));`,
        'const deny = () => { audit.attempts++; save(); throw new Error("Network disabled in host test"); };',
        "globalThis.fetch = deny;",
        "http.request = http.get = https.request = https.get = deny;",
        "net.Socket.prototype.connect = deny;",
        "syncBuiltinESMExports();",
        "save();",
      ].join("\n"),
    );
    const child = spawn(
      "node",
      [
        "--import",
        preload,
        join(
          project,
          "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        ),
        "--mode",
        "rpc",
        "--no-session",
        "--approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "-e",
        join(project, "pi/extension.ts"),
      ],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          PI_CODING_AGENT_DIR: state,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_CACHE_HOME: join(root, "cache"),
          PI_OFFLINE: "1",
          NO_COLOR: "1",
        },
      },
    );
    const events: RpcEvent[] = [];
    let cancelEditor = false;
    let buffer = "",
      stderr = "",
      failure = "",
      outputBytes = 0;
    child.on("error", (error) => {
      failure = error.message;
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1024 * 1024) {
        failure = "Pi output exceeded test limit";
        child.kill("SIGKILL");
        return;
      }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as RpcEvent;
          events.push(event);
          if (
            event.type === "extension_ui_request" &&
            event.method === "editor"
          ) {
            const policy = JSON.parse(event.prefill!);
            policy.autopilot.skills = false;
            child.stdin.write(
              JSON.stringify({
                type: "extension_ui_response",
                id: event.id,
                ...(cancelEditor
                  ? { cancelled: true }
                  : { value: JSON.stringify(policy) }),
              }) + "\n",
            );
          }
        } catch {
          failure = "Invalid Pi RPC JSONL";
        }
      }
    });
    let serial = 0;
    const command = async (payload: Record<string, unknown>) => {
      const id = String(++serial);
      child.stdin.write(JSON.stringify({ id, ...payload }) + "\n");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (failure || child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Pi host unavailable: ${failure} ${stderr}`);
        const response = events.find(
          (event) => event.type === "response" && event.id === id,
        );
        if (response) {
          assert.equal(response.success, true, response.error);
          return response;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Pi RPC timed out: ${stderr}`);
    };
    try {
      const commands = await command({ type: "get_commands" });
      assert.ok(
        commands.data?.commands?.some(
          (entry) => entry.name === "jevons" && entry.source === "extension",
        ),
      );
      await command({ type: "prompt", message: "/jevons pause" });
      await command({ type: "prompt", message: "/jevons review absent.ts" });
      await command({ type: "prompt", message: "/jevons settings" });
      assert.ok(
        events.some(
          (event) =>
            event.method === "setStatus" &&
            event.statusKey === "jevons" &&
            /paused/i.test(event.statusText ?? ""),
        ),
      );
      const entries = await command({ type: "get_entries" });
      assert.ok(
        !entries.data?.entries?.some(
          (entry) => entry.customType === "jevons.receipt",
        ),
      );
      assert.equal(
        entries.data?.entries?.filter(
          (entry) => entry.customType === "jevons.settings",
        ).length,
        1,
      );
      assert.equal(
        entries.data?.entries?.find(
          (entry) => entry.customType === "jevons.settings",
        )?.data?.policy?.autopilot.skills,
        false,
      );
      cancelEditor = true;
      await command({ type: "prompt", message: "/jevons settings" });
      const editor = events.findLast((event) => event.method === "editor");
      assert.equal(JSON.parse(editor!.prefill!).autopilot.skills, false);
      const cancelled = await command({ type: "get_entries" });
      assert.equal(
        cancelled.data?.entries?.filter(
          (entry) => entry.customType === "jevons.settings",
        ).length,
        1,
      );
      const stats = await command({ type: "get_session_stats" });
      assert.equal(stats.data?.assistantMessages, 0);
      assert.equal(stats.data?.toolCalls, 0);
      await command({ type: "new_session" });
      await command({ type: "prompt", message: "/jevons pause" });
      assert.equal(
        events.some(
          (event) =>
            event.type === "agent_start" || event.type === "extension_error",
        ),
        false,
      );
      const network = JSON.parse(await readFile(audit, "utf8")) as {
        node: string;
        attempts: number;
      };
      assert.match(network.node, /^v24\./);
      assert.equal(network.attempts, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
