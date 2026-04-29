import * as vscode from 'vscode';
import { ApexLogRecord } from './salesforceService';


export class StreamView {
  private panel: vscode.WebviewPanel | undefined;
  private logs: ApexLogRecord[] = [];
  private onPickedCallback?: (logId: string) => void;
  private onStopRequestedCallback?: () => void;
  private onStartRequestedCallback?: () => void;
  private onTraceUserCallback?: () => void;

  show(_context: vscode.ExtensionContext) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'apexLogStream',
      '🔴 Live Apex Log Stream',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true }
    );

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'pickLog' && this.onPickedCallback) {
        this.onPickedCallback(msg.logId);
      } else if (msg.command === 'stopStream' && this.onStopRequestedCallback) {
        this.onStopRequestedCallback();
      } else if (msg.command === 'startStream' && this.onStartRequestedCallback) {
      this.onStartRequestedCallback();
      } else if (msg.command === 'traceUser' && this.onTraceUserCallback) {
      this.onTraceUserCallback();
      } else if (msg.command === 'clearList') {
        this.logs = [];
        this.panel?.webview.postMessage({ command: 'setLogs', logs: [] });
      } else if (msg.command === 'ready') {
        // Webview JS finished loading — hydrate it with our authoritative state
        this.panel?.webview.postMessage({ command: 'setLogs', logs: this.logs });
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Build the static HTML shell exactly once. All subsequent updates flow through postMessage.
    this.panel.webview.html = this.buildShellHtml();
  }

  onPicked(cb: (logId: string) => void) { this.onPickedCallback = cb; }
  onStopRequested(cb: () => void) { this.onStopRequestedCallback = cb; }
  onStartRequested(cb: () => void) { this.onStartRequestedCallback = cb; }
  onTraceUser(cb: () => void) { this.onTraceUserCallback = cb; }

  addLog(log: ApexLogRecord) {
    // Defensive dedupe — streamingService also dedupes, but this keeps the view honest
    if (this.logs.some(l => l.Id === log.Id)) { return; }
    this.logs.unshift(log);
    if (this.logs.length > 100) { this.logs = this.logs.slice(0, 100); }
    this.panel?.webview.postMessage({ command: 'addLog', log, cap: 100 });
  }

  setStatus(running: boolean, message?: string) {
    this.panel?.webview.postMessage({ command: 'status', running, message });
  }

  close() {
    this.panel?.dispose();
  }

  private buildShellHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, Segoe UI, sans-serif; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
  .status-chip { font-size: 11px; padding: 3px 8px; border-radius: 12px; background: var(--vscode-editorWidget-background); font-weight: normal; opacity: 0.85; }
  .status-chip.running { background: #ef4444; color: #fff; }
  .controls { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; align-items: center; }
  .filter-bar { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 280px; }
  .filter-bar input {
    flex: 1; min-width: 180px; padding: 5px 8px; font-size: 12px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
  }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); }
  .pill { padding: 3px 10px; font-size: 11px; border-radius: 12px; background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); opacity: 0.7; }
  .pill.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; }
  .pill:hover { opacity: 1; }
  .counter { font-size: 11px; opacity: 0.65; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
  th { background: var(--vscode-editorWidget-background); font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; opacity: 0.8; position: sticky; top: 0; z-index: 1; }
  .log-row:hover { background: var(--vscode-list-hoverBackground); cursor: pointer; }
  .log-row.hidden { display: none; }
  .log-row.new { animation: flash 0.7s ease-out; }
  @keyframes flash { from { background: var(--vscode-editor-selectionBackground); } to { background: transparent; } }
  .status-cell.ok { color: #22c55e; }
  .status-cell.err { color: #ef4444; }
  .id-cell code { opacity: 0.7; font-size: 11px; }
  .empty-state { padding: 20px; text-align: center; opacity: 0.6; }
  .tip { font-size: 11px; opacity: 0.6; margin-top: 12px; }
  .analyze-btn { padding: 2px 10px; font-size: 11px; }
</style></head>
<body>
  <h1>🔴 Live Apex Log Stream <span class="status-chip running" id="status">Streaming</span></h1>
  <div class="controls">
    <button id="btn-toggle">⏹ Stop Streaming</button>
    <button id="btn-clear">🗑 Clear list</button>
    <button id="btn-trace-user" class="secondary" title="Capture logs for another user">+ Trace user</button>
    <div class="filter-bar">
      <input id="filter-text" type="text" placeholder="Search operation, user, or ID…" />
      <select id="filter-user" title="Filter by user">
        <option value="">All users</option>
      </select>
      <button class="pill active" data-status="all">All</button>
      <button class="pill" data-status="success">Success</button>
      <button class="pill" data-status="error">Errors</button>
    </div>
    <span class="counter" id="counter">0 logs</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Operation</th><th>Status</th><th>Duration</th><th>Size</th><th>User</th><th>Time</th><th></th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty-state" class="empty-state">Waiting for logs… run any Apex in the org to see them appear here.</div>
  <p class="tip">Click any row to drill into full analysis in the main panel.</p>
  <script>
    const vscode = acquireVsCodeApi();
    const tbody = document.getElementById('rows');
    const emptyState = document.getElementById('empty-state');
    const counter = document.getElementById('counter');
    const filterInput = document.getElementById('filter-text');
    const statusChip = document.getElementById('status');

    // Restore filter state across panel hide/show
    const persisted = vscode.getState() || {};
    let logs = []; // newest first
    let filterText = persisted.filterText || '';
    let filterStatus = persisted.filterStatus || 'all';
    let filterUser = persisted.filterUser || '';
    const userSelect = document.getElementById('filter-user');
    filterInput.value = filterText;
    document.querySelectorAll('.pill').forEach(p => {
      p.classList.toggle('active', p.dataset.status === filterStatus);
    });

    const persist = () => vscode.setState({ filterText, filterStatus, filterUser });

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function rowMatchesFilter(log) {
      const status = (log.Status || '').toLowerCase();
      if (filterStatus === 'success' && status !== 'success') return false;
      if (filterStatus === 'error' && status === 'success') return false;
      const userName = (log.LogUser && log.LogUser.Name) || '';
      if (filterUser && userName !== filterUser) return false;
      if (!filterText) return true;
      const needle = filterText.toLowerCase();
      const haystack = [log.Id, log.Operation, userName, log.Status]
        .filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    }

    function buildRowHtml(log) {
      const isOk = (log.Status || '').toLowerCase() === 'success';
      return '<tr class="log-row" data-id="' + esc(log.Id) + '">' +
        '<td class="id-cell"><code>' + esc((log.Id || '').slice(-8)) + '</code></td>' +
        '<td><strong>' + esc(log.Operation || 'Anonymous') + '</strong></td>' +
        '<td class="status-cell ' + (isOk ? 'ok' : 'err') + '">' + esc(log.Status || '-') + '</td>' +
        '<td>' + (log.DurationMilliseconds ?? 0) + 'ms</td>' +
        '<td>' + ((log.LogLength ?? 0) / 1024).toFixed(1) + ' KB</td>' +
        '<td>' + esc((log.LogUser && log.LogUser.Name) || 'Unknown') + '</td>' +
        '<td>' + esc(new Date(log.StartTime).toLocaleTimeString()) + '</td>' +
        '<td><button class="analyze-btn">Analyse</button></td>' +
      '</tr>';
    }

    function refreshCounter() {
      const visible = tbody.querySelectorAll('.log-row:not(.hidden)').length;
      const total = logs.length;
      counter.textContent = (visible === total)
        ? total + ' log' + (total === 1 ? '' : 's')
        : 'Showing ' + visible + ' of ' + total;
      emptyState.style.display = total === 0 ? 'block' : 'none';
    }

    function applyFilter() {
      tbody.querySelectorAll('.log-row').forEach(row => {
        const log = logs.find(l => l.Id === row.dataset.id);
        if (!log) return;
        row.classList.toggle('hidden', !rowMatchesFilter(log));
      });
      refreshCounter();
    }

    function refreshUserOptions() {
      const users = [...new Set(logs.map(l => l.LogUser && l.LogUser.Name).filter(Boolean))].sort();
      const previous = filterUser;
      userSelect.innerHTML = '<option value="">All users</option>' +
        users.map(u => '<option value="' + esc(u) + '"' + (u === previous ? ' selected' : '') + '>' + esc(u) + '</option>').join('');
      // Reset selection if the chosen user no longer has any logs (e.g. after Clear)
      if (previous && !users.includes(previous)) {
        filterUser = '';
        persist();
      }
    }

    function renderAll() {
      tbody.innerHTML = logs.map(buildRowHtml).join('');
      applyFilter();
    }

    // Event delegation: row clicks
    tbody.addEventListener('click', (e) => {
      const row = e.target.closest('.log-row');
      if (!row) return;
      const id = row.dataset.id;
      if (id) vscode.postMessage({ command: 'pickLog', logId: id });
    });

    const btnToggle = document.getElementById('btn-toggle');
    let isStreaming = true;

    function refreshToggle() {
      btnToggle.textContent = isStreaming ? '⏹ Stop Streaming' : '▶ Start Streaming';
    }

    btnToggle.addEventListener('click', () => {
      vscode.postMessage({ command: isStreaming ? 'stopStream' : 'startStream' });
    });
    document.getElementById('btn-clear').addEventListener('click',
      () => vscode.postMessage({ command: 'clearList' }));

    filterInput.addEventListener('input', () => {
      filterText = filterInput.value;
      persist();
      applyFilter();
    });

    userSelect.addEventListener('change', () => {
    filterUser = userSelect.value;
    persist();
    applyFilter();
  });

  document.getElementById('btn-trace-user').addEventListener('click', () => {
    vscode.postMessage({ command: 'traceUser' });
  });

    document.querySelectorAll('.pill').forEach(p => {
      p.addEventListener('click', () => {
        document.querySelectorAll('.pill').forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        filterStatus = p.dataset.status;
        persist();
        applyFilter();
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'addLog') {
        if (logs.some(l => l.Id === msg.log.Id)) return;
        logs.unshift(msg.log);
        const cap = msg.cap || 100;
        if (logs.length > cap) logs = logs.slice(0, cap);
        // Evict oldest DOM row if we're at cap
        while (tbody.children.length >= cap) {
          tbody.removeChild(tbody.lastElementChild);
        }
        const tmp = document.createElement('tbody');
        tmp.innerHTML = buildRowHtml(msg.log);
        const newRow = tmp.firstElementChild;
        if (!rowMatchesFilter(msg.log)) newRow.classList.add('hidden');
        newRow.classList.add('new');
        tbody.insertBefore(newRow, tbody.firstChild);
        refreshCounter();
      } else if (msg.command === 'setLogs') {
        logs = msg.logs || [];
        renderAll();
      } else if (msg.command === 'status') {
        isStreaming = !!msg.running;
        refreshToggle();
        if (msg.running) {
          statusChip.className = 'status-chip running';
          statusChip.textContent = msg.message || 'Streaming';
        } else {
          statusChip.className = 'status-chip';
          statusChip.textContent = msg.message || 'Stopped';
        }
      }
    });

    // Initial empty-state paint, then ask the extension to hydrate us
    refreshCounter();
    vscode.postMessage({ command: 'ready' });
  </script>
</body></html>`;
  }
}