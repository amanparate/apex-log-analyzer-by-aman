import { Comparison } from './compareService';

const escAttr = (s: string) =>
  (s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

const MARKER: Record<string, string> = {
  same: ' ',
  added: '+',
  removed: '−',
  changed: '~',
};

function renderLineDiff(c: Comparison): string {
  if (!c.lineDiff) {
    return '';
  }
  const { ops, stats } = c.lineDiff;
  const total = stats.same + stats.added + stats.removed + stats.changed;
  if (total === 0) {
    return '';
  }
  const rows = ops
    .map(
      (op) => `
        <div class="linediff-row ${op.kind}">
          <span class="linediff-marker ${op.kind}">${MARKER[op.kind]}</span>
          <span>${escAttr(op.label)}${op.detail ? `<span class="linediff-detail">— ${escAttr(op.detail)}</span>` : ''}</span>
        </div>`,
    )
    .join('');

  return `
    <h2>📜 Execution Path Diff</h2>
    <p class="muted">Event-by-event diff of significant log events (METHOD_ENTRY, SOQL, DML, exceptions, debugs, callouts). Helps you see <em>which</em> branches were taken differently between runs.</p>
    <div class="linediff-stats">
      <span class="linediff-pill same">${stats.same} unchanged</span>
      <span class="linediff-pill added">${stats.added} added</span>
      <span class="linediff-pill removed">${stats.removed} removed</span>
      <span class="linediff-pill changed">${stats.changed} changed</span>
    </div>
    <div class="linediff-list">${rows}</div>
  `;
}

export function renderComparisonHtml(c: Comparison): string {
  const esc = (s: string) =>
    (s ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
  const fmt = (n: number) => n.toFixed(2);
  const signed = (n: number, unit = '') => `${n >= 0 ? '+' : ''}${fmt(n)}${unit}`;
  const signedInt = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
  const deltaClass = (n: number, inverted = false) => {
    if (Math.abs(n) < 0.01) { return 'neutral'; }
    const isWorse = inverted ? n < 0 : n > 0;
    return isWorse ? 'worse' : 'better';
  };

  const verdictBg: Record<string, string> = {
    faster: 'linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(22, 163, 74, 0.08))',
    slower: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(217, 119, 6, 0.08))',
    equivalent: 'linear-gradient(135deg, rgba(100, 116, 139, 0.15), rgba(71, 85, 105, 0.08))',
    regressed: 'linear-gradient(135deg, rgba(239, 68, 68, 0.18), rgba(220, 38, 38, 0.1))'
  };

  const summaryCards = `
    <div class="compare-summary">
      <div class="card">
        <div class="l">Duration</div>
        <div class="v">${fmt(c.summary.comparison.durationMs)} ms</div>
        <div class="delta ${deltaClass(c.summary.deltas.durationMs)}">${signed(c.summary.deltas.durationMs, ' ms')} (${signed(c.summary.deltas.durationPct, '%')})</div>
        <div class="muted">baseline: ${fmt(c.summary.baseline.durationMs)} ms</div>
      </div>
      <div class="card">
        <div class="l">SOQL Queries</div>
        <div class="v">${c.summary.comparison.soqlCount}</div>
        <div class="delta ${deltaClass(c.summary.deltas.soqlCount)}">${signedInt(c.summary.deltas.soqlCount)}</div>
        <div class="muted">baseline: ${c.summary.baseline.soqlCount}</div>
      </div>
      <div class="card">
        <div class="l">DML Operations</div>
        <div class="v">${c.summary.comparison.dmlCount}</div>
        <div class="delta ${deltaClass(c.summary.deltas.dmlCount)}">${signedInt(c.summary.deltas.dmlCount)}</div>
        <div class="muted">baseline: ${c.summary.baseline.dmlCount}</div>
      </div>
      <div class="card">
        <div class="l">Errors</div>
        <div class="v">${c.summary.comparison.errorCount}</div>
        <div class="delta ${deltaClass(c.summary.deltas.errorCount)}">${signedInt(c.summary.deltas.errorCount)}</div>
        <div class="muted">baseline: ${c.summary.baseline.errorCount}</div>
      </div>
      <div class="card">
        <div class="l">Warnings</div>
        <div class="v">${c.summary.comparison.warningCount}</div>
        <div class="delta ${deltaClass(c.summary.deltas.warningCount)}">${signedInt(c.summary.deltas.warningCount)}</div>
        <div class="muted">baseline: ${c.summary.baseline.warningCount}</div>
      </div>
      <div class="card">
        <div class="l">Debug Logs</div>
        <div class="v">${c.summary.comparison.debugCount}</div>
        <div class="delta ${deltaClass(c.summary.deltas.debugCount)}">${signedInt(c.summary.deltas.debugCount)}</div>
        <div class="muted">baseline: ${c.summary.baseline.debugCount}</div>
      </div>
    </div>`;

  const issuesResolved = c.issues.onlyInBaseline.length
    ? c.issues.onlyInBaseline.map(i => `
        <div class="issue-row resolved">
          <span class="badge-sm ${i.severity}">${i.severity.toUpperCase()}</span>
          <strong>${esc(i.type)}</strong>
          ${i.lineNumber ? `<span class="muted">line ${i.lineNumber}</span>` : ''}
          <div class="issue-msg">${esc(i.message.slice(0, 200))}</div>
        </div>`).join('')
    : '<p class="muted">None</p>';

  const issuesNew = c.issues.onlyInComparison.length
    ? c.issues.onlyInComparison.map(i => `
        <div class="issue-row new">
          <span class="badge-sm ${i.severity}">${i.severity.toUpperCase()}</span>
          <strong>${esc(i.type)}</strong>
          ${i.lineNumber ? `<span class="muted">line ${i.lineNumber}</span>` : ''}
          <div class="issue-msg">${esc(i.message.slice(0, 200))}</div>
        </div>`).join('')
    : '<p class="muted">None</p>';

  const methodRows = c.methods.slice(0, 30).map(m => {
    const statusBadge = {
      new: '<span class="status-pill new">NEW</span>',
      removed: '<span class="status-pill removed">REMOVED</span>',
      regressed: '<span class="status-pill regressed">SLOWER</span>',
      improved: '<span class="status-pill improved">FASTER</span>',
      unchanged: '<span class="status-pill unchanged">=</span>'
    }[m.status];
    const callsCell = m.baselineCalls === m.comparisonCalls
      ? `${m.comparisonCalls}`
      : `${m.baselineCalls} → ${m.comparisonCalls} <span class="delta ${deltaClass(m.callsDelta)}">${signedInt(m.callsDelta)}</span>`;
    return `
      <tr>
        <td><code>${esc(m.name)}</code> ${statusBadge}</td>
        <td>${callsCell}</td>
        <td>${m.baselineMs !== undefined ? fmt(m.baselineMs) + ' ms' : '-'}</td>
        <td>${m.comparisonMs !== undefined ? fmt(m.comparisonMs) + ' ms' : '-'}</td>
        <td class="${deltaClass(m.deltaMs)}">${signed(m.deltaMs, ' ms')}</td>
        <td class="${deltaClass(m.deltaPct)}">${m.baselineMs ? signed(m.deltaPct, '%') : 'n/a'}</td>
      </tr>`;
  }).join('');

  const soqlRows = c.soql.slice(0, 20).map(s => `
    <tr>
      <td><code>${esc(s.queryPattern.slice(0, 100))}${s.queryPattern.length > 100 ? '…' : ''}</code></td>
      <td>${s.baselineCount} → ${s.comparisonCount} <span class="delta ${deltaClass(s.countDelta)}">${signedInt(s.countDelta)}</span></td>
      <td>${s.baselineRows} → ${s.comparisonRows} <span class="delta ${deltaClass(s.rowsDelta)}">${signedInt(s.rowsDelta)}</span></td>
      <td>${fmt(s.baselineTotalMs)} → ${fmt(s.comparisonTotalMs)} ms <span class="delta ${deltaClass(s.msDelta)}">${signed(s.msDelta, ' ms')}</span></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, Segoe UI, sans-serif; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { margin: 0 0 4px; }
    h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 28px; }
    .verdict { background: ${verdictBg[c.summary.verdict]}; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
    .verdict-text { font-size: 18px; font-weight: 600; }
    .labels { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; font-size: 12px; opacity: 0.85; }
    .label-chip { background: var(--vscode-editorWidget-background); padding: 2px 8px; border-radius: 10px; }
    .compare-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-top: 8px; }
    .card { background: var(--vscode-editorWidget-background); padding: 10px 12px; border-radius: 6px; }
    .card .v { font-size: 22px; font-weight: 600; }
    .card .l { font-size: 10px; text-transform: uppercase; opacity: 0.7; letter-spacing: 0.5px; }
    .card .muted { font-size: 11px; opacity: 0.65; margin-top: 4px; }
    .delta { font-size: 12px; font-weight: 600; margin-top: 4px; }
    .delta.better, .better { color: #22c55e; }
    .delta.worse, .worse { color: #ef4444; }
    .delta.neutral, .neutral { color: var(--vscode-foreground); opacity: 0.6; }
    .issue-row { padding: 8px 12px; margin: 6px 0; border-radius: 4px; background: var(--vscode-editorWidget-background); border-left: 3px solid; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .issue-row.resolved { border-color: #22c55e; }
    .issue-row.new { border-color: #ef4444; }
    .issue-msg { width: 100%; font-size: 12px; opacity: 0.8; margin-top: 4px; }
    .badge-sm { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; }
    .badge-sm.fatal { background: #d33; color: #fff; }
    .badge-sm.error { background: #e67e22; color: #fff; }
    .badge-sm.warning { background: #e6c74d; color: #000; }
    .badge-sm.info { background: #3498db; color: #fff; }
    .muted { opacity: 0.7; font-size: 12px; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; vertical-align: top; font-size: 12px; }
    th { background: var(--vscode-editorWidget-background); }
    code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .issue-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 8px; }
    .issue-col h3 { font-size: 13px; margin: 0 0 6px; }
    .status-pill { display: inline-block; padding: 1px 6px; margin-left: 6px; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: 0.5px; vertical-align: middle; }
    .status-pill.new { background: #3b82f6; color: #fff; }
    .status-pill.removed { background: #6b7280; color: #fff; }
    .status-pill.regressed { background: #ef4444; color: #fff; }
    .status-pill.improved { background: #22c55e; color: #fff; }
    .status-pill.unchanged { background: var(--vscode-editorWidget-background); opacity: 0.7; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .linediff-stats { display: flex; gap: 8px; margin: 8px 0 4px; font-size: 12px; }
    .linediff-pill { padding: 2px 8px; border-radius: 10px; font-family: var(--vscode-editor-font-family); }
    .linediff-pill.same { background: rgba(100, 116, 139, 0.15); }
    .linediff-pill.added { background: rgba(34, 197, 94, 0.15); color: #22c55e; }
    .linediff-pill.removed { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .linediff-pill.changed { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
    .linediff-list { font-family: var(--vscode-editor-font-family); font-size: 12px; max-height: 480px; overflow-y: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-top: 8px; }
    .linediff-row { display: grid; grid-template-columns: 18px 1fr; gap: 8px; padding: 2px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .linediff-row:last-child { border-bottom: none; }
    .linediff-row.same { opacity: 0.55; }
    .linediff-row.added { background: rgba(34, 197, 94, 0.08); }
    .linediff-row.removed { background: rgba(239, 68, 68, 0.08); }
    .linediff-row.changed { background: rgba(245, 158, 11, 0.06); }
    .linediff-marker { font-weight: 600; }
    .linediff-marker.same { color: var(--vscode-foreground); opacity: 0.4; }
    .linediff-marker.added { color: #22c55e; }
    .linediff-marker.removed { color: #ef4444; }
    .linediff-marker.changed { color: #f59e0b; }
    .linediff-detail { margin-left: 8px; opacity: 0.75; font-style: italic; }
  </style></head>
  <body>
    <h1>📊 Log Comparison</h1>
    <div class="labels">
      <span class="label-chip">Baseline: ${esc(c.summary.baseline.label)}</span>
      <span class="label-chip">Comparison: ${esc(c.summary.comparison.label)}</span>
    </div>
    <div class="verdict">
      <div class="verdict-text">${esc(c.summary.verdictText)}</div>
    </div>
    <div style="margin: 10px 0">
      <button onclick="exportMarkdown()">📋 Copy comparison as Markdown</button>
    </div>
    <h2>Summary Deltas</h2>
    ${summaryCards}
    <h2>🐌 Method Performance (top 30 changes)</h2>
    <p class="muted">Total time per method (sum of all calls). "Calls" shows invocation count.</p>
    <table>
      <tr><th>Method</th><th>Calls</th><th>Baseline (total)</th><th>Comparison (total)</th><th>Δ ms</th><th>Δ %</th></tr>
      ${methodRows || '<tr><td colspan="6" class="muted">No method data to compare.</td></tr>'}
    </table>
    <h2>🛑 Issue Diff</h2>
    <p class="muted">${c.issues.commonCount} issue${c.issues.commonCount === 1 ? '' : 's'} present in both logs.</p>
    <div class="issue-columns">
      <div class="issue-col">
        <h3 style="color:#22c55e">✅ Resolved in Comparison (${c.issues.onlyInBaseline.length})</h3>
        ${issuesResolved}
      </div>
      <div class="issue-col">
        <h3 style="color:#ef4444">🆕 New in Comparison (${c.issues.onlyInComparison.length})</h3>
        ${issuesNew}
      </div>
    </div>
    <h2>🗃️ SOQL Pattern Changes (top 20)</h2>
    <table>
      <tr><th>Query pattern</th><th>Count (B → C)</th><th>Rows (B → C)</th><th>Total ms (B → C)</th></tr>
      ${soqlRows || '<tr><td colspan="4" class="muted">No SOQL to compare.</td></tr>'}
    </table>

    ${renderLineDiff(c)}

    <script>
      const vscode = acquireVsCodeApi();
      function exportMarkdown() { vscode.postMessage({ command: 'exportCompareMarkdown' }); }
    </script>
  </body></html>`;
}

export function buildComparisonMarkdown(c: Comparison): string {
  const signed = (n: number, unit = '') => `${n >= 0 ? '+' : ''}${n.toFixed(2)}${unit}`;
  const signedInt = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
  const lines: string[] = [];
  lines.push(`# Apex Log Comparison`);
  lines.push('');
  lines.push(`**Baseline:** ${c.summary.baseline.label}  `);
  lines.push(`**Comparison:** ${c.summary.comparison.label}  `);
  lines.push(`**Verdict:** ${c.summary.verdictText}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Baseline | Comparison | Δ |`);
  lines.push(`|---|---|---|---|`);
  lines.push(`| Duration | ${c.summary.baseline.durationMs.toFixed(0)} ms | ${c.summary.comparison.durationMs.toFixed(0)} ms | ${signed(c.summary.deltas.durationMs, ' ms')} (${signed(c.summary.deltas.durationPct, '%')}) |`);
  lines.push(`| SOQL Queries | ${c.summary.baseline.soqlCount} | ${c.summary.comparison.soqlCount} | ${signedInt(c.summary.deltas.soqlCount)} |`);
  lines.push(`| DML Operations | ${c.summary.baseline.dmlCount} | ${c.summary.comparison.dmlCount} | ${signedInt(c.summary.deltas.dmlCount)} |`);
  lines.push(`| Errors | ${c.summary.baseline.errorCount} | ${c.summary.comparison.errorCount} | ${signedInt(c.summary.deltas.errorCount)} |`);
  lines.push(`| Warnings | ${c.summary.baseline.warningCount} | ${c.summary.comparison.warningCount} | ${signedInt(c.summary.deltas.warningCount)} |`);
  lines.push(`| Debug Logs | ${c.summary.baseline.debugCount} | ${c.summary.comparison.debugCount} | ${signedInt(c.summary.deltas.debugCount)} |`);
  lines.push('');

  if (c.issues.onlyInComparison.length) {
    lines.push(`## 🆕 New issues in Comparison`);
    lines.push('');
    for (const i of c.issues.onlyInComparison) {
      lines.push(`- **[${i.severity.toUpperCase()}]** ${i.type}${i.lineNumber ? ` (line ${i.lineNumber})` : ''} — ${i.message.slice(0, 200)}`);
    }
    lines.push('');
  }

  if (c.issues.onlyInBaseline.length) {
    lines.push(`## ✅ Resolved in Comparison`);
    lines.push('');
    for (const i of c.issues.onlyInBaseline) {
      lines.push(`- **[${i.severity.toUpperCase()}]** ${i.type}${i.lineNumber ? ` (line ${i.lineNumber})` : ''} — ${i.message.slice(0, 200)}`);
    }
    lines.push('');
  }

  const regressed = c.methods.filter(m => m.status === 'regressed' || m.status === 'new').slice(0, 20);
  if (regressed.length) {
    lines.push(`## 🐌 Method Regressions (top 20)`);
    lines.push('');
    lines.push(`| Method | Calls | Baseline total (ms) | Comparison total (ms) | Δ ms | Δ % |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const m of regressed) {
      const calls = m.baselineCalls === m.comparisonCalls
        ? `${m.comparisonCalls}`
        : `${m.baselineCalls} → ${m.comparisonCalls}`;
      lines.push(`| \`${m.name}\` | ${calls} | ${m.baselineMs?.toFixed(2) ?? '-'} | ${m.comparisonMs?.toFixed(2) ?? '-'} | ${signed(m.deltaMs, ' ms')} | ${m.baselineMs ? signed(m.deltaPct, '%') : 'n/a'} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}