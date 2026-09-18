import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Evaluate, Evaluation, Policy } from "../src/contracts.ts";
import { summarizeUsage } from "../src/usage.ts";
import type { UsageSummary } from "../src/usage.ts";
import { Jev } from "./service.ts";
import { loadPolicy, parsePolicy } from "./policy.ts";

export class Runtime {
  readonly pi: ExtensionAPI;
  policy?: Policy;
  jev?: Jev;
  controller = new AbortController();
  active = false;
  sessionId?: string;
  task = "";
  taskRevision = 0;
  taskOmitted = false;
  failures = 0;
  readonly edits = new Set<string>();

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
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
        typeof content !== "string" &&
          content.some((part) => part.type === "image"),
      );
    }
  }

  async readPolicy(ctx: ExtensionContext): Promise<Policy> {
    if (!ctx.isProjectTrusted())
      throw new Error("Trust the project before editing Jevons settings.");
    const entry = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "custom" && entry.customType === "jevons.settings",
      );
    if (entry?.type === "custom") {
      const data = entry.data as
        { version?: unknown; cwd?: unknown; policy?: unknown } | undefined;
      if (data?.cwd === ctx.cwd) {
        if (data.version !== 1)
          throw new Error("Unsupported Jevons session settings version.");
        if (data.policy !== null) return parsePolicy(data.policy);
      }
    }
    return loadPolicy(ctx.cwd);
  }

  updateSettings(ctx: ExtensionContext, input: unknown): void {
    if (!ctx.isProjectTrusted())
      throw new Error("Trust the project before editing Jevons settings.");
    const policy = parsePolicy(input);
    this.replacePolicy(ctx, policy, this.active, policy);
  }

  async resetSettings(ctx: ExtensionContext): Promise<void> {
    if (!ctx.isProjectTrusted())
      throw new Error("Trust the project before editing Jevons settings.");
    const controller = this.controller;
    const policy = await loadPolicy(ctx.cwd);
    if (controller !== this.controller || !ctx.isProjectTrusted())
      throw new Error("Settings context changed; reopen settings.");
    this.replacePolicy(ctx, policy, this.active, null);
  }

  async enable(ctx: ExtensionContext, confirmed = false): Promise<void> {
    if (!ctx.isProjectTrusted())
      throw new Error("Trust the project before enabling Jevons.");
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const opening = this.controller;
    const policy = await this.readPolicy(ctx);
    opening.signal.throwIfAborted();
    if (!confirmed) {
      if (!ctx.hasUI)
        throw new Error(
          "Jevons needs an interactive session to resume sharing.",
        );
      if (
        !(await ctx.ui.confirm(
          "Enable Jevons?",
          [
            "Shares task text, skill metadata, tool arguments, bounded diagnostic outcomes and selected source with TypeSafe. Explicit PR reviews fetch source from github.com using gh.",
            "Reported token usage is visible; no token spending limits are enforced.",
            `Models: ${policy.autopilot.models}. Skills: ${policy.autopilot.skills ? "load selected" : "off"}. Automatic review: ${policy.review.automatic ? "on" : "off"}.`,
            policy.writer
              ? `Free-text questions send explicit context to ${policy.writer.provider}/${policy.writer.model} first; additional provider cost.`
              : "Free-text questions send explicit context to the current coding model first; additional provider cost.",
            `Recovery: ${policy.recovery.mode}; at most ${policy.recovery.maxInterventions} focused replan/ask-user interventions per session, with ${policy.recovery.cooldownTurns} completed turns between them. Never authorizes commands or expands permissions. Pi handles compaction; Jevons does not replay historical source.`,
            "Pause cancels work. Requests may incur charges; no automatic retries.",
          ].join("\n"),
          { signal: this.controller.signal },
        ))
      )
        return;
    }
    opening.signal.throwIfAborted();
    this.replacePolicy(ctx, policy, true);
  }

  private replacePolicy(
    ctx: ExtensionContext,
    policy: Policy,
    active: boolean,
    checkpoint?: Policy | null,
  ): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const jev = active
      ? new Jev({
          model: policy.model,
          record: (receipt) => {
            if (this.sessionId === sessionId)
              this.pi.appendEntry("jevons.receipt", receipt);
          },
        })
      : undefined;
    if (checkpoint !== undefined)
      this.pi.appendEntry("jevons.settings", {
        version: 1,
        cwd: ctx.cwd,
        policy: structuredClone(checkpoint),
      });
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
          entry.type === "custom" && entry.customType === "jevons.receipt"
            ? [entry.data]
            : [],
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
    if (!this.active || !this.jev)
      throw new Error("Jevons is paused. Use /jevons on.");
    const jev = this.jev;
    const lifetime = this.controller.signal;
    return async (request, signal) => {
      lifetime.throwIfAborted();
      if (!this.active || this.jev !== jev)
        throw new Error("Jevons is paused. Use /jevons on.");
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
