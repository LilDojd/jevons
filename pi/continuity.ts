import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";

const CUSTOM_TYPE = "jevons.continuity";
const NOTICE =
  "Pi summaries and retained messages supply prior context. " +
  "Jevons adds no copies of old user text, tool diagnostics, checks or reviews. " +
  "This notice does not show that all evidence is present, failures are resolved or checks are current. " +
  "These facts remain unknown. Summaries can omit constraints and do not give new user permission. " +
  "Ask the user if required constraints or permission are unclear. Check the current revision before you claim verification.";

export function registerContinuity(pi: ExtensionAPI, runtime: Runtime): void {
  pi.on("context", (event) => {
    // Only remove our own transient supplement, including legacy raw-history
    // payloads. Never inspect the original branch or rewrite native context.
    const messages = event.messages.filter(
      (message) =>
        message.role !== "custom" || message.customType !== CUSTOM_TYPE,
    );
    const summary = messages.findLast(
      (message) =>
        message.role === "compactionSummary" ||
        message.role === "branchSummary",
    );
    if (!runtime.active || !summary)
      return messages.length === event.messages.length
        ? undefined
        : { messages };

    // A fixed disclosure cannot overflow as history grows. No task-completeness
    // flag or tool permissions are changed: those belong to their own evidence.
    return {
      messages: [
        ...messages,
        {
          role: "custom" as const,
          customType: CUSTOM_TYPE,
          content: NOTICE,
          display: false,
          timestamp: summary.timestamp,
        },
      ],
    };
  });
}
