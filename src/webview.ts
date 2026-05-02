import { Analysis, LimitUsage } from "./analyzer";
import { renderAreaChartHtml } from "./areaChart";
import { Insight } from "./insights";
import { AsyncLink } from "./asyncTracer";
import { RecurringPatterns } from "./recurringPatterns";
import {
  renderCpuProfiler,
  renderTriggerOrder,
  renderAsyncTracer,
  renderDebugLevelRecs,
  renderRecurringBanner,
  tabSwitchingCss,
  tabSwitchingScript,
} from "./webviewSections";

export interface AnalysisRenderOptions {
  recurring?: RecurringPatterns;
  asyncLinks?: AsyncLink[];
}

function escapeHtml(s: string): string {
  return (s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function renderInsightsHtml(insights: Insight[]): string {
  if (!insights.length) {
    return "";
  }
  return `<div class="insights">
    ${insights
      .map(
        (i) => `
      <div class="insight insight-${i.severity}">
        <div class="insight-icon">${i.icon}</div>
        <div class="insight-body">
          <div class="insight-title">${escapeHtml(i.title)}</div>
          <div class="insight-detail">${escapeHtml(i.detail)}</div>
          ${i.metric ? `<div class="insight-metric">${escapeHtml(i.metric)}</div>` : ""}
        </div>
      </div>
    `,
      )
      .join("")}
  </div>`;
}

/**
 * Compute a 1-line "what's the headline" verdict from the analysis,
 * tinted by severity. Lives at the very top of the panel.
 */
function renderVerdictBanner(a: Analysis): string {
  const errorCount = a.issues.filter((i) => i.severity === "fatal" || i.severity === "error").length;
  const warningCount = a.issues.filter((i) => i.severity === "warning").length;
  const fatal = a.issues.find((i) => i.severity === "fatal");
  const totalMs = a.summary.totalDurationMs;
  const fmt0 = (n: number) => Math.round(n).toLocaleString();

  let severity: "good" | "warning" | "critical" = "good";
  let icon = "✅";
  let title: string;
  let detail = `${fmt0(totalMs)} ms · ${a.soql.length} SOQL · ${a.dml.length} DML`;

  if (fatal) {
    severity = "critical";
    icon = "🛑";
    title = `Execution halted — ${escapeHtml(fatal.type)}`;
    if (fatal.lineNumber) {
      detail = `at line ${fatal.lineNumber} · ${detail}`;
    }
  } else if (errorCount > 0) {
    severity = "critical";
    icon = "⚠️";
    title = `${errorCount} error${errorCount === 1 ? "" : "s"} detected`;
    detail += ` · ${warningCount} warning${warningCount === 1 ? "" : "s"}`;
  } else if (warningCount > 0) {
    severity = "warning";
    icon = "⚠️";
    title = `${warningCount} warning${warningCount === 1 ? "" : "s"} detected`;
  } else {
    title = "Healthy execution";
  }

  return `<div class="verdict-banner verdict-${severity}">
    <div class="verdict-icon">${icon}</div>
    <div class="verdict-body">
      <div class="verdict-title">${title}</div>
      <div class="verdict-detail">${detail}</div>
    </div>
  </div>`;
}

/** Compact horizontal strip — replaces the 6-card grid. */
function renderMetricStrip(a: Analysis): string {
  const errorCount = a.issues.filter((i) => i.severity === "fatal" || i.severity === "error").length;
  const warningCount = a.issues.filter((i) => i.severity === "warning").length;
  const fmt0 = (n: number) => Math.round(n).toLocaleString();
  const cell = (label: string, value: string | number, cls = "") =>
    `<span class="metric ${cls}"><span class="metric-value">${value}</span><span class="metric-label">${label}</span></span>`;
  return `<div class="metric-strip">
    ${cell("ms", fmt0(a.summary.totalDurationMs))}
    ${cell("SOQL", a.soql.length)}
    ${cell("DML", a.dml.length)}
    ${cell("errors", errorCount, errorCount > 0 ? "metric-error" : "")}
    ${cell("warnings", warningCount, warningCount > 0 ? "metric-warning" : "")}
    ${cell("debugs", a.debugs.length)}
  </div>`;
}

function renderLimitsHtml(limits: LimitUsage[]): string {
  if (!limits.length) {
    return `<p class="muted">No limit usage block found.</p>`;
  }
  const blocks = limits.map((lu) => {
    const rows = lu.metrics
      .map((m) => {
        const pct = Math.min(100, Math.max(0, m.pct));
        const cls =
          pct >= 80 ? "danger" : pct >= 50 ? "warn" : pct > 0 ? "ok" : "zero";
        return `<tr class="limit-row limit-${cls}">
          <td class="limit-name">${escapeHtml(m.name)}</td>
          <td class="limit-bar-cell">
            <div class="limit-bar"><div class="limit-bar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
          </td>
          <td class="limit-num">${m.used.toLocaleString()} / ${m.limit.toLocaleString()}</td>
          <td class="limit-pct">${pct.toFixed(0)}%</td>
        </tr>`;
      })
      .join("");
    return `<div class="limit-block">
      <div class="limit-ns">Namespace: <code>${escapeHtml(lu.namespace)}</code></div>
      <table class="limits-table"><tbody>${rows}</tbody></table>
    </div>`;
  });
  return blocks.join("");
}

export function renderAnalysisHtml(a: Analysis, options: AnalysisRenderOptions = {}): string {
  const fmt = (n?: number) => (n ?? 0).toFixed(2);
  const esc = escapeHtml;

  const renderStackFrames = (frames?: import("./analyzer").StackFrame[]) => {
    if (!frames || !frames.length) { return ""; }
    const rows = frames
      .map((f) => {
        const fullName = f.methodName ? `${f.className}.${f.methodName}` : f.className;
        const link = `<a href="#" class="class-link" data-class="${esc(f.className)}" data-line="${f.line ?? ""}"><code>${esc(fullName)}</code></a>`;
        const lineText = f.line ? `line ${f.line}` : "";
        const colText = f.column ? `, col ${f.column}` : "";
        return `<li class="stack-frame">${link} <span class="muted">${esc(lineText)}${esc(colText)}</span></li>`;
      })
      .join("");
    return `<div class="stack-trace"><div class="stack-label">Stack trace</div><ol>${rows}</ol></div>`;
  };

  const issuesHtml = a.issues.length
    ? a.issues
        .map(
          (i, idx) => `
      <div class="issue ${i.severity}">
        <div class="row">
          <span class="badge ${i.severity}">${i.severity.toUpperCase()}</span>
          <strong>${esc(i.type)}</strong>
          ${i.lineNumber ? `<a href="#" class="line-link" data-line="${i.lineNumber}">line ${i.lineNumber}</a>` : ""}
          <span class="muted">@ ${esc(i.timestamp)}</span>
          <button class="mini" onclick="explainIssue(${idx})">🤖 Explain this</button>
          <button class="mini" onclick="suggestFix(${idx})">🔧 Suggest fix</button>
        </div>
        <pre>${esc(i.message)}</pre>
        ${renderStackFrames(i.stackFrames)}
        ${i.context ? `<p class="context">💡 ${esc(i.context)}</p>` : ""}
      </div>`,
        )
        .join("")
    : `<p class="muted">No issues detected. 🎉</p>`;

  const userInfoHtml = a.userInfo
    ? `<div class="card user-card">
         <div class="l">Executed by</div>
         <div class="v">${esc(a.userInfo.Name)}</div>
         <div class="muted">${esc(a.userInfo.Username)} · ${esc(a.userInfo.Email)}${a.userInfo.ProfileName ? " · " + esc(a.userInfo.ProfileName) : ""}</div>
       </div>`
    : "";

  const lineLink = (line?: number) =>
    line
      ? `<a href="#" class="line-link" data-line="${line}">${line}</a>`
      : "-";

  const tableSearch = (id: string, placeholder: string) =>
    `<div class="table-search"><input type="search" class="filter-input" data-target="${id}" placeholder="${placeholder}" /></div>`;

  const soqlHtml = a.soql.length
    ? `${tableSearch("soql-table", "Filter SOQL by query, line, or row count…")}
       <table id="soql-table" class="filterable"><thead><tr><th>#</th><th>Duration</th><th>Rows</th><th>Line</th><th>Query</th><th></th></tr></thead><tbody>
        ${a.soql.map((q, i) => `<tr><td>${i + 1}</td><td>${fmt(q.durationMs)} ms</td><td>${q.rows ?? "-"}</td><td>${lineLink(q.lineNumber)}</td><td><code>${esc(q.query)}</code></td><td><button class="mini" onclick="queryPlan(${i})">🔎 Plan</button></td></tr>`).join("")}
      </tbody></table>`
    : `<p class="muted">No SOQL executed.</p>`;

  const dmlHtml = a.dml.length
    ? `${tableSearch("dml-table", "Filter DML by operation or line…")}
       <table id="dml-table" class="filterable"><thead><tr><th>#</th><th>Op</th><th>Rows</th><th>Duration</th><th>Line</th></tr></thead><tbody>
        ${a.dml.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.operation)}</td><td>${d.rows ?? "-"}</td><td>${fmt(d.durationMs)} ms</td><td>${lineLink(d.lineNumber)}</td></tr>`).join("")}
      </tbody></table>`
    : `<p class="muted">No DML executed.</p>`;

  const classLink = (name: string, line?: number) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(name);
    if (!match) {
      return `<code>${esc(name)}</code>`;
    }
    const className = match[1];
    return `<a href="#" class="class-link" data-class="${esc(className)}" data-line="${line ?? ""}"><code>${esc(name)}</code></a>`;
  };

  const methodsHtml = a.methods.length
    ? `${tableSearch("methods-table", "Filter methods by name or class…")}
       <table id="methods-table" class="filterable"><thead><tr><th>Method</th><th>Duration</th><th>Line</th></tr></thead><tbody>
        ${a.methods.map((m) => `<tr><td>${classLink(m.name, m.lineNumber)}</td><td>${fmt(m.durationMs)} ms</td><td>${lineLink(m.lineNumber)}</td></tr>`).join("")}
      </tbody></table>`
    : `<p class="muted">No method timing data.</p>`;

  const debugsHtml = a.debugs.length
    ? `${tableSearch("debug-list", "Filter debug statements by message or level…")}
       <div id="debug-list" class="filterable-list">
        ${a.debugs
          .map(
            (d) =>
              `<div class="debug filter-item"><span class="muted">${esc(d.timestamp)} · line ${lineLink(d.lineNumber)} · [${esc(d.level)}]</span><pre>${esc(d.message)}</pre></div>`,
          )
          .join("")}
       </div>`
    : `<p class="muted">No debug statements.</p>`;

  const codeUnitsHtml = a.codeUnits.length
    ? `${tableSearch("code-units-table", "Filter code units…")}
       <table id="code-units-table" class="filterable"><thead><tr><th>Code Unit</th><th>Duration</th></tr></thead><tbody>
        ${a.codeUnits.map((c) => `<tr><td><code>${esc(c.name)}</code></td><td>${fmt(c.durationMs)} ms</td></tr>`).join("")}
      </tbody></table>`
    : `<p class="muted">No code units captured.</p>`;

  const limitsHtml = renderLimitsHtml(a.limits);

  const testResults = a.testResults || [];
  const testsPassed = testResults.filter((t) => t.passed).length;
  const testsFailed = testResults.length - testsPassed;
  const testResultsHtml = testResults.length
    ? `<div class="test-summary">
         <span class="test-pill test-pass">✅ ${testsPassed} passed</span>
         ${testsFailed > 0 ? `<span class="test-pill test-fail">❌ ${testsFailed} failed</span>` : ""}
       </div>
       <table id="tests-table" class="filterable"><thead><tr><th>Result</th><th>Test</th><th>Message</th><th>Line</th></tr></thead><tbody>
         ${testResults
           .map(
             (t) => `<tr class="test-row ${t.passed ? "pass" : "fail"}">
             <td>${t.passed ? "✅" : "❌"}</td>
             <td>${classLink(t.name, t.lineNumber)}</td>
             <td>${t.message ? `<pre>${esc(t.message)}</pre>` : ""}</td>
             <td>${lineLink(t.lineNumber)}</td>
           </tr>`,
           )
           .join("")}
       </tbody></table>`
    : "";

  const flameHtml = renderAreaChartHtml(a.flameRoot);

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><style>
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
    .class-link { color: inherit; text-decoration: none; cursor: pointer; border-bottom: 1px dashed var(--vscode-textLink-foreground); }
    .class-link:hover { background: var(--vscode-editor-hoverHighlightBackground); }
    body { font-family: -apple-system, Segoe UI, sans-serif; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { margin: 0 0 4px; }
    h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
    th { background: var(--vscode-editorWidget-background); }
    code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; margin: 4px 0; }
    /* Collapsible sections (Tables tab) */
    details.section { margin: 12px 0; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    details.section[open] { padding-bottom: 8px; }
    details.section > summary { list-style: none; padding: 10px 14px; cursor: pointer; font-size: 13px; font-weight: 600; user-select: none; display: flex; align-items: center; gap: 8px; }
    details.section > summary::-webkit-details-marker { display: none; }
    details.section > summary::before { content: "▸"; display: inline-block; transition: transform 0.15s; opacity: 0.5; font-size: 10px; }
    details.section[open] > summary::before { transform: rotate(90deg); }
    details.section > summary:hover { background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.06)); }
    details.section > summary .count { font-size: 11px; font-weight: 500; opacity: 0.55; padding: 2px 8px; border-radius: 10px; background: var(--vscode-editorWidget-background); font-family: var(--vscode-editor-font-family); }
    details.section > *:not(summary) { padding: 0 14px; }
    details.section table { margin-top: 4px; }
    /* Cleaner tables — zebra rows, no inter-cell borders */
    details.section table { border-collapse: collapse; }
    details.section table th, details.section table td { border: none; padding: 6px 10px; }
    details.section table thead th { border-bottom: 1px solid var(--vscode-panel-border); background: transparent; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.65; font-weight: 500; }
    details.section table tbody tr:nth-child(even) { background: rgba(127, 127, 127, 0.04); }
    details.section table tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.08)); }
    /* Tighten insight cards */
    .insights { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)) !important; gap: 6px !important; }
    .insight { padding: 10px 12px !important; }
    .header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
    .header h1 { margin: 0; }
    .header .small { opacity: 0.55; }
    .verdict-banner { display: flex; gap: 14px; align-items: center; padding: 14px 18px; border-radius: 8px; margin: 12px 0; border-left: 4px solid; background: var(--vscode-editorWidget-background); }
    .verdict-banner.verdict-good { border-color: #22c55e; }
    .verdict-banner.verdict-warning { border-color: #f59e0b; }
    .verdict-banner.verdict-critical { border-color: #ef4444; }
    .verdict-icon { font-size: 28px; line-height: 1; }
    .verdict-title { font-size: 16px; font-weight: 600; line-height: 1.2; }
    .verdict-detail { font-size: 12px; opacity: 0.7; margin-top: 2px; font-family: var(--vscode-editor-font-family); }
    .metric-strip { display: flex; flex-wrap: wrap; gap: 18px; padding: 10px 0 14px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
    .metric { display: flex; flex-direction: column; gap: 2px; line-height: 1; }
    .metric-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; font-family: var(--vscode-editor-font-family); }
    .metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; opacity: 0.55; }
    .metric.metric-error .metric-value { color: #ef4444; }
    .metric.metric-warning .metric-value { color: #f59e0b; }
    .card { background: var(--vscode-editorWidget-background); padding: 10px 12px; border-radius: 6px; }
    .card .v { font-size: 20px; font-weight: 600; }
    .card .l { font-size: 10px; text-transform: uppercase; opacity: 0.7; letter-spacing: 0.5px; }
    .user-card { border-left: 3px solid #3498db; }
    .issue { border-left: 4px solid; padding: 8px 12px; margin: 8px 0; background: var(--vscode-editorWidget-background); border-radius: 4px; }
    .issue.fatal { border-color: #d33; } .issue.error { border-color: #e67e22; }
    .issue.warning { border-color: #e6c74d; } .issue.info { border-color: #3498db; }
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
    #ai-output { font-size: 13px; line-height: 1.6; min-height: 20px; }
    #ai-output strong { color: var(--vscode-textLink-foreground); display: inline-block; }
    #ai-output h2, #ai-output h3, #ai-output h4 { margin: 12px 0 4px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-textLink-foreground); }
    #ai-output p { margin: 6px 0; }
    #ai-output ul, #ai-output ol { margin: 6px 0 6px 22px; padding: 0; }
    #ai-output li { margin: 2px 0; }
    #ai-output code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
    #ai-output pre.code-block { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; }
    #ai-output pre.code-block code { background: transparent; padding: 0; }
    .chat-message { margin: 10px 0; padding: 10px 12px; border-radius: 6px; }
    .chat-user { background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-textLink-foreground); }
    .chat-assistant { background: rgba(52, 152, 219, 0.05); border-left: 3px solid #3498db; }
    .chat-role { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.6; margin-bottom: 4px; }
    .chat-input-row { display: flex; gap: 8px; margin-top: 12px; }
    .chat-input-row input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px 10px; border-radius: 4px; font-size: 13px; }
    .chat-input-row input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; margin-left: 8px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .line-link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    .line-link:hover { text-decoration: underline; }
    .flame-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
    .flame-block:hover rect { stroke: #fff; stroke-width: 1.5; }
    .flame-tooltip { position: absolute; background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); padding: 8px 10px; border-radius: 4px; font-size: 12px; pointer-events: none; max-width: 400px; z-index: 1000; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
    .table-search { margin: 8px 0 0; }
    .table-search input { width: 100%; max-width: 480px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 5px 8px; border-radius: 4px; font-size: 12px; }
    .filter-empty td, .filter-empty { display: none !important; }
    .limit-block { margin: 12px 0; }
    .limit-ns { font-size: 12px; opacity: 0.7; margin-bottom: 4px; }
    .limits-table { width: 100%; border-collapse: collapse; }
    .limits-table td { border: none; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 8px; font-size: 12px; }
    .limit-name { width: 36%; }
    .limit-num { width: 18%; text-align: right; font-family: var(--vscode-editor-font-family); }
    .limit-pct { width: 8%; text-align: right; font-family: var(--vscode-editor-font-family); }
    .limit-bar-cell { width: 38%; }
    .limit-bar { background: var(--vscode-editorWidget-background); height: 8px; border-radius: 4px; overflow: hidden; border: 1px solid var(--vscode-panel-border); }
    .limit-bar-fill { height: 100%; transition: width 0.2s ease; }
    .limit-bar-fill.ok { background: #22c55e; }
    .limit-bar-fill.warn { background: #f59e0b; }
    .limit-bar-fill.danger { background: #ef4444; }
    .limit-bar-fill.zero { background: transparent; }
    .limit-zero { opacity: 0.5; }
    .limit-zero .limit-num { opacity: 0.6; }
    .stack-trace { margin: 8px 0 0; padding: 8px 10px; background: var(--vscode-editorWidget-background); border-radius: 4px; }
    .stack-trace ol { margin: 4px 0 0 22px; padding: 0; }
    .stack-frame { font-size: 12px; margin: 1px 0; }
    .stack-label { font-size: 10px; text-transform: uppercase; opacity: 0.6; letter-spacing: 0.5px; }
    .test-summary { display: flex; gap: 8px; margin: 8px 0; }
    .test-pill { padding: 4px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .test-pill.test-pass { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
    .test-pill.test-fail { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .test-row.fail { background: rgba(239, 68, 68, 0.05); }
    .ask-row { display: flex; gap: 8px; margin: 8px 0 4px; }
    .ask-row input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px 10px; border-radius: 4px; font-size: 13px; }
    .ask-row input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .ask-summary { font-size: 12px; opacity: 0.85; margin: 8px 0 4px; }
    .ask-empty { font-size: 12px; opacity: 0.7; margin: 8px 0; }
    .ask-error { font-size: 12px; color: #d33; margin: 8px 0; padding: 8px; border-left: 3px solid #d33; background: rgba(239, 68, 68, 0.05); }
    .ask-table { margin: 6px 0 14px; }
    .ask-table th, .ask-table td { font-size: 12px; }
    ${tabSwitchingCss()}
  </style></head>
  <body>
    <div class="header">
      <h1>Apex Doctor</h1>
      <span class="muted small">API ${esc(a.summary.apiVersion)} · ${a.summary.totalEvents} events</span>
    </div>

    ${renderVerdictBanner(a)}

    ${userInfoHtml}

    ${renderRecurringBanner(options.recurring)}

    ${renderMetricStrip(a)}

    <div class="actions">
      <button onclick="explainAll()" id="btn-explain-all">🤖 Explain root cause with AI</button>
      <button onclick="exportMarkdown()">📋 Copy as Markdown</button>
    </div>

    <div class="tabs">
      <button class="tab-btn" data-tab="overview">Overview</button>
      <button class="tab-btn" data-tab="profiler">Profiler</button>
      <button class="tab-btn" data-tab="tables">Tables</button>
    </div>

    <div class="tab-panel" data-panel="overview">
      ${
        a.insights.length
          ? `
        <h2>💡 Performance Insights</h2>
        ${renderInsightsHtml(a.insights)}
      `
          : ""
      }

      <div class="ai-panel" id="ai-panel" style="display:none">
        <h3>🤖 AI Root-Cause Analysis <span class="spinner" id="ai-spinner" style="display:none"></span></h3>
        <div id="chat-history"></div>
        <div id="ai-output"></div>
        <div class="chat-input-row">
          <input id="chat-msg" type="text" placeholder="Ask a follow-up… e.g. 'What if we made this query selective?'" />
          <button id="chat-send" onclick="sendChat()">Send</button>
        </div>
      </div>

      ${
        testResultsHtml
          ? `<h2>🧪 Test Results</h2>${testResultsHtml}`
          : ""
      }

      <h2>🛑 Issues &amp; Errors</h2>
      ${issuesHtml}

      <h2>💬 Ask the Log</h2>
      <p class="muted small">Natural-language query over the parsed log. Examples: <em>"SOQL queries that returned more than 500 rows"</em>, <em>"methods that ran after the exception"</em>, <em>"debug statements from AccountHandler"</em>.</p>
      <div class="ask-row">
        <input id="ask-input" type="text" placeholder="Ask anything about this log…" />
        <button id="ask-btn" onclick="askLog()">Ask</button>
      </div>
      <div id="ask-results"></div>

      ${renderTriggerOrder(a.triggerGroups)}

      ${renderAsyncTracer(a.asyncInvocations, options.asyncLinks ?? [], a.asyncEntryPoint)}

      ${renderDebugLevelRecs(a.debugLevelRecommendations)}

      <h2>📈 Activity Timeline</h2>
      ${flameHtml}

      <h2>📈 Governor Limits</h2>
      ${limitsHtml}
    </div>

    <div class="tab-panel" data-panel="profiler">
      <h2>CPU Profiler</h2>
      <p class="muted">Self-time attribution and hot-path analysis. Find <em>where</em> the CPU actually went, not just which method took longest.</p>
      ${renderCpuProfiler(a)}
    </div>

    <div class="tab-panel" data-panel="tables">
      <details class="section" open>
        <summary>SOQL Queries <span class="count">${a.soql.length}</span></summary>
        ${soqlHtml}
      </details>

      <details class="section" ${a.dml.length ? "" : ""}>
        <summary>DML Operations <span class="count">${a.dml.length}</span></summary>
        ${dmlHtml}
      </details>

      <details class="section">
        <summary>Slowest Methods <span class="count">${a.methods.length}</span></summary>
        ${methodsHtml}
      </details>

      <details class="section">
        <summary>Code Units <span class="count">${a.codeUnits.length}</span></summary>
        ${codeUnitsHtml}
      </details>

      <details class="section">
        <summary>Debug Statements <span class="count">${a.debugs.length}</span></summary>
        ${debugsHtml}
      </details>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const panel = document.getElementById('ai-panel');
      const output = document.getElementById('ai-output');
      const chatHistory = document.getElementById('chat-history');
      const chatInput = document.getElementById('chat-msg');
      const chatSend = document.getElementById('chat-send');
      const spinner = document.getElementById('ai-spinner');
      const btnAll = document.getElementById('btn-explain-all');
      const persisted = vscode.getState() || {};
      let lastAiText = '';
      let activeAssistantText = '';
      let allAiText = persisted.allAiText || '';
      let chatBubbles = Array.isArray(persisted.chatBubbles) ? persisted.chatBubbles : [];

      function persistState() {
        vscode.setState({ chatBubbles, allAiText });
      }

      function rehydrate() {
        if (!chatBubbles.length && !allAiText) { return; }
        panel.style.display = 'block';
        chatHistory.innerHTML = '';
        for (const b of chatBubbles) {
          const div = document.createElement('div');
          div.className = 'chat-message ' + (b.role === 'user' ? 'chat-user' : 'chat-assistant');
          div.innerHTML = '<div class="chat-role">' + (b.role === 'user' ? 'You' : 'Apex Doctor') + '</div>' + renderMarkdown(b.text);
          chatHistory.appendChild(div);
        }
      }

      function exportMarkdown() { vscode.postMessage({ command: 'exportMarkdown', aiText: allAiText }); }

      function startStreaming() {
        panel.style.display = 'block';
        activeAssistantText = '';
        output.innerHTML = '';
        spinner.style.display = 'inline-block';
        btnAll.disabled = true;
        chatSend.disabled = true;
      }

      function explainAll() {
        chatHistory.innerHTML = '';
        chatBubbles = [];
        allAiText = '';
        persistState();
        startStreaming();
        vscode.postMessage({ command: 'explainAll' });
      }

      function explainIssue(idx) {
        chatHistory.innerHTML = '';
        chatBubbles = [];
        allAiText = '';
        persistState();
        startStreaming();
        vscode.postMessage({ command: 'explainIssue', index: idx });
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      function sendChat() {
        const text = (chatInput.value || '').trim();
        if (!text) { return; }
        chatInput.value = '';
        finalizeAssistantMessage();
        startStreaming();
        vscode.postMessage({ command: 'chatTurn', text });
      }

      function suggestFix(idx) {
        vscode.postMessage({ command: 'suggestFix', index: idx });
      }

      const __soqlQueries = ${JSON.stringify(a.soql.map((q) => q.query))};
      function queryPlan(idx) {
        const query = __soqlQueries[idx];
        if (query) { vscode.postMessage({ command: 'queryPlan', query }); }
      }

      function askLog() {
        const input = document.getElementById('ask-input');
        const text = (input.value || '').trim();
        if (!text) { return; }
        const btn = document.getElementById('ask-btn');
        const out = document.getElementById('ask-results');
        btn.disabled = true;
        btn.textContent = 'Asking…';
        out.innerHTML = '';
        vscode.postMessage({ command: 'askLog', text });
      }

      const askInput = document.getElementById('ask-input');
      askInput && askInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askLog(); }
      });

      function renderAskResult(msg) {
        const out = document.getElementById('ask-results');
        const btn = document.getElementById('ask-btn');
        btn.disabled = false;
        btn.textContent = 'Ask';
        if (msg.error) {
          out.innerHTML = '<div class="ask-error">⚠️ ' + escapeHtmlInline(msg.error) + (msg.raw ? '<details><summary>Raw response</summary><pre>' + escapeHtmlInline(msg.raw) + '</pre></details>' : '') + '</div>';
          return;
        }
        const r = msg.result;
        if (!r || !r.items || !r.items.length) {
          out.innerHTML = '<div class="ask-empty">' + escapeHtmlInline(r?.summary || 'No matches.') + '</div>';
          return;
        }
        const headerByKind = {
          soql: ['Query', 'Rows', 'ms', 'Line'],
          dml: ['Op', 'Rows', 'ms', 'Line'],
          methods: ['Method', 'ms', 'Line', ''],
          debugs: ['Level', 'Message', 'Line', ''],
          issues: ['Sev', 'Type', 'Message', 'Line'],
          code_units: ['Code Unit', 'ms', '', '']
        };
        const headers = headerByKind[r.kind] || ['#', 'Detail', '', ''];
        const rows = r.items.map((it) => {
          const cells = (() => {
            switch (r.kind) {
              case 'soql': return [escapeHtmlInline(it.query || ''), it.rows ?? '-', (it.durationMs || 0).toFixed(1), it.lineNumber ?? '-'];
              case 'dml': return [escapeHtmlInline(it.operation || ''), it.rows ?? '-', (it.durationMs || 0).toFixed(1), it.lineNumber ?? '-'];
              case 'methods': return [escapeHtmlInline(it.name || ''), (it.durationMs || 0).toFixed(1), it.lineNumber ?? '-', ''];
              case 'debugs': return [escapeHtmlInline(it.level || ''), escapeHtmlInline((it.message || '').slice(0, 200)), it.lineNumber ?? '-', ''];
              case 'issues': return [escapeHtmlInline(it.severity || ''), escapeHtmlInline(it.type || ''), escapeHtmlInline((it.message || '').slice(0, 160)), it.lineNumber ?? '-'];
              case 'code_units': return [escapeHtmlInline(it.name || ''), (it.durationMs || 0).toFixed(1), '', ''];
              default: return ['', JSON.stringify(it), '', ''];
            }
          })();
          return '<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>';
        }).join('');
        out.innerHTML = '<div class="ask-summary">' + escapeHtmlInline(r.summary) + ' (' + r.items.length + ' result' + (r.items.length === 1 ? '' : 's') + ')</div>' +
          '<table class="ask-table"><thead><tr>' + headers.map((h) => '<th>' + escapeHtmlInline(h) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
      }

      chatInput && chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChat();
        }
      });

      function escapeHtmlInline(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function renderMarkdown(md) {
        if (!md) { return ''; }
        const codeBlocks = [];
        let html = md.replace(/\`\`\`(\\w+)?\\n?([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
          const idx = codeBlocks.push(code) - 1;
          return '\\u0000CB' + idx + '\\u0000';
        });
        html = escapeHtmlInline(html);
        html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[^*])\\*([^*\\n]+?)\\*(?!\\*)/g, '$1<em>$2</em>');
        html = html.replace(/\`([^\`\\n]+?)\`/g, '<code>$1</code>');
        html = html.replace(/(^|\\n)((?:- .+(?:\\n|$))+)/g, (_, pre, block) => {
          const items = block.trim().split('\\n').map((l) => l.replace(/^- /, ''));
          return pre + '<ul>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ul>';
        });
        html = html.replace(/(^|\\n)((?:\\d+\\. .+(?:\\n|$))+)/g, (_, pre, block) => {
          const items = block.trim().split('\\n').map((l) => l.replace(/^\\d+\\. /, ''));
          return pre + '<ol>' + items.map((i) => '<li>' + i + '</li>').join('') + '</ol>';
        });
        const paras = html.split(/\\n{2,}/).map((p) => {
          const trimmed = p.trim();
          if (!trimmed) { return ''; }
          if (/^<(h\\d|ul|ol|pre|table)/.test(trimmed)) { return trimmed; }
          return '<p>' + trimmed.replace(/\\n/g, '<br>') + '</p>';
        });
        html = paras.join('');
        html = html.replace(/\\u0000CB(\\d+)\\u0000/g, (_, idx) => {
          const code = codeBlocks[Number(idx)] || '';
          return '<pre class="code-block"><code>' + escapeHtmlInline(code) + '</code></pre>';
        });
        return html;
      }

      function finalizeAssistantMessage() {
        if (activeAssistantText) {
          const div = document.createElement('div');
          div.className = 'chat-message chat-assistant';
          div.innerHTML = '<div class="chat-role">Apex Doctor</div>' + renderMarkdown(activeAssistantText);
          chatHistory.appendChild(div);
          chatBubbles.push({ role: 'assistant', text: activeAssistantText });
          persistState();
        }
        output.innerHTML = '';
        activeAssistantText = '';
      }

      function appendUserBubble(text) {
        const div = document.createElement('div');
        div.className = 'chat-message chat-user';
        div.innerHTML = '<div class="chat-role">You</div>' + renderMarkdown(text);
        chatHistory.appendChild(div);
        chatBubbles.push({ role: 'user', text });
        persistState();
      }

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.command === 'aiChunk') {
          activeAssistantText += msg.text;
          allAiText += msg.text;
          lastAiText = activeAssistantText;
          output.innerHTML = renderMarkdown(activeAssistantText);
          persistState();
        } else if (msg.command === 'aiDone') {
          spinner.style.display = 'none';
          btnAll.disabled = false;
          chatSend.disabled = false;
          finalizeAssistantMessage();
        } else if (msg.command === 'aiError') {
          spinner.style.display = 'none';
          btnAll.disabled = false;
          chatSend.disabled = false;
          output.innerHTML += '<p style="color:#d33">⚠️ ' + msg.error + '</p>';
        } else if (msg.command === 'chatUserEcho') {
          appendUserBubble(msg.text);
        } else if (msg.command === 'askLogResult') {
          renderAskResult(msg);
        }
      });

      // Client-side filter for tables and lists
      document.querySelectorAll('.filter-input').forEach((input) => {
        input.addEventListener('input', (e) => {
          const target = e.target;
          const tableId = target.getAttribute('data-target');
          const root = document.getElementById(tableId);
          if (!root) { return; }
          const q = target.value.trim().toLowerCase();
          if (root.tagName === 'TABLE') {
            const rows = root.querySelectorAll('tbody tr');
            rows.forEach((tr) => {
              const text = tr.textContent.toLowerCase();
              if (!q || text.indexOf(q) !== -1) {
                tr.classList.remove('filter-empty');
              } else {
                tr.classList.add('filter-empty');
              }
            });
          } else {
            const items = root.querySelectorAll('.filter-item');
            items.forEach((it) => {
              const text = it.textContent.toLowerCase();
              if (!q || text.indexOf(q) !== -1) {
                it.classList.remove('filter-empty');
              } else {
                it.classList.add('filter-empty');
              }
            });
          }
        });
      });

      rehydrate();

      ${tabSwitchingScript()}

      // Line-link and class-link delegation
      document.body.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) { return; }
        if (a.classList.contains('line-link')) {
          e.preventDefault();
          const line = Number(a.getAttribute('data-line'));
          if (line) { vscode.postMessage({ command: 'jumpToLine', line }); }
        } else if (a.classList.contains('class-link')) {
          e.preventDefault();
          const className = a.getAttribute('data-class');
          const lineAttr = a.getAttribute('data-line');
          const line = lineAttr ? Number(lineAttr) : undefined;
          if (className) { vscode.postMessage({ command: 'openClass', className, line }); }
        }
      });
    </script>
  </body></html>`;
}
