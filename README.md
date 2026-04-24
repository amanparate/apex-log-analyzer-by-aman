# Apex Doctor

> Diagnose Salesforce Apex debug logs in seconds. AI root-cause analysis, live log streaming, performance insights, and one-click navigation to Apex source — all inside VS Code.

![Apex Doctor — Performance Insights, Issues and Errors](https://raw.githubusercontent.com/amanparate/apex-doctor/main/docs/screenshot-1.png)

---

## ✨ What it does

Paste any Salesforce Apex debug log into VS Code, right-click, and get an instant, structured breakdown:

- 💡 **Performance Insights** — plain-English summary of where time went
- 🛑 **Issues & errors** — fatal errors, exceptions, SOQL-in-loop, governor-limit violations
- 📈 **Activity Timeline** — stacked area chart showing when SOQL / DML / methods / callouts ran
- 📊 **Code units** — every trigger, workflow, and execution entry point with timing
- 🐌 **Slowest methods** — top 50 methods ranked by duration, clickable to jump to source
- 🗃️ **SOQL queries** — every query, row count, and execution time
- ✏️ **DML operations** — inserts, updates, deletes with row counts
- 🐞 **Debug statements** — all `System.debug()` output
- 📈 **Governor limits** — cumulative usage snapshot
- 🔴 **Live streaming** — watch logs arrive from your org in real time
- 🔀 **Compare two logs** — side-by-side diff for before / after optimisations
- 🤖 **AI root-cause analysis** — free via OpenRouter, or Anthropic Claude for premium

---

## 💡 Performance Insights, Issues & Errors

At the top of every analysis, plain-English insights highlight exactly where time went and what's wrong — followed by a structured list of every detected issue with severity and line numbers.

Examples:

- "🗃️ 62% of runtime is SOQL — 14 queries took 1,150 ms combined"
- "🔁 SOQL-in-loop detected — same query executed 8 times"
- "🐌 One query took 30% of total runtime — 4,562 rows"
- "🛑 Execution halted by fatal error — NullPointerException at line 230"

All deterministic rules — no API calls needed. Free, instant, on every analysis.

---

## 📈 Activity Timeline & Code Units

A stacked-area chart visualises exactly when SOQL, DML, methods, and callouts ran across the log — so you can spot bottlenecks at a glance. Below it, every code unit (trigger, workflow, execution entry point) is listed with timing.

![Activity Timeline and Code Units](https://raw.githubusercontent.com/amanparate/apex-doctor/main/docs/screenshot-2.png)

---

## 🔗 Navigate directly to your Apex source

In the "Slowest Methods" table, method names like `AccountHandler.processAccounts` are clickable. Click once → opens `AccountHandler.cls` at the exact line number in the editor.

![Slowest Methods with clickable source links](https://raw.githubusercontent.com/amanparate/apex-doctor/main/docs/screenshot-3.png)

**Works with any SFDX project** — Apex Doctor reads `sfdx-project.json` and finds the class under your `packageDirectories`.

**Class not in your workspace?** No problem — you'll get a prompt offering to retrieve it from the org via `sf project retrieve`. Approve once, and the class is pulled down and opened automatically.

---

## 🗃️ Full data at a glance

Every SOQL query, DML operation, debug statement, and governor-limit snapshot — laid out in sortable tables so nothing gets missed.

![SOQL, DML, Debug statements and Governor Limits](https://raw.githubusercontent.com/amanparate/apex-doctor/main/docs/screenshot-4.png)

---

## 🔴 Live Log Streaming

Debug in real time. Click the **"⏺ Stream Apex Logs"** button in the status bar (or run "Start Log Streaming" from the Command Palette) and a dedicated panel opens showing incoming logs as they happen.

![Live Apex Log Stream](https://raw.githubusercontent.com/amanparate/apex-doctor/main/docs/screenshot-5.png)

- Each new log appears in a table with operation, status, duration, size, user, and timestamp
- Click any row → full analysis of that log in the main panel
- Status bar shows a red "⏺ Streaming" indicator while active
- Polls every 3 seconds — typical latency between log completion and appearance is < 6 seconds

---

## 🤖 AI-assisted root-cause analysis

One click and the AI explains exactly **what went wrong, where it broke, and how to fix it** — in plain English, with working Apex code suggestions.

The response is structured into four sections:

- **Root Cause** — what actually went wrong, in plain English
- **Where it broke** — the class, method, and line number
- **Likely Fix** — concrete recommendation with an Apex code snippet
- **Prevention** — practices to prevent this class of issue recurring

**Per-issue focus**: click "Explain this" next to any detected issue to get focused analysis of just that problem.

---

## 🔀 Compare Two Logs

Before and after an optimisation? Run **"Compare Two Apex Logs"** from the Command Palette, pick your baseline and your comparison log, and Apex Doctor renders a diff panel:

- Summary deltas (duration, SOQL, DML, errors) with % change
- Verdict banner — "Comparison is 34% faster" or "Comparison regressed — 2 new errors"
- Method regressions / improvements table
- SOQL pattern changes grouped by normalised query
- New vs resolved issues
- One-click export of the comparison as Markdown for Jira / Slack

---

## 🚀 Getting started

### Install from the Marketplace (coming soon)

Search for **"Apex Doctor"** in the VS Code Extensions panel, or:
