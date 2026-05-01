# Changelog

All notable changes to Apex Doctor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] — 2026-05-01

### Added

- **📜 Execution-path diff (line-level log diff)** — the Compare Two Logs view now includes an event-by-event diff of significant log events: METHOD_ENTRY, SOQL, DML, code units, debugs, exceptions, callouts, test pass/fail. LCS-based, so insertions / removals / changed events show up exactly where they diverge, with green/red/amber highlighting and per-row markers (`+ − ~`). Reveals "the optimisation skipped the validator entirely" or "the second run took the else branch" — questions the summary deltas can't answer alone.
- **🧪 Anonymous Apex playground** — write Apex in a scratch editor, click "▶ Run with Apex Doctor" in the status bar (or run `Apex Doctor: Run This Anonymous Apex`), and the extension executes it via `sf apex run`, polls the org for the resulting log, downloads it, and analyses it — all in one progress dialog. Pair with the Trace Flag Manager so the running user has logging enabled.
- New commands: `Apex Doctor: Open Anonymous Apex Editor`, `Apex Doctor: Run This Anonymous Apex`.
- `SalesforceService.runAnonymousApex()` and `getMostRecentLogId()` for the run-and-analyse loop.

### Tests

- 31 passing (was 28). New coverage for the LCS line-diff: identical streams, single-event insertions, fingerprint stability across timestamp drift.

## [0.7.0] — 2026-05-01

### Added

- **🔎 SOQL Query Plan integration** — every SOQL row in the Tables tab now has a "Plan" button. One click runs the query through Salesforce's Query Plan tool (`/services/data/vN/query/?explain=`) and renders the result in a side panel: leading-operation type, relative cost, cardinality, considered alternative plans, and any selectivity notes from Salesforce. A verdict banner calls out full-table-scans (`🔴`) vs selective queries (`🟢`). Also exposed via the `Apex Doctor: Run SOQL Query Plan…` command for ad-hoc queries.
- **🧪 Test coverage overlay** — when a `.cls` or `.trigger` file is open, Apex Doctor draws covered / uncovered lines as subtle green / red gutter icons + line-background tints, sourced from `ApexCodeCoverageAggregate` in your default org. A status-bar item shows the per-class coverage percentage. New commands: `Refresh Test Coverage` (queries the org and caches in workspaceState) and `Toggle Coverage Overlay`. Cached coverage stays available offline; click the status-bar item to toggle.
- New `SalesforceService` methods: `explainQuery()` (Tooling REST `?explain=` endpoint via `sf api request rest`) and `fetchCoverage()` (`ApexCodeCoverageAggregate` Tooling API).

## [0.6.0] — 2026-05-01

### Added

- **💬 Ask the Log — natural-language query** — a new input box at the top of the Overview tab. Ask things like _"SOQL queries that returned more than 500 rows"_ or _"methods that ran after the exception"_ in plain English; the LLM picks the right array and returns indices we hydrate locally (so it can't fabricate rows). Results render as a focused table.
- **🔧 Suggest fix — one-click refactor with diff preview** — every issue card now has a "Suggest fix" button. Apex Doctor tries a templated transform first (deterministic, instant), then falls back to the LLM for the long tail. Both paths open a real VS Code diff and require explicit "Apply fix" confirmation — never auto-applies.
  - **Templated fixes** ship for: SOQL-in-loop bulkification (Set + single query + Map lookup) and adding `LIMIT 200` to a runaway query. More patterns to follow.
  - **AI fix** sends the full file plus a relevant 40-line window around the issue, asks for the rewritten file in a code block, and uses the result as the proposed change.
- **`completeOnce` API in AiService** — single-shot non-streaming completion used by the NL query and AI-fix flows. Stitches over the same provider router (OpenRouter / Anthropic / OpenAI / Gemini), so all four work for both features.

### Tests

- Test count up from 22 → 28: bulkification template, missing-LIMIT template, NL query response parsing, and defensive index validation.

## [0.5.0] — 2026-05-01

### Added

- **CPU Profiler** — new Profiler tab with self-time attribution. Computes total − sum(children) at every node, traces the hot path from root to deepest leaf with the highest exclusive time, and surfaces a single bottleneck callout. Two ranked tables: hottest by self time and hottest by total time, each with call count and % of transaction.
- **Trigger order visualiser** — detects triggers from `CODE_UNIT_STARTED` patterns, groups by sObject + DML phase (Before/After + Insert/Update/Delete/Undelete), flags the slowest trigger in each phase and marks recursive ones.
- **Async operation tracer** — parses `ASYNC_OPERATION_TRIGGERED`, `FUTURE_METHOD_INVOCATION`, `QUEUEABLE_PENDING` / `ENQUEUE_JOB`. Detects whether the current log is itself an async body (Queueable, Batch, @future, Schedulable). Cross-log linking matches parent invocations against saved Recent Analyses with a confidence score, so you can finally see the full async chain.
- **Debug-level recommendations** — compares the header debug levels against events that actually appeared. Tells you to raise DB / APEX_PROFILING / SYSTEM when needed, or lower APEX_CODE FINEST when low signal density makes it just noise.
- **Recurring patterns + sidebar tree view** — mines saved Recent Analyses for issues that repeat 3+ times in the last 7 days, detects SOQL patterns recurring across logs, and computes trend lines for SOQL/DML/duration/errors. New "Apex Doctor: Recurring Issues" tree view in the Explorer sidebar plus a banner at the top of every analysis.

### Changed

- **Webview restructured into three tabs** — `Overview · Profiler · Tables`. The active tab persists across webview reloads via `setState`. New v0.5.0 sections (triggers, async, debug-levels) live inside Overview; the CPU profiler has its own tab.

### Tests

- Test count up from 12 → 22, covering profiler self-time + hot path, trigger grouping + recursion, async invocation parsing + cross-log linking, debug-level recommendations, and recurring pattern detection.

## [0.4.0] — 2026-04-30

### Added

- **🎯 Trace Flag Manager** — set up debug logs for any user from VS Code without leaving for Salesforce Setup. Lists active TraceFlag records, creates / extends / deletes flags inline. Smart conflict handling offers to extend an existing flag instead of erroring on a duplicate.
- **🤖 AI follow-up chat** — keep the conversation going after the initial root-cause explanation; the analysis context stays loaded across turns. Conversation history persists across webview reloads.
- **Multi-provider LLM support** — adds OpenAI and Google Gemini alongside the existing OpenRouter and Anthropic. Free tiers for OpenRouter and Gemini.
- **📊 Parsed governor limits** — every `LIMIT_USAGE_FOR_NS` block parsed into structured metrics, rendered as colored progress bars (green &lt;50%, amber 50–80%, red ≥80%).
- **🔍 Per-table search** — instant client-side filter inputs above SOQL, DML, methods, code units, and debug statements.
- **🛠️ Inline diagnostics** — issues become red squiggles directly in the open log file, with full Problems-pane integration. Toggle via `apexDoctor.enableInlineDiagnostics`.
- **🔗 Stack-trace parsing** — exception and fatal-error frames render as clickable class links.
- **🧪 Apex test result mode** — `TEST_PASS` / `TEST_FAIL` events surface as a dedicated 🧪 section above issues, with pass/fail pills and clickable test class links.
- **🗂️ Recent analyses tree view** — last 10 analyses persisted per workspace, surfaced in a new Explorer view with click-to-reopen, inline remove, and clear-all toolbar action.
- **⚙️ Custom heuristic settings** — `slowSoqlThresholdMs` (replaces the hardcoded 1000), `slowMethodThresholdMs` (opt-in), `flagSoqlOnObjects` (warn whenever a query touches a monitored sObject), `enableInlineDiagnostics`.

### Changed

- **Method timing in the Compare view** is now aggregated as **sum + call count** (was max). For batch jobs that hit the same method 100× this gives a meaningful regression delta.
- **Async file I/O** — replaces blocking `readFileSync` / `writeFileSync` so 50 MB logs don't freeze the extension host.
- `ApexDoctor` class properly PascalCased; static import for `insights` instead of runtime `require()`.
- Class-link / line-link clicks now actually wire up (latent bug fix).

## [0.3.1] — 2026-04-24

### Changed

- Refreshed all README screenshots to reflect the latest UI
- Added dedicated sections for Activity Timeline, tabular data view, and Live Log Streaming
- Added install instructions for Cursor / VSCodium / Gitpod via Open VSX

## [0.3.0] — 2026-04-23

### Added

- **Performance Insights** — deterministic, plain-English summary of where time went (SOQL %, slow queries, SOQL-in-loop, fatal errors)
- **Activity Timeline** — stacked area chart visualising SOQL / DML / methods / callouts over time
- **Live Log Streaming** — dedicated panel showing logs arriving from the org in real time via `sf apex tail log`
- **Compare Two Logs** — diff view with verdict banner, method regressions table, SOQL pattern changes, resolved / new issues, and Markdown export
- **Source code navigation** — click any method name in "Slowest Methods" to jump to its `.cls` file at the exact line; auto-retrieves the class from the org if not in workspace
- **Auto user info** — fetches and displays which Salesforce user executed each log
- **Markdown export** — copy the full analysis as a formatted Markdown report for Jira / Slack / PRs
- **OpenRouter support** — free LLM tier as an alternative to Anthropic Claude

### Changed

- Rebranded from "Apex Log Analyzer by Aman" to **Apex Doctor**
- Published to the VS Code Marketplace

## [0.2.1] — Pre-release

- Activity timeline area chart
- SOQL-in-loop detection
- Fetch log from Salesforce

## [0.2.0] — Pre-release

- AI root-cause analysis via Anthropic Claude
- Encrypted API key storage via VS Code SecretStorage

## [0.1.0] — Pre-release

- Initial parser and analyser
- Right-click "Analyse this Apex Log" command
