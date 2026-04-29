import * as vscode from 'vscode';
import { TraceFlagInfo } from './salesforceService';

export class TraceFlagView {
  private panel: vscode.WebviewPanel | undefined;
  private flags: TraceFlagInfo[] = [];
  private onNewTraceCallback?: () => void;
  private onDeleteCallback?: (flagId: string) => void;
  private onExtendCallback?: (flagId: string, expirationIso: string, minutes: number) => void;
  private onRefreshCallback?: () => void;

  show(_context: vscode.ExtensionContext) {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'apexDoctorTraceFlags',
      '🎯 Trace Flag Manager',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true },
    );

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'newTrace') { this.onNewTraceCallback?.(); }
      else if (msg.command === 'delete') { this.onDeleteCallback?.(msg.flagId); }
      else if (msg.command === 'extend') { this.onExtendCallback?.(msg.flagId, msg.expirationIso, msg.minutes); }
      else if (msg.command === 'refresh') { this.onRefreshCallback?.(); }
      else if (msg.command === 'ready') { this.pushState(); }
    });

    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.html = this.buildShellHtml();
  }

  onNewTrace(cb: () => void) { this.onNewTraceCallback = cb; }
  onDelete(cb: (flagId: string) => void) { this.onDeleteCallback = cb; }
  onExtend(cb: (flagId: string, expirationIso: string, minutes: number) => void) { this.onExtendCallback = cb; }
  onRefresh(cb: () => void) { this.onRefreshCallback = cb; }

  setFlags(flags: TraceFlagInfo[]) {
    this.flags = flags;
    this.pushState();
  }

  setBusy(busy: boolean, message?: string) {
    this.panel?.webview.postMessage({ command: 'busy', busy, message });
  }

  private pushState() {
    this.panel?.webview.postMessage({ command: 'setFlags', flags: this.flags });
  }

  close() { this.panel?.dispose(); }

  private buildShellHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: -apple-system, Segoe UI, sans-serif; padding: 16px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
  .lede { opacity: 0.7; font-size: 12px; max-width: 720px; line-height: 1.5; margin-bottom: 16px; }
  .actions { display: flex; gap: 8px; margin: 12px 0; align-items: center; flex-wrap: wrap; }
  .actions .grow { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: var(--vscode-editorWidget-background); color: var(--vscode-foreground); }
  button.danger { background: transparent; color: #ef4444; padding: 4px 8px; }
  button.danger:hover { background: rgba(239, 68, 68, 0.15); }
  button.mini { padding: 3px 8px; font-size: 11px; }
  .status-line { font-size: 11px; opacity: 0.7; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
  th { background: var(--vscode-editorWidget-background); font-weight: 600; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; opacity: 0.8; }
  .empty { padding: 32px; text-align: center; opacity: 0.6; font-size: 12px; }
  .badge-time { font-family: var(--vscode-editor-font-family); font-size: 11px; padding: 2px 6px; border-radius: 3px; background: var(--vscode-editorWidget-background); }
  .badge-time.warn { color: #f59e0b; }
  .badge-time.expiring { color: #ef4444; }
  code { font-family: var(--vscode-editor-font-family); font-size: 11px; opacity: 0.85; }
  .row-actions { display: flex; gap: 4px; }
  .spinner { display: inline-block; width: 10px; height: 10px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body>
  <h1>🎯 Trace Flag Manager</h1>
  <p class="lede">
    Capture debug logs for any user in the org. Logs are generated naturally as the traced user
    uses the system — no need to run anything yourself. Watch the <strong>Live Apex Log Stream</strong>
    panel to see them appear in real time.
  </p>
  <div class="actions">
    <button id="btn-new">+ Trace another user</button>
    <button id="btn-refresh" class="secondary">↻ Refresh</button>
    <span class="grow"></span>
    <span class="status-line" id="status-line"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>User</th>
        <th>Debug Level</th>
        <th>Expires</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="flag-rows"></tbody>
  </table>
  <div id="empty-state" class="empty" style="display:none">
    No active trace flags. Click <strong>+ Trace another user</strong> to start capturing logs.
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const tbody = document.getElementById('flag-rows');
    const emptyState = document.getElementById('empty-state');
    const statusLine = document.getElementById('status-line');
    let flags = [];
    let isBusy = false;

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function timeRemaining(isoStr) {
      const ms = new Date(isoStr).getTime() - Date.now();
      if (ms <= 0) { return { text: 'expired', cls: 'expiring' }; }
      const mins = Math.floor(ms / 60000);
      if (mins < 60) {
        return { text: mins + 'm left', cls: mins < 10 ? 'expiring' : (mins < 30 ? 'warn' : '') };
      }
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      return { text: hours + 'h ' + remMins + 'm left', cls: hours < 1 ? 'warn' : '' };
    }

    function buildRow(f) {
      const t = timeRemaining(f.ExpirationDate);
      return '<tr>' +
        '<td>' +
          '<strong>' + esc(f.userName || 'Unknown user') + '</strong>' +
          (f.userUsername ? '<br><code>' + esc(f.userUsername) + '</code>' : '') +
        '</td>' +
        '<td>' + esc(f.debugLevelName || '-') + '</td>' +
        '<td><span class="badge-time ' + t.cls + '" data-iso="' + esc(f.ExpirationDate) + '">' + t.text + '</span></td>' +
        '<td><div class="row-actions">' +
          '<button class="mini secondary" data-action="extend" data-id="' + esc(f.Id) + '" data-iso="' + esc(f.ExpirationDate) + '" data-mins="60">+1h</button>' +
          '<button class="mini secondary" data-action="extend" data-id="' + esc(f.Id) + '" data-iso="' + esc(f.ExpirationDate) + '" data-mins="240">+4h</button>' +
          '<button class="mini danger" data-action="delete" data-id="' + esc(f.Id) + '" title="Delete trace flag">✕</button>' +
        '</div></td>' +
      '</tr>';
    }

    function render() {
      tbody.innerHTML = flags.map(buildRow).join('');
      emptyState.style.display = flags.length === 0 ? 'block' : 'none';
    }

    // Tick every 30s to update "expires in" labels without a server round-trip
    setInterval(() => {
      tbody.querySelectorAll('.badge-time').forEach(el => {
        const iso = el.dataset.iso;
        if (!iso) return;
        const t = timeRemaining(iso);
        el.textContent = t.text;
        el.className = 'badge-time ' + t.cls;
      });
    }, 30_000);

    document.getElementById('btn-new').addEventListener('click', () => {
      vscode.postMessage({ command: 'newTrace' });
    });
    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    tbody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn || isBusy) return;
      const action = btn.dataset.action;
      if (action === 'delete') {
        vscode.postMessage({ command: 'delete', flagId: btn.dataset.id });
      } else if (action === 'extend') {
        vscode.postMessage({
          command: 'extend',
          flagId: btn.dataset.id,
          expirationIso: btn.dataset.iso,
          minutes: parseInt(btn.dataset.mins, 10),
        });
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'setFlags') {
        flags = msg.flags || [];
        render();
      } else if (msg.command === 'busy') {
        isBusy = !!msg.busy;
        statusLine.innerHTML = msg.busy
          ? '<span class="spinner"></span>' + esc(msg.message || 'Working…')
          : '';
        document.getElementById('btn-new').disabled = isBusy;
        document.getElementById('btn-refresh').disabled = isBusy;
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body></html>`;
  }
}