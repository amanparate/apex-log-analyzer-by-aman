import { Analysis, Issue, MethodEntry, SoqlEntry, DmlEntry, DebugEntry } from "./analyzer";
import { renderAreaChartHtml } from "./areaChart";
import { Insight } from "./insights";

const ROW_CAP = 100;

function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function fmt(n?: number): string {
  return (n ?? 0).toFixed(2);
}

function renderInsightsHtml(insights: Insight[]): string {
  if (!insights.length) {
    return "";
  }
  return `<div class="insights">${insights
    .map(
      (i) => `
      <div class="insight insight-${i.severity}">
        <div class="insight-icon">${i.icon}</div>
        <div class="insight-body">
          <div class="insight-title">${esc(i.title)}</div>
          <div class="insight-detail">${esc(i.detail)}</div>
          ${i.metric ? `<div class="insight-metric">${esc(i.metric)}</div>` : ""}
        </div>
      </div>`,
    )
    .join("")}</div>`;
}

interface SectionMeta {
  id: string; // unique slug, used in TOC and as HTML id
  title: string;
  icon: string;
  count: number;
}

const ISSUES_SECTION: Omit<SectionMeta, "count"> = { id: "issues", title: "Issues & Errors", icon: "🛑" };
const TIMELINE_SECTION: Omit<SectionMeta, "count"> = { id: "timeline", title: "Activity Timeline", icon: "📈" };
const CODEUNITS_SECTION: Omit<SectionMeta, "count"> = { id: "code-units", title: "Code Units", icon: "📊" };
const METHODS_SECTION: Omit<SectionMeta, "count"> = { id: "methods", title: "Slowest Methods", icon: "🐌" };
const SOQL_SECTION: Omit<SectionMeta, "count"> = { id: "soql", title: "SOQL Queries", icon: "🗃️" };
const DML_SECTION: Omit<SectionMeta, "count"> = { id: "dml", title: "DML Operations", icon: "✏️" };
const DEBUG_SECTION: Omit<SectionMeta, "count"> = { id: "debug", title: "Debug Statements", icon: "🐞" };
const LIMITS_SECTION: Omit<SectionMeta, "count"> = { id: "limits", title: "Governor Limits", icon: "📈" };

export function renderAnalysisHtml(a: Analysis): string {
  // ----------------------------------------------------------------
  // Build payloads: full data goes to client as JSON; server pre-renders
  // only the first ROW_CAP rows of each table for fast initial paint.
  // ----------------------------------------------------------------
  const payload = {
    issues: a.issues.map((i, idx) => ({
      idx,
      severity: i.severity,
      type: i.type,
      message: i.message,
      lineNumber: i.lineNumber,
      timestamp: i.timestamp,
      context: i.context,
    })),
    methods: a.methods.map((m) => ({ ...m })),
    soql: a.soql.map((q) => ({ ...q })),
    dml: a.dml.map((d) => ({ ...d })),
    debugs: a.debugs.map((d) => ({ ...d })),
    codeUnits: a.codeUnits.map((c) => ({ ...c })),
  };

  const flameHtml = renderAreaChartHtml(a.flameRoot);

  const userInfoHtml = a.userInfo
    ? `<div class="card user-card">
         <div class="l">Executed by</div>
         <div class="v">${esc(a.userInfo.Name)}</div>
         <div class="muted">${esc(a.userInfo.Username)} · ${esc(a.userInfo.Email)}${a.userInfo.ProfileName ? " · " + esc(a.userInfo.ProfileName) : ""}</div>
       </div>`
    : "";

  const limitsHtml = a.limits.length
    ? a.limits.map((l) => `<pre>${esc(l)}</pre>`).join("")
    : `<p class="muted">No limit usage block found.</p>`;

  const errorCount = a.issues.filter((i) => i.severity === "fatal" || i.severity === "error").length;
  const warningCount = a.issues.filter((i) => i.severity === "warning").length;

  const tocItems: SectionMeta[] = [
    { ...ISSUES_SECTION, count: a.issues.length },
    { ...TIMELINE_SECTION, count: 0 },
    { ...CODEUNITS_SECTION, count: a.codeUnits.length },
    { ...METHODS_SECTION, count: a.methods.length },
    { ...SOQL_SECTION, count: a.soql.length },
    { ...DML_SECTION, count: a.dml.length },
    { ...DEBUG_SECTION, count: a.debugs.length },
    { ...LIMITS_SECTION, count: a.limits.length },
  ];

  const tocHtml = `<nav id="toc">
    ${tocItems
      .map(
        (s) => `<a href="#sec-${s.id}" data-sec="${s.id}">
          <span>${s.icon} ${esc(s.title)}</span>
          ${s.count > 0 ? `<span class="toc-count">${s.count}</span>` : ""}
        </a>`,
      )
      .join("")}
  </nav>`;

  // Server-renders initial rows only. Client takes over from the JSON payload.
  const initialIssuesHtml = renderInitialIssues(a.issues);
  const initialMethodsHtml = renderInitialMethods(a.methods);
  const initialSoqlHtml = renderInitialSoql(a.soql);
  const initialDmlHtml = renderInitialDml(a.dml);
  const initialDebugsHtml = renderInitialDebugs(a.debugs);
  const initialCodeUnitsHtml = renderInitialCodeUnits(a.codeUnits);

  // ----------------------------------------------------------------
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  ${cssBlock()}
</style></head>
<body>
  <div class="layout">
    ${tocHtml}
    <main>
      <h1>Apex Doctor</h1>
      <p class="tagline">API ${esc(a.summary.apiVersion)} · ${a.summary.totalEvents} events · ${fmt(a.summary.totalDurationMs)} ms total</p>

      ${userInfoHtml}

      <div class="summary">
        <div class="card"><div class="l">Total Duration</div><div class="v">${fmt(a.summary.totalDurationMs)} ms</div></div>
        <div class="card"><div class="l">SOQL Queries</div><div class="v">${a.soql.length}</div></div>
        <div class="card"><div class="l">DML Operations</div><div class="v">${a.dml.length}</div></div>
        <div class="card"><div class="l">Errors</div><div class="v">${errorCount}</div></div>
        <div class="card"><div class="l">Warnings</div><div class="v">${warningCount}</div></div>
        <div class="card"><div class="l">Debug Logs</div><div class="v">${a.debugs.length}</div></div>
      </div>

      <div class="actions">
        <button onclick="explainAll()" id="btn-explain-all">🤖 Explain root cause with AI</button>
        <button onclick="exportMarkdown()">📋 Copy as Markdown</button>
      </div>

      ${a.insights.length ? `<h2>💡 Performance Insights</h2>${renderInsightsHtml(a.insights)}` : ""}

      <div class="ai-panel" id="ai-panel" style="display:none">
        <h3>🤖 AI Root-Cause Analysis <span class="spinner" id="ai-spinner" style="display:none"></span></h3>
        <div id="ai-output"></div>
      </div>

      ${section(ISSUES_SECTION, a.issues.length, `
        <div class="filter-bar">
          <input class="f-text" data-target="issues" placeholder="Filter by type or message…" type="text" />
          <button class="pill active" data-target="issues" data-filter="severity" data-value="all">All</button>
          <button class="pill" data-target="issues" data-filter="severity" data-value="fatal">Fatal</button>
          <button class="pill" data-target="issues" data-filter="severity" data-value="error">Error</button>
          <button class="pill" data-target="issues" data-filter="severity" data-value="warning">Warning</button>
          <button class="pill" data-target="issues" data-filter="severity" data-value="info">Info</button>
          <span class="counter" id="issues-counter"></span>
        </div>
        <div id="issues-body">${initialIssuesHtml}</div>
        ${a.issues.length > ROW_CAP ? showAllButton("issues", a.issues.length) : ""}
      `)}

      ${section(TIMELINE_SECTION, 0, flameHtml)}

      ${section(CODEUNITS_SECTION, a.codeUnits.length, `
        ${tableHeader("code-units", [
          { key: "name", label: "Code Unit", sortable: true },
          { key: "durationMs", label: "Duration", sortable: true, default: "desc" },
        ])}
        <tbody id="code-units-body">${initialCodeUnitsHtml}</tbody></table>
        ${a.codeUnits.length > ROW_CAP ? showAllButton("code-units", a.codeUnits.length) : ""}
      `)}

      ${section(METHODS_SECTION, a.methods.length, `
        <div class="filter-bar">
          <input class="f-text" data-target="methods" placeholder="Filter by method name…" type="text" />
          <input class="f-num" data-target="methods" data-field="durationMs" placeholder="Min ms" type="number" min="0" />
          <span class="counter" id="methods-counter"></span>
        </div>
        ${tableHeader("methods", [
          { key: "name", label: "Method", sortable: true },
          { key: "durationMs", label: "Duration", sortable: true, default: "desc" },
          { key: "lineNumber", label: "Line", sortable: true },
        ])}
        <tbody id="methods-body">${initialMethodsHtml}</tbody></table>
        ${a.methods.length > ROW_CAP ? showAllButton("methods", a.methods.length) : ""}
      `)}

      ${section(SOQL_SECTION, a.soql.length, `
        <div class="filter-bar">
          <input class="f-text" data-target="soql" placeholder="Filter by query text…" type="text" />
          <input class="f-num" data-target="soql" data-field="rows" placeholder="Min rows" type="number" min="0" />
          <input class="f-num" data-target="soql" data-field="durationMs" placeholder="Min ms" type="number" min="0" />
          <span class="counter" id="soql-counter"></span>
        </div>
        ${tableHeader("soql", [
          { key: "_idx", label: "#" },
          { key: "durationMs", label: "Duration", sortable: true, default: "desc" },
          { key: "rows", label: "Rows", sortable: true },
          { key: "lineNumber", label: "Line", sortable: true },
          { key: "query", label: "Query" },
        ])}
        <tbody id="soql-body">${initialSoqlHtml}</tbody></table>
        ${a.soql.length > ROW_CAP ? showAllButton("soql", a.soql.length) : ""}
      `)}

      ${section(DML_SECTION, a.dml.length, `
        <div class="filter-bar">
          <input class="f-text" data-target="dml" placeholder="Filter by operation…" type="text" />
          <input class="f-num" data-target="dml" data-field="rows" placeholder="Min rows" type="number" min="0" />
          <span class="counter" id="dml-counter"></span>
        </div>
        ${tableHeader("dml", [
          { key: "_idx", label: "#" },
          { key: "operation", label: "Op", sortable: true },
          { key: "rows", label: "Rows", sortable: true },
          { key: "durationMs", label: "Duration", sortable: true, default: "desc" },
          { key: "lineNumber", label: "Line", sortable: true },
        ])}
        <tbody id="dml-body">${initialDmlHtml}</tbody></table>
        ${a.dml.length > ROW_CAP ? showAllButton("dml", a.dml.length) : ""}
      `)}

      ${section(DEBUG_SECTION, a.debugs.length, `
        <div class="filter-bar">
          <input class="f-text" data-target="debug" placeholder="Search debug messages…" type="text" />
          <button class="pill active" data-target="debug" data-filter="level" data-value="all">All</button>
          <button class="pill" data-target="debug" data-filter="level" data-value="DEBUG">DEBUG</button>
          <button class="pill" data-target="debug" data-filter="level" data-value="INFO">INFO</button>
          <button class="pill" data-target="debug" data-filter="level" data-value="ERROR">ERROR</button>
          <span class="counter" id="debug-counter"></span>
        </div>
        <div id="debug-body">${initialDebugsHtml}</div>
        ${a.debugs.length > ROW_CAP ? showAllButton("debug", a.debugs.length) : ""}
      `)}

      ${section(LIMITS_SECTION, a.limits.length, limitsHtml)}
    </main>
  </div>

  <script id="apex-data" type="application/json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
  <script>
    ${clientRuntime()}
  </script>
</body></html>`;
}

// ---- Section/table helpers (server-side) ----

function section(meta: Omit<SectionMeta, "count">, count: number, body: string): string {
  return `<section class="apex-section" id="sec-${meta.id}" data-section="${meta.id}">
    <h2 class="section-h">
      <button class="collapse-toggle" data-target="${meta.id}" aria-expanded="true">▾</button>
      <span>${meta.icon} ${esc(meta.title)}</span>
      ${count > 0 ? `<span class="section-count">${count}</span>` : ""}
    </h2>
    <div class="section-body" id="body-${meta.id}">${body}</div>
  </section>`;
}

interface ColSpec {
  key: string;
  label: string;
  sortable?: boolean;
  default?: "asc" | "desc";
}

function tableHeader(target: string, cols: ColSpec[]): string {
  return `<table class="data-table" data-target="${target}"><thead><tr>${cols
    .map((c) =>
      c.sortable
        ? `<th class="sortable" data-key="${c.key}" ${c.default ? `data-default="${c.default}"` : ""}>${esc(c.label)} <span class="sort-indicator"></span></th>`
        : `<th>${esc(c.label)}</th>`,
    )
    .join("")}</tr></thead>`;
}

function showAllButton(target: string, total: number): string {
  return `<div class="show-all-bar">
    <span class="muted">Showing first ${ROW_CAP} of ${total}</span>
    <button class="show-all" data-target="${target}">Show all ${total}</button>
  </div>`;
}

// ---- Initial-row server rendering (first ROW_CAP only) ----

function renderInitialIssues(issues: Issue[]): string {
  if (!issues.length) {
    return `<p class="muted">No issues detected. 🎉</p>`;
  }
  return issues.slice(0, ROW_CAP).map((i, idx) => issueRowHtml(i, idx)).join("");
}

function issueRowHtml(i: Issue, idx: number): string {
  return `<div class="issue ${i.severity}" data-severity="${i.severity}" data-search="${esc((i.type + " " + i.message).toLowerCase())}">
    <div class="row">
      <span class="badge ${i.severity}">${i.severity.toUpperCase()}</span>
      <strong>${esc(i.type)}</strong>
      ${i.lineNumber ? `<a href="#" class="line-link" data-line="${i.lineNumber}">line ${i.lineNumber}</a>` : ""}
      <span class="muted">@ ${esc(i.timestamp)}</span>
      <button class="mini" onclick="explainIssue(${idx})">🤖 Explain this</button>
    </div>
    <pre>${esc(i.message)}</pre>
    ${i.context ? `<p class="context">💡 ${esc(i.context)}</p>` : ""}
  </div>`;
}

function renderInitialMethods(methods: MethodEntry[]): string {
  if (!methods.length) {
    return `<tr><td colspan="3" class="muted">No method timing data.</td></tr>`;
  }
  return methods.slice(0, ROW_CAP).map(methodRowHtml).join("");
}

function methodRowHtml(m: MethodEntry): string {
  const className = (/^([A-Za-z_][A-Za-z0-9_]*)\./.exec(m.name) || [])[1];
  const nameCell = className
    ? `<a href="#" class="class-link" data-class="${esc(className)}" data-line="${m.lineNumber ?? ""}"><code>${esc(m.name)}</code></a>`
    : `<code>${esc(m.name)}</code>`;
  return `<tr data-search="${esc(m.name.toLowerCase())}" data-duration="${m.durationMs}" data-line="${m.lineNumber ?? 0}">
    <td>${nameCell}</td>
    <td>${fmt(m.durationMs)} ms</td>
    <td>${m.lineNumber ? `<a href="#" class="line-link" data-line="${m.lineNumber}">${m.lineNumber}</a>` : "-"}</td>
  </tr>`;
}

function renderInitialSoql(soql: SoqlEntry[]): string {
  if (!soql.length) {
    return `<tr><td colspan="5" class="muted">No SOQL executed.</td></tr>`;
  }
  return soql.slice(0, ROW_CAP).map((q, i) => soqlRowHtml(q, i)).join("");
}

function soqlRowHtml(q: SoqlEntry, i: number): string {
  return `<tr data-search="${esc(q.query.toLowerCase())}" data-rows="${q.rows ?? 0}" data-duration="${q.durationMs ?? 0}" data-line="${q.lineNumber ?? 0}" data-idx="${i + 1}">
    <td>${i + 1}</td>
    <td>${fmt(q.durationMs)} ms</td>
    <td>${q.rows ?? "-"}</td>
    <td>${q.lineNumber ? `<a href="#" class="line-link" data-line="${q.lineNumber}">${q.lineNumber}</a>` : "-"}</td>
    <td><code>${esc(q.query)}</code></td>
  </tr>`;
}

function renderInitialDml(dml: DmlEntry[]): string {
  if (!dml.length) {
    return `<tr><td colspan="5" class="muted">No DML executed.</td></tr>`;
  }
  return dml.slice(0, ROW_CAP).map((d, i) => dmlRowHtml(d, i)).join("");
}

function dmlRowHtml(d: DmlEntry, i: number): string {
  return `<tr data-search="${esc(d.operation.toLowerCase())}" data-rows="${d.rows ?? 0}" data-duration="${d.durationMs ?? 0}" data-line="${d.lineNumber ?? 0}" data-operation="${esc(d.operation)}" data-idx="${i + 1}">
    <td>${i + 1}</td>
    <td>${esc(d.operation)}</td>
    <td>${d.rows ?? "-"}</td>
    <td>${fmt(d.durationMs)} ms</td>
    <td>${d.lineNumber ? `<a href="#" class="line-link" data-line="${d.lineNumber}">${d.lineNumber}</a>` : "-"}</td>
  </tr>`;
}

function renderInitialDebugs(debugs: DebugEntry[]): string {
  if (!debugs.length) {
    return `<p class="muted">No debug statements.</p>`;
  }
  return debugs.slice(0, ROW_CAP).map(debugRowHtml).join("");
}

function debugRowHtml(d: DebugEntry): string {
  return `<div class="debug" data-level="${esc(d.level)}" data-search="${esc(d.message.toLowerCase())}">
    <span class="muted">${esc(d.timestamp)} · line ${d.lineNumber ? `<a href="#" class="line-link" data-line="${d.lineNumber}">${d.lineNumber}</a>` : "-"} · [${esc(d.level)}]</span>
    <pre>${esc(d.message)}</pre>
  </div>`;
}

function renderInitialCodeUnits(units: { name: string; durationMs: number }[]): string {
  if (!units.length) {
    return `<tr><td colspan="2" class="muted">No code units captured.</td></tr>`;
  }
  return units.slice(0, ROW_CAP).map((c) =>
    `<tr data-search="${esc(c.name.toLowerCase())}" data-duration="${c.durationMs}">
      <td><code>${esc(c.name)}</code></td>
      <td>${fmt(c.durationMs)} ms</td>
    </tr>`,
  ).join("");
}

// ---- CSS ----

function cssBlock(): string {
  return `
  body { font-family: -apple-system, Segoe UI, sans-serif; padding: 0; margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .layout { display: grid; grid-template-columns: 200px 1fr; min-height: 100vh; }
  #toc { position: sticky; top: 0; align-self: start; max-height: 100vh; overflow-y: auto; padding: 16px 0; border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
  #toc a { display: flex; justify-content: space-between; align-items: center; padding: 6px 14px; color: var(--vscode-foreground); text-decoration: none; font-size: 12px; border-left: 2px solid transparent; }
  #toc a:hover { background: var(--vscode-list-hoverBackground); }
  #toc a.active { border-left-color: var(--vscode-textLink-foreground); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #toc .toc-count { font-size: 10px; opacity: 0.6; padding: 1px 6px; background: var(--vscode-badge-background, rgba(255,255,255,0.08)); border-radius: 8px; }
  main { padding: 16px 24px; min-width: 0; }
  @media (max-width: 800px) { .layout { grid-template-columns: 1fr; } #toc { position: static; max-height: none; border-right: none; border-bottom: 1px solid var(--vscode-panel-border); } #toc a { display: inline-flex; } }

  h1 { margin: 0 0 4px; }
  h2.section-h { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 28px; }
  .collapse-toggle { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 14px; padding: 0 4px; transition: transform 0.15s; }
  .collapse-toggle.collapsed { transform: rotate(-90deg); }
  .section-count { font-size: 11px; opacity: 0.6; padding: 1px 8px; background: var(--vscode-editorWidget-background); border-radius: 10px; margin-left: auto; }
  .section-body.collapsed { display: none; }

  .insights { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 8px; margin-top: 8px; }
  .insight { display: flex; gap: 12px; background: var(--vscode-editorWidget-background); padding: 12px 14px; border-radius: 6px; border-left: 4px solid; }
  .insight-good { border-color: #22c55e; }
  .insight-info { border-color: #3b82f6; }
  .insight-warning { border-color: #f59e0b; }
  .insight-critical { border-color: #ef4444; }
  .insight-icon { font-size: 20px; line-height: 1; padding-top: 2px; }
  .insight-title { font-weight: 600; margin-bottom: 2px; }
  .insight-detail { font-size: 12px; opacity: 0.85; line-height: 1.4; }
  .insight-metric { margin-top: 6px; font-size: 11px; opacity: 0.7; font-family: var(--vscode-editor-font-family); }

  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
  th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; z-index: 1; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { background: var(--vscode-list-hoverBackground); }
  .sort-indicator { font-size: 10px; opacity: 0.5; margin-left: 4px; }
  th.sort-asc .sort-indicator::after { content: "▲"; opacity: 1; }
  th.sort-desc .sort-indicator::after { content: "▼"; opacity: 1; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; margin: 4px 0; }

  .filter-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
  .filter-bar input { padding: 4px 8px; font-size: 12px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .filter-bar input.f-text { flex: 1; min-width: 200px; }
  .filter-bar input.f-num { width: 90px; }
  .pill { padding: 3px 10px; font-size: 11px; border-radius: 12px; background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); opacity: 0.7; border: none; cursor: pointer; }
  .pill.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
  .pill:hover { opacity: 1; }
  .counter { font-size: 11px; opacity: 0.65; margin-left: auto; }

  .show-all-bar { display: flex; justify-content: space-between; align-items: center; padding: 8px; margin-top: 4px; background: var(--vscode-editorWidget-background); border-radius: 4px; }
  .show-all { padding: 4px 10px; font-size: 11px; }

  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-top: 16px; }
  .card { background: var(--vscode-editorWidget-background); padding: 10px 12px; border-radius: 6px; }
  .card .v { font-size: 20px; font-weight: 600; }
  .card .l { font-size: 10px; text-transform: uppercase; opacity: 0.7; letter-spacing: 0.5px; }
  .user-card { border-left: 3px solid #3498db; }
  .issue { border-left: 4px solid; padding: 8px 12px; margin: 8px 0; background: var(--vscode-editorWidget-background); border-radius: 4px; }
  .issue.fatal { border-color: #d33; } .issue.error { border-color: #e67e22; }
  .issue.warning { border-color: #e6c74d; } .issue.info { border-color: #3498db; }
  .issue.hidden, tr.hidden, .debug.hidden { display: none; }
  .badge { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; margin-right: 8px; }
  .badge.fatal { background: #d33; color: #fff; } .badge.error { background: #e67e22; color: #fff; }
  .badge.warning { background: #e6c74d; color: #000; } .badge.info { background: #3498db; color: #fff; }
  .muted { opacity: 0.7; font-size: 12px; margin-left: 8px; }
  .context { margin: 6px 0 0; font-size: 12px; opacity: 0.9; }
  .debug { margin: 6px 0; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.mini { padding: 2px 8px; font-size: 11px; margin-left: 8px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
  .tagline { opacity: 0.6; font-size: 12px; margin: 0 0 8px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
  .ai-panel { background: linear-gradient(135deg, rgba(155, 89, 182, 0.08), rgba(52, 152, 219, 0.08)); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px; margin-top: 16px; }
  .ai-panel h3 { margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  #ai-output { white-space: pre-wrap; font-size: 13px; line-height: 1.6; min-height: 20px; }
  #ai-output strong { color: var(--vscode-textLink-foreground); display: block; margin-top: 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
  #ai-output code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-left: 8px; vertical-align: middle; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .line-link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .line-link:hover { text-decoration: underline; }
  .class-link { color: inherit; text-decoration: none; cursor: pointer; border-bottom: 1px dashed var(--vscode-textLink-foreground); }
  .class-link:hover { background: var(--vscode-editor-hoverHighlightBackground); }
  .flame-tooltip { position: absolute; background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); padding: 8px 10px; border-radius: 4px; font-size: 12px; pointer-events: none; max-width: 400px; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  `;
}

// ---- Client runtime ----

function clientRuntime(): string {
  return `
  const vscode = acquireVsCodeApi();
  const data = JSON.parse(document.getElementById('apex-data').textContent);
  const persisted = vscode.getState() || {};

  // Per-section state
  const state = {
    issues:     persisted.issues     || { search: '', severity: 'all', expanded: false },
    methods:    persisted.methods    || { search: '', minDuration: 0, sortKey: 'durationMs', sortDir: 'desc', expanded: false },
    soql:       persisted.soql       || { search: '', minRows: 0, minDuration: 0, sortKey: 'durationMs', sortDir: 'desc', expanded: false },
    dml:        persisted.dml        || { search: '', minRows: 0, sortKey: 'durationMs', sortDir: 'desc', expanded: false },
    debug:      persisted.debug      || { search: '', level: 'all', expanded: false },
    'code-units': persisted['code-units'] || { sortKey: 'durationMs', sortDir: 'desc', expanded: false },
  };
  const collapsed = persisted.collapsed || {};

  const persist = () => vscode.setState({ ...state, collapsed });

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (n) => (Number(n) || 0).toFixed(2);

  // ---- Row rendering (mirrors server-side) ----
  function issueHtml(i) {
    return '<div class="issue ' + i.severity + '" data-severity="' + i.severity + '" data-search="' + esc((i.type+' '+i.message).toLowerCase()) + '">' +
      '<div class="row">' +
        '<span class="badge ' + i.severity + '">' + i.severity.toUpperCase() + '</span>' +
        '<strong>' + esc(i.type) + '</strong>' +
        (i.lineNumber ? '<a href="#" class="line-link" data-line="' + i.lineNumber + '">line ' + i.lineNumber + '</a>' : '') +
        '<span class="muted">@ ' + esc(i.timestamp) + '</span>' +
        '<button class="mini" onclick="explainIssue(' + i.idx + ')">🤖 Explain this</button>' +
      '</div>' +
      '<pre>' + esc(i.message) + '</pre>' +
      (i.context ? '<p class="context">💡 ' + esc(i.context) + '</p>' : '') +
    '</div>';
  }
  function methodHtml(m) {
    const cm = /^([A-Za-z_][A-Za-z0-9_]*)\\./.exec(m.name);
    const cls = cm ? cm[1] : null;
    const nameCell = cls
      ? '<a href="#" class="class-link" data-class="' + esc(cls) + '" data-line="' + (m.lineNumber || '') + '"><code>' + esc(m.name) + '</code></a>'
      : '<code>' + esc(m.name) + '</code>';
    return '<tr data-search="' + esc((m.name||'').toLowerCase()) + '" data-duration="' + (m.durationMs||0) + '" data-line="' + (m.lineNumber||0) + '">' +
      '<td>' + nameCell + '</td>' +
      '<td>' + fmt(m.durationMs) + ' ms</td>' +
      '<td>' + (m.lineNumber ? '<a href="#" class="line-link" data-line="' + m.lineNumber + '">' + m.lineNumber + '</a>' : '-') + '</td>' +
    '</tr>';
  }
  function soqlHtml(q, i) {
    return '<tr data-search="' + esc((q.query||'').toLowerCase()) + '" data-rows="' + (q.rows||0) + '" data-duration="' + (q.durationMs||0) + '" data-line="' + (q.lineNumber||0) + '" data-idx="' + (i+1) + '">' +
      '<td>' + (i+1) + '</td>' +
      '<td>' + fmt(q.durationMs) + ' ms</td>' +
      '<td>' + (q.rows ?? '-') + '</td>' +
      '<td>' + (q.lineNumber ? '<a href="#" class="line-link" data-line="' + q.lineNumber + '">' + q.lineNumber + '</a>' : '-') + '</td>' +
      '<td><code>' + esc(q.query) + '</code></td>' +
    '</tr>';
  }
  function dmlHtml(d, i) {
    return '<tr data-search="' + esc((d.operation||'').toLowerCase()) + '" data-rows="' + (d.rows||0) + '" data-duration="' + (d.durationMs||0) + '" data-line="' + (d.lineNumber||0) + '" data-operation="' + esc(d.operation) + '" data-idx="' + (i+1) + '">' +
      '<td>' + (i+1) + '</td>' +
      '<td>' + esc(d.operation) + '</td>' +
      '<td>' + (d.rows ?? '-') + '</td>' +
      '<td>' + fmt(d.durationMs) + ' ms</td>' +
      '<td>' + (d.lineNumber ? '<a href="#" class="line-link" data-line="' + d.lineNumber + '">' + d.lineNumber + '</a>' : '-') + '</td>' +
    '</tr>';
  }
  function debugHtml(d) {
    return '<div class="debug" data-level="' + esc(d.level) + '" data-search="' + esc((d.message||'').toLowerCase()) + '">' +
      '<span class="muted">' + esc(d.timestamp) + ' · line ' + (d.lineNumber ? '<a href="#" class="line-link" data-line="' + d.lineNumber + '">' + d.lineNumber + '</a>' : '-') + ' · [' + esc(d.level) + ']</span>' +
      '<pre>' + esc(d.message) + '</pre>' +
    '</div>';
  }
  function codeUnitHtml(c) {
    return '<tr data-search="' + esc((c.name||'').toLowerCase()) + '" data-duration="' + (c.durationMs||0) + '">' +
      '<td><code>' + esc(c.name) + '</code></td>' +
      '<td>' + fmt(c.durationMs) + ' ms</td>' +
    '</tr>';
  }

  // ---- Filter / sort / render ----
  function sortArr(arr, key, dir) {
    if (!key) return arr;
    const sorted = [...arr].sort((a, b) => {
      const va = a[key], vb = b[key];
      const na = (va === undefined || va === null) ? -Infinity : (typeof va === 'number' ? va : String(va));
      const nb = (vb === undefined || vb === null) ? -Infinity : (typeof vb === 'number' ? vb : String(vb));
      if (na < nb) return dir === 'asc' ? -1 : 1;
      if (na > nb) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  function renderSection(target) {
    const s = state[target] || {};
    const cap = s.expanded ? Infinity : ${ROW_CAP};

    if (target === 'issues') {
      let items = data.issues;
      if (s.severity !== 'all') items = items.filter(i => i.severity === s.severity);
      if (s.search) items = items.filter(i => (i.type+' '+i.message).toLowerCase().includes(s.search.toLowerCase()));
      const total = data.issues.length, filtered = items.length;
      const visible = items.slice(0, cap);
      const body = document.getElementById('issues-body');
      body.innerHTML = visible.length ? visible.map(issueHtml).join('') : '<p class="muted">No matching issues.</p>';
      updateCounter('issues', filtered, total);
      updateShowAll(target, filtered);
      return;
    }
    if (target === 'methods') {
      let items = data.methods;
      if (s.search) items = items.filter(m => (m.name||'').toLowerCase().includes(s.search.toLowerCase()));
      if (s.minDuration > 0) items = items.filter(m => (m.durationMs||0) >= s.minDuration);
      items = sortArr(items, s.sortKey, s.sortDir);
      const total = data.methods.length, filtered = items.length;
      const visible = items.slice(0, cap);
      document.getElementById('methods-body').innerHTML = visible.length ? visible.map(methodHtml).join('') : '<tr><td colspan="3" class="muted">No matches.</td></tr>';
      updateCounter('methods', filtered, total);
      updateShowAll(target, filtered);
      updateSortIndicator(target, s.sortKey, s.sortDir);
      return;
    }
    if (target === 'soql') {
      let items = data.soql.map((q, i) => ({ ...q, _idx: i + 1 }));
      if (s.search) items = items.filter(q => (q.query||'').toLowerCase().includes(s.search.toLowerCase()));
      if (s.minRows > 0) items = items.filter(q => (q.rows||0) >= s.minRows);
      if (s.minDuration > 0) items = items.filter(q => (q.durationMs||0) >= s.minDuration);
      items = sortArr(items, s.sortKey, s.sortDir);
      const total = data.soql.length, filtered = items.length;
      const visible = items.slice(0, cap);
      document.getElementById('soql-body').innerHTML = visible.length ? visible.map((q) => soqlHtml(q, q._idx - 1)).join('') : '<tr><td colspan="5" class="muted">No matches.</td></tr>';
      updateCounter('soql', filtered, total);
      updateShowAll(target, filtered);
      updateSortIndicator(target, s.sortKey, s.sortDir);
      return;
    }
    if (target === 'dml') {
      let items = data.dml.map((d, i) => ({ ...d, _idx: i + 1 }));
      if (s.search) items = items.filter(d => (d.operation||'').toLowerCase().includes(s.search.toLowerCase()));
      if (s.minRows > 0) items = items.filter(d => (d.rows||0) >= s.minRows);
      items = sortArr(items, s.sortKey, s.sortDir);
      const total = data.dml.length, filtered = items.length;
      const visible = items.slice(0, cap);
      document.getElementById('dml-body').innerHTML = visible.length ? visible.map((d) => dmlHtml(d, d._idx - 1)).join('') : '<tr><td colspan="5" class="muted">No matches.</td></tr>';
      updateCounter('dml', filtered, total);
      updateShowAll(target, filtered);
      updateSortIndicator(target, s.sortKey, s.sortDir);
      return;
    }
    if (target === 'debug') {
      let items = data.debugs;
      if (s.level !== 'all') items = items.filter(d => d.level === s.level);
      if (s.search) items = items.filter(d => (d.message||'').toLowerCase().includes(s.search.toLowerCase()));
      const total = data.debugs.length, filtered = items.length;
      const visible = items.slice(0, cap);
      document.getElementById('debug-body').innerHTML = visible.length ? visible.map(debugHtml).join('') : '<p class="muted">No matching debug statements.</p>';
      updateCounter('debug', filtered, total);
      updateShowAll(target, filtered);
      return;
    }
    if (target === 'code-units') {
      let items = sortArr(data.codeUnits, s.sortKey, s.sortDir);
      const total = data.codeUnits.length;
      const visible = items.slice(0, cap);
      document.getElementById('code-units-body').innerHTML = visible.length ? visible.map(codeUnitHtml).join('') : '<tr><td colspan="2" class="muted">No code units captured.</td></tr>';
      updateShowAll(target, total);
      updateSortIndicator(target, s.sortKey, s.sortDir);
      return;
    }
  }

  function updateCounter(target, filtered, total) {
    const el = document.getElementById(target + '-counter');
    if (!el) return;
    el.textContent = filtered === total ? total + (total === 1 ? ' item' : ' items') : 'Showing ' + filtered + ' of ' + total;
  }

  function updateShowAll(target, filtered) {
    const bar = document.querySelector('.show-all-bar [data-target="' + target + '"]');
    if (!bar) return;
    const wrap = bar.closest('.show-all-bar');
    const s = state[target];
    if (filtered <= ${ROW_CAP} || s.expanded) {
      wrap.style.display = 'none';
    } else {
      wrap.style.display = 'flex';
      wrap.querySelector('.muted').textContent = 'Showing first ${ROW_CAP} of ' + filtered;
      bar.textContent = 'Show all ' + filtered;
    }
  }

  function updateSortIndicator(target, key, dir) {
    document.querySelectorAll('table[data-target="' + target + '"] th.sortable').forEach(th => {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.dataset.key === key) th.classList.add('sort-' + dir);
    });
  }

  // ---- Wire up controls ----
  document.querySelectorAll('input.f-text').forEach(inp => {
    const target = inp.dataset.target;
    inp.value = state[target].search || '';
    inp.addEventListener('input', () => { state[target].search = inp.value; persist(); renderSection(target); });
  });
  document.querySelectorAll('input.f-num').forEach(inp => {
    const target = inp.dataset.target, field = inp.dataset.field;
    const stateField = field === 'rows' ? 'minRows' : 'minDuration';
    inp.value = state[target][stateField] || '';
    inp.addEventListener('input', () => { state[target][stateField] = Number(inp.value) || 0; persist(); renderSection(target); });
  });
  document.querySelectorAll('.pill').forEach(p => {
    const target = p.dataset.target, filter = p.dataset.filter, value = p.dataset.value;
    if (!filter) return;
    if (state[target][filter] === value) p.classList.add('active'); else p.classList.remove('active');
    p.addEventListener('click', () => {
      document.querySelectorAll('.pill[data-target="' + target + '"][data-filter="' + filter + '"]').forEach(x => x.classList.remove('active'));
      p.classList.add('active');
      state[target][filter] = value; persist(); renderSection(target);
    });
  });
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const target = th.closest('table').dataset.target;
      const key = th.dataset.key;
      const cur = state[target];
      if (cur.sortKey === key) cur.sortDir = cur.sortDir === 'asc' ? 'desc' : 'asc';
      else { cur.sortKey = key; cur.sortDir = th.dataset.default || 'asc'; }
      persist(); renderSection(target);
    });
  });
  document.querySelectorAll('.show-all').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      state[target].expanded = true;
      persist(); renderSection(target);
    });
  });
  document.querySelectorAll('.collapse-toggle').forEach(btn => {
    const target = btn.dataset.target;
    if (collapsed[target]) {
      btn.classList.add('collapsed');
      document.getElementById('body-' + target).classList.add('collapsed');
    }
    btn.addEventListener('click', () => {
      const isCollapsed = btn.classList.toggle('collapsed');
      document.getElementById('body-' + target).classList.toggle('collapsed', isCollapsed);
      collapsed[target] = isCollapsed; persist();
    });
  });

  // ---- TOC active-section highlighting via IntersectionObserver ----
  const tocLinks = document.querySelectorAll('#toc a');
  const sections = Array.from(document.querySelectorAll('.apex-section'));
  if (sections.length && 'IntersectionObserver' in window) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const id = e.target.dataset.section;
          tocLinks.forEach(a => a.classList.toggle('active', a.dataset.sec === id));
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    sections.forEach(s => obs.observe(s));
  }

  // ---- Click delegation: line jumps, class jumps ----
  document.body.addEventListener('click', (e) => {
    const lineEl = e.target.closest('.line-link');
    if (lineEl) {
      e.preventDefault();
      const line = parseInt(lineEl.dataset.line, 10);
      if (line) vscode.postMessage({ command: 'jumpToLine', line });
      return;
    }
    const classEl = e.target.closest('.class-link');
    if (classEl) {
      e.preventDefault();
      const className = classEl.dataset.class;
      const line = parseInt(classEl.dataset.line || '0', 10) || undefined;
      if (className) vscode.postMessage({ command: 'openClass', className, line });
    }
  });

  // ---- Initial render: apply persisted filters/sorts to all sections ----
  ['issues','methods','soql','dml','debug','code-units'].forEach(renderSection);

  // ---- AI panel ----
  const panel = document.getElementById('ai-panel');
  const output = document.getElementById('ai-output');
  const spinner = document.getElementById('ai-spinner');
  const btnAll = document.getElementById('btn-explain-all');
  let lastAiText = '';

  window.exportMarkdown = () => vscode.postMessage({ command: 'exportMarkdown', aiText: lastAiText });
  window.explainAll = () => {
    panel.style.display = 'block';
    output.textContent = ''; lastAiText = '';
    spinner.style.display = 'inline-block'; btnAll.disabled = true;
    vscode.postMessage({ command: 'explainAll' });
  };
  window.explainIssue = (idx) => {
    panel.style.display = 'block';
    output.textContent = ''; lastAiText = '';
    spinner.style.display = 'inline-block'; btnAll.disabled = true;
    vscode.postMessage({ command: 'explainIssue', index: idx });
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function appendMarkdown(text) {
    lastAiText += text;
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    output.innerHTML += html;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'aiChunk') appendMarkdown(msg.text);
    else if (msg.command === 'aiDone') { spinner.style.display = 'none'; btnAll.disabled = false; }
    else if (msg.command === 'aiError') {
      spinner.style.display = 'none'; btnAll.disabled = false;
      output.innerHTML += '<p style="color:#d33">⚠️ ' + msg.error + '</p>';
    }
  });
  `;
}