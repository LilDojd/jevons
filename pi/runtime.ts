import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Evaluate, Evaluation, Policy } from "../src/contracts.ts";
import type { UsageSummary } from "../src/usage.ts";
import { summarizeUsage } from "../src/usage.ts";
import { defaultPolicy, loadPolicySync } from "./policy.ts";
import {
	applyPreferences,
	loadPreferences,
	parsePreferences,
	preferencesOf,
	savePreferences,
} from "./preferences.ts";
import { Jev } from "./service.ts";

export class Runtime {
	readonly pi: ExtensionAPI;
	readonly agentDir: string;
	policy?: Policy;
	jev?: Jev;
	controller = new AbortController();
	active = false;
	sessionId?: string;
	task = "";
	taskRevision = 0;
	taskOmitted = false;
	failures = 0;

	constructor(pi: ExtensionAPI, agentDir = getAgentDir()) {
		this.pi = pi;
		this.agentDir = agentDir;
	}

	deliveredUser(text: string, hasImages = false): void {
		this.taskRevision++;
		const updated = this.task ? `${this.task}\nUser update:\n${text}` : text;
		if (hasImages || Buffer.byteLength(updated) > 8000) this.taskOmitted = true;
		if (!this.taskOmitted) this.task = updated;
	}

	restoreTask(ctx: ExtensionContext): void {
		this.task = "";
		this.taskOmitted = false;
		this.taskRevision++;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			this.deliveredUser(
				typeof content === "string"
					? content
					: content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
				typeof content !== "string" && content.some((part) => part.type === "image"),
			);
		}
	}

	async readPolicy(ctx: ExtensionContext): Promise<Policy> {
		if (!ctx.isProjectTrusted())
			throw new Error("Trust the project before editing Jevons settings.");
		const project = loadPolicySync(ctx.cwd);
		const preferences = loadPreferences(this.agentDir);
		return preferences ? applyPreferences(project, preferences) : project;
	}

	updateSettings(ctx: ExtensionContext, input: unknown): Policy {
		if (!ctx.isProjectTrusted())
			throw new Error("Trust the project before editing Jevons settings.");
		const preferences = parsePreferences(input);
		const policy = applyPreferences(loadPolicySync(ctx.cwd), preferences);
		this.replacePolicy(ctx, policy, this.active, () => savePreferences(this.agentDir, preferences));
		return structuredClone(policy);
	}

	resetSettings(ctx: ExtensionContext): Policy {
		return this.updateSettings(ctx, preferencesOf(defaultPolicy));
	}

	async enable(ctx: ExtensionContext, confirmed = false): Promise<void> {
		if (!ctx.isProjectTrusted()) throw new Error("Trust the project before enabling Jevons.");
		if (this.controller.signal.aborted) this.controller = new AbortController();
		const opening = this.controller;
		const cwd = ctx.cwd;
		const sessionId = ctx.sessionManager.getSessionId();
		const policy = await this.readPolicy(ctx);
		opening.signal.throwIfAborted();
		if (!confirmed) {
			if (!ctx.hasUI) throw new Error("Jevons needs an interactive session to resume sharing.");
			if (
				!(await ctx.ui.confirm(
					"Enable Jevons?",
					[
						"Jevons shares conversation text, skill metadata, tool arguments, bounded diagnostic outcomes and selected source with TypeSafe.",
						"Reported token usage is visible. Jevons does not enforce token spending limits.",
						`Models: ${policy.autopilot.models}. Skills: ${policy.autopilot.skills ? "load selected" : "off"}.`,
						policy.writer
							? `Free-text questions send explicit context to ${policy.writer.provider}/${policy.writer.model} first. This has an additional provider cost.`
							: "Free-text questions send explicit context to the current coding model first. This has an additional provider cost.",
						`Recovery: ${policy.recovery.mode}. Limit: ${policy.recovery.maxInterventions} focused replan/ask-user interventions per session. Wait: ${policy.recovery.cooldownTurns} completed turns between interventions. Recovery never authorizes commands or expands permissions.`,
						"Pause cancels Jevons work. Requests may incur charges. Jevons does not retry automatically.",
					].join("\n"),
					{ signal: this.controller.signal },
				))
			)
				return;
		}
		opening.signal.throwIfAborted();
		if (
			!ctx.isProjectTrusted() ||
			ctx.cwd !== cwd ||
			ctx.sessionManager.getSessionId() !== sessionId
		)
			throw new Error("Settings context changed. Reopen settings.");
		this.replacePolicy(ctx, policy, true);
	}

	private replacePolicy(
		ctx: ExtensionContext,
		policy: Policy,
		active: boolean,
		persist?: () => void,
	): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const jev = active
			? new Jev({
					model: policy.model,
					record: (receipt) => {
						// appendEntry targets the current session, not the request's old session.
						if (this.sessionId === sessionId) this.pi.appendEntry("jevons.receipt", receipt);
					},
				})
			: undefined;
		persist?.();
		this.controller.abort();
		this.controller = new AbortController();
		this.policy = policy;
		this.sessionId = sessionId;
		this.jev = jev;
		this.active = active;
		this.status(ctx);
	}

	pause(ctx: ExtensionContext): void {
		this.active = false;
		this.controller.abort();
		// Distinguish navigation/reload even if the previous generation was already paused.
		this.controller = new AbortController();
		this.controller.abort();
		this.status(ctx);
	}

	usageSummary(ctx: ExtensionContext): UsageSummary {
		// Branch navigation cannot undo already incurred usage.
		return summarizeUsage(
			ctx.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom" && entry.customType === "jevons.receipt" ? [entry.data] : [],
				),
		);
	}

	status(ctx: ExtensionContext, activity?: string): void {
		const usage = this.usageSummary(ctx);
		const tokens = ` · ${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out${usage.unknown ? ` · ${usage.unknown} unknown` : ""}`;
		if (ctx.hasUI)
			ctx.ui.setStatus(
				"jevons",
				`Jevons · ${this.active ? (activity ?? "on") : "paused"}${tokens} · /jevons`,
			);
	}

	evaluator(ctx: ExtensionContext, purpose: string): Evaluate {
		if (!this.active || !this.jev) throw new Error("Jevons is paused. Use /jevons on.");
		const jev = this.jev;
		const lifetime = this.controller.signal;
		return async (request, signal) => {
			lifetime.throwIfAborted();
			if (!this.active || this.jev !== jev) throw new Error("Jevons is paused. Use /jevons on.");
			this.status(ctx, purpose);
			let result: Evaluation;
			try {
				result = await jev.evaluate(
					purpose,
					request,
					AbortSignal.any([lifetime, ...(signal ? [signal] : [])]),
				);
			} catch (error) {
				if (this.controller.signal === lifetime) this.active = false;
				throw error;
			} finally {
				if (this.controller.signal === lifetime) this.status(ctx);
			}
			lifetime.throwIfAborted();
			signal?.throwIfAborted();
			if (this.jev !== jev) throw new Error("Jevons session changed.");
			return result;
		};
	}
}
