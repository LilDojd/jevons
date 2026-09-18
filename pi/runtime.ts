import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Evaluate, Evaluation, Policy } from "../src/contracts.ts";
import { Budget } from "../src/budget.ts";
import type { BudgetUsage } from "../src/budget.ts";
import { Jev } from "./service.ts";
import { loadPolicy } from "./policy.ts";

export class Runtime {
  readonly pi: ExtensionAPI;
  policy?: Policy;
  jev?: Jev;
  usage?: BudgetUsage;
  controller = new AbortController();
  active = false;
  sessionId?: string;
  task = "";
  failures = 0;
  readonly edits = new Set<string>();

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  async enable(ctx: ExtensionContext, confirmed = false): Promise<void> {
    if (!ctx.isProjectTrusted())
      throw new Error("Trust the project before enabling Jevons.");
    if (this.controller.signal.aborted) this.controller = new AbortController();
    const opening = this.controller;
    const policy = await loadPolicy(ctx.cwd);
    opening.signal.throwIfAborted();
    if (!confirmed) {
      if (!ctx.hasUI)
        throw new Error("Start Pi with --jevons to enable network access.");
      if (
        !(await ctx.ui.confirm(
          "Enable Jevons?",
          [
            "Shares task text, skill metadata, proposed tool arguments and selected source with TypeSafe. Explicit PR reviews fetch source from github.com using gh.",
            `Budget: ${policy.budget.sessionTokens.toLocaleString()} tokens/session; ${policy.budget.dayTokens.toLocaleString()} tokens/project UTC day.`,
            `Models: ${policy.autopilot.models}. Skills: ${policy.autopilot.skills ? "load selected" : "off"}. Automatic review: ${policy.review.automatic ? "on" : "off"}.`,
            policy.writer
              ? `Free-text questions send explicit context to ${policy.writer.provider}/${policy.writer.model} first; additional provider cost.`
              : "Free-text questions send explicit context to the current coding model first; additional provider cost.",
            "Pause cancels work. Requests may incur charges; no automatic retries.",
          ].join("\n"),
          { signal: this.controller.signal },
        ))
      )
        return;
    }
    opening.signal.throwIfAborted();
    this.pause(ctx);
    this.controller = new AbortController();
    this.policy = policy;
    const sessionId = ctx.sessionManager.getSessionId();
    this.sessionId = sessionId;
    this.jev = new Jev({
      budget: new Budget(
        join(ctx.cwd, ".jevons", "budget"),
        sessionId,
        policy.budget,
      ),
      model: policy.model,
      record: (receipt) => {
        if (this.sessionId === sessionId)
          this.pi.appendEntry("jevons.receipt", receipt);
      },
    });
    const ready = this.controller.signal;
    const usage = await this.jev.budget.usage();
    ready.throwIfAborted();
    this.usage = usage;
    this.active = true;
    this.status(ctx);
  }

  pause(ctx: ExtensionContext): void {
    this.active = false;
    this.controller.abort();
    this.status(ctx);
  }

  status(ctx: ExtensionContext, activity?: string): void {
    const budget = this.usage
      ? ` · ${this.usage.session.toLocaleString()}/${this.policy!.budget.sessionTokens.toLocaleString()} tokens${this.usage.pending ? ` (${this.usage.pending} pending)` : ""}`
      : "";
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "jevons",
        `Jevons · ${this.active ? (activity ?? "on") : "paused"}${budget} · /jevons`,
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
        if (this.controller.signal === lifetime) {
          const usage = await jev.budget.usage().catch(() => undefined);
          if (this.controller.signal === lifetime) {
            this.usage = usage;
            this.status(ctx);
          }
        }
      }
      lifetime.throwIfAborted();
      signal?.throwIfAborted();
      if (this.jev !== jev) throw new Error("Jevons session changed.");
      return result;
    };
  }
}
