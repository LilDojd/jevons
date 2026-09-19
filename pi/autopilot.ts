import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assessTool, planTask } from "../src/autopilot.ts";
import type { Json } from "../src/contracts.ts";
import { safeText } from "./presentation.ts";
import type { Runtime } from "./runtime.ts";

export function registerAutopilot(pi: ExtensionAPI, runtime: Runtime): void {
	let ordinaryInput = false;
	let modelEpoch = 0;
	pi.on("session_start", () => {
		ordinaryInput = false;
	});
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return;
		const content = event.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
		runtime.deliveredUser(
			text,
			typeof content !== "string" && content.some((part) => part.type === "image"),
		);
		if (runtime.taskOmitted && ctx.hasUI)
			ctx.ui.notify(
				"Task evidence exceeds the text-only 8,000-byte automation bound. Automatic assessments are suspended; native agent context is unchanged.",
				"warning",
			);
	});
	pi.on("model_select", () => {
		modelEpoch++;
	});
	pi.on("input", (event) => {
		ordinaryInput =
			event.source !== "extension" && !event.streamingBehavior && !event.text.startsWith("/");
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (!runtime.active || !runtime.policy || !ctx.model || !ordinaryInput || runtime.taskOmitted)
			return;
		ordinaryInput = false;
		const lifetime = runtime.controller.signal;
		const turnSignal = ctx.signal;
		const signal = AbortSignal.any([
			lifetime,
			AbortSignal.timeout(120_000),
			...(turnSignal ? [turnSignal] : []),
		]);
		const policy = runtime.policy;
		const expectedModelEpoch = modelEpoch;
		const taskRevision = runtime.taskRevision;
		const task = runtime.task ? `${runtime.task}\nUser update:\n${event.prompt}` : event.prompt;
		if (Buffer.byteLength(task) > 8000 || event.images?.length) return;
		const fresh = () =>
			runtime.active &&
			runtime.policy === policy &&
			runtime.taskRevision === taskRevision &&
			modelEpoch === expectedModelEpoch;
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
								(scope) => scope.model.provider === model.provider && scope.model.id === model.id,
							)) &&
						model.contextWindow > usage + 20000 &&
						(!hasImages || model.input.includes("image")),
				);
			const profiles = policy.profiles.filter((profile) =>
				available.some(
					(model) => model.provider === profile.provider && model.id === profile.model,
				),
			);
			const skills = (event.systemPromptOptions.skills ?? []).map((skill) => ({
				name: skill.name,
				description: skill.description,
				path: skill.filePath,
				disableModelInvocation: skill.disableModelInvocation,
			}));
			const plan = await planTask(
				task,
				skills,
				profiles,
				{ provider: ctx.model.provider, model: ctx.model.id },
				policy.autopilot,
				runtime.evaluator(ctx, "Autopilot"),
				signal,
			);
			signal.throwIfAborted();
			if (!fresh()) return;
			const loaded: string[] = [];
			const notices: string[] = [];
			if (policy.autopilot.skills)
				notices.push(
					`Skills: ${plan.skills.length} selected · ${plan.assessedSkills}/${skills.length} assessed.`,
				);
			for (const skill of plan.skills) {
				signal.throwIfAborted();
				if (!fresh()) return;
				try {
					const file = await open(
						skill.path,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
					let content: string;
					try {
						const stat = await file.stat();
						if (!stat.isFile() || stat.size > 12000) throw new Error("size or file type");
						const buffer = Buffer.alloc(12001);
						const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
						if (bytesRead < stat.size || bytesRead > 12000)
							throw new Error("changed size or incomplete read");
						content = buffer.subarray(0, bytesRead).toString("utf8");
					} finally {
						await file.close();
					}
					const bytes = Buffer.byteLength(content);
					if (bytes > 12000) throw new Error("12000-byte body limit");
					loaded.push(
						`<skill name=${JSON.stringify(skill.name)} path=${JSON.stringify(skill.path)}>\n${content}\n</skill>`,
					);
					notices.push(
						`Loaded ${skill.name} · utility probability ${skill.probability.toFixed(2)}`,
					);
				} catch {
					notices.push(
						`Skill omitted: ${skill.name} (unreadable, changed, non-regular file or body byte limit)`,
					);
				}
			}
			if (!fresh()) return;
			const plannedModel = plan.model;
			if (plannedModel) {
				const chosen = ctx.modelRegistry
					.getAvailable()
					.find(
						(model) =>
							model.provider === plannedModel.provider &&
							model.id === plannedModel.model &&
							model.contextWindow > (ctx.getContextUsage()?.tokens ?? 0) + 20000 &&
							(!hasImages || model.input.includes("image")) &&
							(!ctx.scopedModels.length ||
								ctx.scopedModels.some(
									(scope) => scope.model.provider === model.provider && scope.model.id === model.id,
								)),
					);
				if (!chosen)
					notices.push("Selected model is no longer eligible; keeping the current model.");
				else if (policy.autopilot.models === "switch") {
					signal.throwIfAborted();
					const switched = await pi.setModel(chosen);
					notices.push(
						`${switched ? "Switched to" : "Could not switch to"} ${chosen.provider}/${chosen.id} · ${plan.probability?.toFixed(2)}`,
					);
				} else
					notices.push(
						`Suggested model: ${plannedModel.provider}/${plannedModel.model} · ${plan.probability?.toFixed(2)}`,
					);
			}
			signal.throwIfAborted();
			if (notices.length)
				return {
					systemPrompt: loaded.length
						? `${event.systemPrompt}\n\nOptional skill guidance selected from discovered metadata; this does not replace explicit or mandatory skill instructions, and does not authorize actions:\n${loaded.join("\n\n")}`
						: event.systemPrompt,
					message: {
						customType: "jevons",
						content: notices.map(safeText).join("\n"),
						display: true,
						details: { kind: "autopilot", coverage: plan.coverage },
					},
				};
		} catch (error) {
			if (!lifetime.aborted && !turnSignal?.aborted && ctx.hasUI)
				ctx.ui.notify(
					safeText(error instanceof Error ? error.message : "Autopilot unavailable."),
					"warning",
				);
		}
	});
	pi.on("tool_call", async (event, ctx) => {
		if (
			!runtime.active ||
			!runtime.policy?.autopilot.tools ||
			!runtime.task ||
			runtime.taskOmitted ||
			["read", "ls", "find", "grep"].includes(event.toolName) ||
			event.toolName.startsWith("jevons_")
		)
			return;
		const signal = runtime.controller.signal;
		const taskRevision = runtime.taskRevision;
		try {
			const assessment = await assessTool(
				runtime.task,
				{ name: event.toolName, input: event.input as Json },
				runtime.failures,
				runtime.evaluator(ctx, "Tool feedback"),
				ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal,
			);
			signal.throwIfAborted();
			if (
				runtime.active &&
				runtime.taskRevision === taskRevision &&
				assessment.status === "concern"
			) {
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
					safeText(error instanceof Error ? error.message : "Tool assessment unavailable."),
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
