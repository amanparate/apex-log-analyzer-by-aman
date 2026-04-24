## [0.3.1] — 2026-04-24

### Changed

- Refreshed all README screenshots to reflect the latest UI
- Added dedicated sections for Activity Timeline, tabular data view, and Live Log Streaming
- Added install instructions for Cursor / VSCodium / Gitpod via Open VSX

# Changelog

All notable changes to Apex Doctor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
