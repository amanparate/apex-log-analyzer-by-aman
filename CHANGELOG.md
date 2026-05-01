# Changelog

All notable changes to Apex Doctor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
