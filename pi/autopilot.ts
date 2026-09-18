import { readFile, lstat } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessTool, planTask } from "../src/autopilot.ts";
import type { Json } from "../src/contracts.ts";
import type { Runtime } from "./runtime.ts";
import { safeText } from "./presentation.ts";

export function registerAutopilot(pi: ExtensionAPI, runtime: Runtime): void {
  let ordinaryInput = false;
  let initialMessage = false;
  let modelEpoch = 0;
  pi.on("session_start", () => {
    ordinaryInput = false;
    initialMessage = false;
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    if (initialMessage) {
      initialMessage = false;
      return;
    }
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (!text || !runtime.task) return;
    const updated = `${runtime.task}\nUser update:\n${text}`;
    if (Buffer.byteLength(updated) <= 8000) runtime.task = updated;
    else {
      runtime.task = "";
      if (ctx.hasUI)
        ctx.ui.notify(
          "Task context exceeds 8,000 bytes; tool feedback is suspended until a new task.",
          "warning",
        );
    }
  });
  pi.on("model_select", () => {
    modelEpoch++;
  });
  pi.on("input", (event, ctx) => {
    ordinaryInput =
      event.source !== "extension" &&
      !event.streamingBehavior &&
      !event.text.startsWith("/");
    if (ordinaryInput) {
      initialMessage = true;
      runtime.task = Buffer.byteLength(event.text) <= 8000 ? event.text : "";
      if (!runtime.task && ctx.hasUI)
        ctx.ui.notify(
          "Task context exceeds 8,000 bytes; autopilot is suspended until a new task.",
          "warning",
        );
      runtime.failures = 0;
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (
      !runtime.active ||
      !runtime.policy ||
      !ctx.model ||
      !ordinaryInput ||
      !runtime.task
    )
      return;
    ordinaryInput = false;
    const signal = runtime.controller.signal;
    const policy = runtime.policy;
    const expectedModelEpoch = modelEpoch;
    try {
      const usage = ctx.getContextUsage()?.tokens ?? 0;
      const hasImages =
        Boolean(event.images?.length) ||
        ctx.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              "content" in entry.message &&
              Array.isArray(entry.message.content) &&
              entry.message.content.some((part) => part.type === "image"),
          );
      const available = ctx.modelRegistry
        .getAvailable()
        .filter(
          (model) =>
            (!ctx.scopedModels.length ||
              ctx.scopedModels.some(
                (scope) =>
                  scope.model.provider === model.provider &&
                  scope.model.id === model.id,
              )) &&
            model.contextWindow > usage + 20000 &&
            (!hasImages || model.input.includes("image")),
        );
      const profiles = policy.profiles.filter((profile) =>
        available.some(
          (model) =>
            model.provider === profile.provider && model.id === profile.model,
        ),
      );
      const skills = (event.systemPromptOptions.skills ?? [])
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: skill.filePath,
        }));
      const plan = await planTask(
        runtime.task,
        skills,
        profiles,
        { provider: ctx.model.provider, model: ctx.model.id },
        policy.autopilot,
        runtime.evaluator(ctx, "Autopilot"),
        signal,
      );
      signal.throwIfAborted();
      if (!runtime.active || modelEpoch !== expectedModelEpoch) return;
      const loaded: string[] = [];
      const notices: string[] = [];
      let skillBytes = 0;
      for (const skill of plan.skills.slice(0, 3)) {
        const stat = await lstat(skill.path);
        if (
          !stat.isFile() ||
          stat.size > 12000 ||
          skillBytes + stat.size > 20000
        ) {
          notices.push(`Skill omitted: ${skill.name} (size or file type)`);
          continue;
        }
        const content = await readFile(skill.path, {
          encoding: "utf8",
          signal,
        });
        if (Buffer.byteLength(content) > 12000) {
          notices.push(`Skill omitted: ${skill.name} (changed size)`);
          continue;
        }
        skillBytes += Buffer.byteLength(content);
        loaded.push(
          `<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.path)}>\n${content}\n</skill>`,
        );
        notices.push(`Loaded ${skill.name} · ${skill.probability.toFixed(2)}`);
      }
      if (plan.skills.length > 3)
        notices.push(
          `${plan.skills.length - 3} additional skill matches not loaded`,
        );
      if (!runtime.active || modelEpoch !== expectedModelEpoch) return;
      if (plan.model) {
        const chosen = ctx.modelRegistry
          .getAvailable()
          .find(
            (model) =>
              model.provider === plan.model!.provider &&
              model.id === plan.model!.model &&
              model.contextWindow >
                (ctx.getContextUsage()?.tokens ?? 0) + 20000 &&
              (!hasImages || model.input.includes("image")) &&
              (!ctx.scopedModels.length ||
                ctx.scopedModels.some(
                  (scope) =>
                    scope.model.provider === model.provider &&
                    scope.model.id === model.id,
                )),
          );
        if (!chosen)
          notices.push(
            "Selected model is no longer eligible; keeping the current model.",
          );
        else if (policy.autopilot.models === "switch") {
          signal.throwIfAborted();
          const switched = await pi.setModel(chosen);
          notices.push(
            `${switched ? "Switched to" : "Could not switch to"} ${chosen.provider}/${chosen.id} · ${plan.probability?.toFixed(2)}`,
          );
        } else
          notices.push(
            `Suggested model: ${plan.model.provider}/${plan.model.model} · ${plan.probability?.toFixed(2)}`,
          );
      }
      signal.throwIfAborted();
      if (notices.length)
        return {
          systemPrompt: loaded.length
            ? `${event.systemPrompt}\n\nSelected skill instructions:\n${loaded.join("\n\n")}`
            : event.systemPrompt,
          message: {
            customType: "jevons",
            content: notices.map(safeText).join("\n"),
            display: true,
            details: { coverage: plan.coverage },
          },
        };
    } catch (error) {
      if (!signal.aborted && ctx.hasUI)
        ctx.ui.notify(
          safeText(
            error instanceof Error ? error.message : "Autopilot unavailable.",
          ),
          "warning",
        );
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (
      !runtime.active ||
      !runtime.policy?.autopilot.tools ||
      !runtime.task ||
      ["read", "ls", "find", "grep"].includes(event.toolName) ||
      event.toolName.startsWith("jevons_")
    )
      return;
    const signal = runtime.controller.signal;
    try {
      const assessment = await assessTool(
        runtime.task,
        { name: event.toolName, input: event.input as Json },
        runtime.failures,
        runtime.evaluator(ctx, "Tool feedback"),
        ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
      );
      signal.throwIfAborted();
      if (runtime.active && assessment.status === "concern") {
        const text = `Tool concern: ${event.toolName} · data loss ${assessment.probabilities.destructiveDataLoss.toFixed(2)} · task mismatch ${assessment.probabilities.taskMismatch.toFixed(2)} · recent failures ${runtime.failures}`;
        pi.sendMessage(
          { customType: "jevons", content: text, display: true },
          { deliverAs: "steer", triggerTurn: false },
        );
        if (ctx.hasUI) ctx.ui.notify(text, "warning");
      }
    } catch (error) {
      if (!signal.aborted && ctx.hasUI)
        ctx.ui.notify(
          safeText(
            error instanceof Error
              ? error.message
              : "Tool assessment unavailable.",
          ),
          "warning",
        );
    }
  });
  pi.on("tool_result", (event) => {
    if (!event.toolName.startsWith("jevons_"))
      runtime.failures = event.isError ? runtime.failures + 1 : 0;
    if (
      !event.isError &&
      ["write", "edit"].includes(event.toolName) &&
      typeof event.input.path === "string"
    )
      runtime.edits.add(event.input.path);
  });
}
