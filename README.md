# Jevons

![100% slop](https://img.shields.io/badge/%F0%9F%A4%96%20100%25-slop-a3e635?style=plastic&labelColor=4c1d95 "100% LLM-generated")

Jevons is a [Pi](https://github.com/badlogic/pi-mono) extension that uses TypeSafe's Jev model to select useful skills, review code changes and help the coding agent recover from failed tool calls. It can also select project checks for you to run.

Jev provides judgments. Jevons controls what runs, checks whether the evidence is still current and reports what it could not assess. Reviews do not replace tests or approve a merge.

## Start

You need [devenv](https://devenv.sh/), a checkout of this repository and a TypeSafe API key. Set `TYPESAFE_API_KEY` in the environment of the Pi process, then run these commands from the repository root:

```sh
devenv shell
bun install --frozen-lockfile --ignore-scripts
pi --no-extensions -e "$PWD/pi/extension.ts"
```

**Loading Jevons enables network sharing in trusted projects.** It may send task text, skill descriptions, tool arguments, selected source and limited diagnostic output to TypeSafe. Untrusted projects stay disabled. Only load the extension where you permit this sharing.

Use `/jevons` to open the action menu. `/jevons pause` cancels Jevons work and stops new requests; `/jevons on` resumes sharing with the active settings. A new session or extension reload enables Jevons again in trusted projects.

Keep credentials outside Git and the Nix store. A local `.env` is ignored by Git but is not loaded automatically. The command above does not change global Pi configuration.

## Commands

| Command                 | Action                                                    |
| ----------------------- | --------------------------------------------------------- |
| `/jevons`               | Open the action menu                                      |
| `/jevons on`            | Load active settings and resume sharing                   |
| `/jevons pause`         | Cancel Jevons work and stop requests                      |
| `/jevons settings`      | Edit settings for this session branch                     |
| `/jevons ask QUESTION`  | Supply context and ask Jev a focused question             |
| `/jevons review PATH…`  | Review paths; with no paths, review the working-copy diff |
| `/jevons review PR_URL` | Review a pinned GitHub PR diff fetched with `gh`          |
| `/jevons gate PATH…`    | Select checks, confirm execution, then review             |
| `/jevons usage`         | Show session token totals and unknown usage               |
| `/jevons activity PAGE` | Show activity without source text, 20 entries per page    |

Expand results with **Ctrl+O** to see questions, criteria, probability distributions, actual model versions, usage and coverage. The footer shows Jev input/output token totals. Usage and activity remain available offline while paused.

The coding agent can also call `jevons_review` and `jevons_decide`. Pass paths containing spaces in the review tool's `paths` array. Explicit review includes shell and external edits; automatic review covers successful `edit` and `write` calls. PR review does not check out or execute the fetched code.

## Settings

Run `/jevons settings` in an interactive, trusted project. The searchable settings list lets you change toggles and thresholds immediately. You can also choose a question writer or open **Edit all settings (JSON)** for model profiles, review rules, checks and exact values.

Changes are saved in Pi's history for the current session branch, not in project or global configuration files. They survive resume and reload, and take precedence over `jevons.json`, including when you run `/jevons on`. **Reset to project settings** removes the override and reloads `jevons.json`, or the built-in defaults if that file is absent.

Changing settings cancels in-flight Jev requests and project checks, not the native coding agent. A paused session stays paused.

### Project configuration

An optional `jevons.json` supplies project settings in trusted projects. Without a session override, file changes apply on `/jevons on` or extension reload. This example shows the main defaults and adds a mandatory test command; no checks are configured by default.

```json
{
  "model": "jev-1.13.0",
  "autopilot": {
    "skills": true,
    "models": "suggest",
    "tools": false,
    "threshold": 0.8
  },
  "recovery": {
    "mode": "shadow",
    "retryConcern": 0.85,
    "userConcern": 0.9,
    "cooldownTurns": 3,
    "maxInterventions": 2
  },
  "profiles": [],
  "review": {
    "automatic": true,
    "investigate": false,
    "investigateConcern": 0.9,
    "concern": 0.8,
    "clear": 0.2
  },
  "verification": { "select": true, "relevance": 0.6 },
  "checks": [
    {
      "name": "tests",
      "description": "Behavior and failure-boundary tests for the project",
      "mandatory": true,
      "argv": ["devenv", "shell", "--", "bun", "test"],
      "timeoutMs": 60000
    }
  ]
}
```

Model profiles use `{ "provider": "…", "model": "…", "description": "When this model is useful" }`. Jevons considers supplied descriptions, credentials and context/image capacity; it does not infer capabilities from model names. Routing suggests a model by default. It does not escalate models in response to failures.

Set `writer` to `{ "provider": "…", "model": "…" }` to choose who turns free-text questions into structured questions. Otherwise, the current coding model does this at its provider's normal cost. Typed `jevons_decide` questions need no writer: `noul` asks for a probability, `choice` compares named options, and `score` uses a rubric. Questions are answered independently; include shared evidence in named state fields and do calculations in code.

## Automatic help

- **Skills:** Jevons assesses up to 31 eligible descriptions from the first 512 discovered entries, then loads up to three useful skills—or none. Admission follows discovery order, not word overlap. Omitted skills are reported but not judged. Explicit and mandatory instructions remain in place. Loaded skill bodies are limited to 12,000 bytes each and 20,000 bytes combined.
- **Failure recovery:** Jevons examines completed tool outcomes. Default `shadow` mode records proposed responses without interrupting. Set `recovery.mode` to `steer` for fixed replan or ask-user guidance, or `off` to disable it. Jev never generates recovery commands. Defaults allow two interventions per session, separated by three completed turns; reloads and branch navigation do not reset the cap.
- **Review:** Automatic review is on. Each changed chunk is assessed against each configured rule. Default rules cover correctness, unnecessary complexity, clarity and behavioral tests. Replace `review.rules` with `{ "id", "label", "instructions" }` entries to supply your own concerns.
- **Investigation:** Off by default. With `review.investigate` enabled, a complete local review with sufficiently high concern can prompt one focused follow-up per unchanged snapshot. The agent may read one relevant definition, caller or test, then explain whether the concern is supported, unsupported or unresolved. This is not a request to fix the code.
- **Pre-tool feedback:** Off by default. Set `autopilot.tools` to `true` to request advice before tool calls; this does not grant execution permission.

The default test-review rule follows Google's [Test Behavior, Not Implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html) and [Change-Detector Tests](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html). Tests should catch broken behavior rather than changes to source layout or incidental wording. Necessary safety boundaries are not unnecessary complexity.

## Checks and review results

`/jevons gate` selects from your configured commands and asks for confirmation before running them. Jev does not generate commands. Checks are mandatory unless marked `"mandatory": false`; give optional checks descriptions so Jev can assess relevance.

Uncertain or missing judgments keep optional checks selected. At the default `verification.relevance` of `0.6`, only probabilities below `0.4` exclude a check. Set `verification.select` to `false` to select every configured check without asking Jev.

All selected checks are attempted even if an earlier one fails, unless you cancel. Actual exit status determines success. No checks run means **unverified**, not passed. Failed, stale or unverified checks stop the gate before review. Automatic review never runs project checks.

Check selection covers the whole workspace, even when the later review is limited to paths. Changes to the task, workspace parent or diff invalidate check observations. Changes to ignored files, external services and the toolchain are not tracked.

Review results show missing, uncertain and stale evidence. A failed request or two-minute deadline returns partial coverage. A probability is a model judgment, not proof of a defect; configured thresholds are not calibrated guarantees.

## Privacy and costs

TypeSafe receives the context described in [Start](#start). Free-text questions also send your explicit context to the question writer's provider. Keep secrets out of prompts: credential and sensitive-path filters are best-effort, and Pi stores ordinary tool arguments in its transcript.

There is no spending cap. `/jevons usage` reconstructs reported token totals from activity records across the session's branches. Unknown usage is shown as unknown, not zero. Writer usage appears separately in decision details; Pi tracks the coding model's usage.

Requests have no automatic billed retries. A request failure pauses sharing; use `/jevons on` to resume. Permission to share context does not grant permission to run project code, delete files, publish changes or access credentials.

## Context limits

Jevons limits serialized requests to 48,000 UTF-8 bytes, and state plus the longest question to 24,000 bytes. These are byte limits, not exact token counts; the SDK has no preflight tokenizer.

Review keeps whole diff hunks where possible, splits larger hunks into chunks of at most 8,000 bytes and asks at most 32 questions per request. Raw patches are limited to 4 MiB. Giant lines, binary or sensitive files, and Git-untracked files produce explicit omissions. Jujutsu normally snapshots new files. Diffs are checked again for changes before results are used; reviewing chunks in isolation cannot establish cross-file correctness.

Recovery retains four tool calls, with argument and diagnostic fields limited to 1,500 bytes each. Successful output bodies are not shared. Incomplete, oversized or unsupported diagnostics cannot trigger steering. Changes to the task, session, branch, settings or evidence invalidate pending decisions.

Compaction remains Pi-native. Pi's summaries and retained messages provide conversation history; Jevons does not replay original user text, tool diagnostics or review results. After a summary, Jevons adds a reminder that historical coverage and verification freshness are unknown. Ask for clarification when constraints are unclear, and rerun checks before claiming that the current revision is verified.

## Development

```sh
devenv shell -- bun test
devenv shell -- bun run typecheck
devenv shell -- bun run format:check
```

The pinned devenv toolchain supplies Bun and Node 24. Dependencies are pinned in `bun.lock`; core workflow logic has no runtime dependencies. There is no build step or daemon.

`perch.yaml` contains focused prose checks based on [Google's documentation style guide](https://developers.google.com/style/highlights) and [Digital.gov's plain-language guidance](https://digital.gov/guides/plain-language/writing). With Perch installed and a TypeSafe API key available, check the working README without scanning the repository:

```sh
devenv shell -- perch check README.md \
  --rules prose-concrete-opening,prose-standalone-setup,prose-useful-warnings \
  --out /tmp/jevons-prose-check
```

These checks assess selected sections, not every sentence. Their probabilities are editing advice, not proof of writing quality.
