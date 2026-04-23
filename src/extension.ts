import * as vscode from 'vscode';
import { ApexLogParser } from './parser';
import { ApexLogAnalyzer, Analysis } from './analyzer';
import { SalesforceService, ApexLogRecord } from './salesforceService';
import { AiService } from './aiService';
import { renderAnalysisHtml } from './webview';
import { StreamingService } from './streamingService';
import { StreamView } from './streamView';
import { ApexClassResolver } from './apexClassResolver';
import { CompareService } from './compareService';
import { renderComparisonHtml, buildComparisonMarkdown } from './compareView';

let currentPanel: vscode.WebviewPanel | undefined;
let currentAnalysis: Analysis | undefined;
let currentLogUri: vscode.Uri | undefined;

export function activate(context: vscode.ExtensionContext) {
  const parser = new ApexLogParser();
  const analyzer = new ApexLogAnalyzer();
  const sf = new SalesforceService();
  const ai = new AiService(context.secrets);
  const classResolver = new ApexClassResolver();
  const compareService = new CompareService();
  const streaming = new StreamingService(sf);
  const streamView = new StreamView();

  // Status bar indicator
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(record) Stream Apex Logs';
  statusBarItem.tooltip = 'Click to start streaming Apex logs from Salesforce';
  statusBarItem.command = 'apexLogAnalyzer.startStream';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  streaming.onStatus((running, message) => {
    if (running) {
      statusBarItem.text = `$(record) ${message || 'Streaming'}`;
      statusBarItem.tooltip = 'Click to stop streaming';
      statusBarItem.command = 'apexLogAnalyzer.stopStream';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusBarItem.text = '$(record) Stream Apex Logs';
      statusBarItem.tooltip = 'Click to start streaming Apex logs from Salesforce';
      statusBarItem.command = 'apexLogAnalyzer.startStream';
      statusBarItem.backgroundColor = undefined;
    }
    streamView.setStatus(running, message);
  });

  streaming.onLog((event) => {
    streamView.addLog(event.log);
  });

  streamView.onPicked(async (logId) => {
    try {
      const filePath = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading log ${logId}…` },
        async () => sf.downloadLog(logId)
      );
      const uri = vscode.Uri.file(filePath);

      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined;
          if (input?.uri?.fsPath === uri.fsPath) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }

      const fs = await import('fs');
      const freshText = fs.readFileSync(filePath, 'utf8');
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false
      });
      await analyzeText(context, freshText, uri, parser, analyzer, ai, sf, classResolver);

      sf.fetchUserForLogId(logId).then((user) => {
        if (!user || !currentAnalysis || !currentPanel) { return; }
        currentAnalysis.userInfo = {
          Name: user.Name, Username: user.Username,
          Email: user.Email, ProfileName: user.Profile?.Name
        };
        currentPanel.webview.html = renderAnalysisHtml(currentAnalysis);
      }).catch(() => { /* silent */ });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to open log: ${e.message}`);
    }
  });

  streamView.onStopRequested(() => {
    streaming.stop();
  });

  context.subscriptions.push({ dispose: () => streaming.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('apexLogAnalyzer.setApiKey', () => ai.setApiKey()),
    vscode.commands.registerCommand('apexLogAnalyzer.clearApiKey', () => ai.clearApiKey())
  );

  const analyzeCmd = vscode.commands.registerCommand('apexLogAnalyzer.analyze', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showErrorMessage('Open a file with Apex log content first.'); return; }
    const text = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
    if (!text.trim()) { vscode.window.showErrorMessage('The file (or selection) is empty.'); return; }

    await analyzeText(context, text, editor.document.uri, parser, analyzer, ai, sf, classResolver);
  });

  const fetchLogCmd = vscode.commands.registerCommand('apexLogAnalyzer.fetchLog', async () => {
    try {
      const logs = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching logs from Salesforce…' },
        async () => sf.listRecentLogs(20)
      );

      if (!logs.length) {
        vscode.window.showWarningMessage('No Apex logs found in the default org.');
        return;
      }

      const picked = await showLogPicker(logs);
      if (!picked) { return; }

      const filePath = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading log ${picked.Id}…` },
        async () => sf.downloadLog(picked.Id)
      );

      const uri = vscode.Uri.file(filePath);

      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined;
          if (input?.uri?.fsPath === uri.fsPath) {
            await vscode.window.tabGroups.close(tab);
          }
        }
      }

      const fs = await import('fs');
      const freshText = fs.readFileSync(filePath, 'utf8');

      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false
      });

      await analyzeText(context, freshText, uri, parser, analyzer, ai, sf, classResolver);

      sf.fetchUserForLogId(picked.Id).then((user) => {
        if (!user || !currentAnalysis || !currentPanel) { return; }
        currentAnalysis.userInfo = {
          Name: user.Name,
          Username: user.Username,
          Email: user.Email,
          ProfileName: user.Profile?.Name
        };
        currentPanel.webview.html = renderAnalysisHtml(currentAnalysis);
      }).catch(() => { /* silent */ });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Fetch failed: ${e.message}`);
    }
  });

  const exportCmd = vscode.commands.registerCommand('apexLogAnalyzer.exportMarkdown', async () => {
    if (!currentAnalysis) {
      vscode.window.showWarningMessage('No analysis to export. Analyse a log first.');
      return;
    }
    const md = buildMarkdownReport(currentAnalysis, '');
    await vscode.env.clipboard.writeText(md);
    vscode.window.showInformationMessage('Analysis copied to clipboard as Markdown.');
  });

  const startStreamCmd = vscode.commands.registerCommand('apexLogAnalyzer.startStream', async () => {
    streamView.show(context);
    await streaming.start();
  });

  const stopStreamCmd = vscode.commands.registerCommand('apexLogAnalyzer.stopStream', () => {
    streaming.stop();
    vscode.window.showInformationMessage('Log streaming stopped.');
  });

  const compareCmd = vscode.commands.registerCommand('apexLogAnalyzer.compareLogs', async () => {
    await runCompareFlow(parser, analyzer, compareService);
  });

  context.subscriptions.push(analyzeCmd, fetchLogCmd, exportCmd, startStreamCmd, stopStreamCmd, compareCmd);
}

async function showLogPicker(logs: ApexLogRecord[]): Promise<ApexLogRecord | undefined> {
  const items = logs.map((log) => ({
    label: `$(file-code) ${log.Operation || 'Anonymous'}`,
    description: `${log.DurationMilliseconds}ms · ${log.Status}`,
    detail: `${log.Id} · ${log.LogUser?.Name ?? 'Unknown'} · ${new Date(log.StartTime).toLocaleString()} · ${(log.LogLength / 1024).toFixed(1)} KB`,
    log
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select an Apex log',
    matchOnDescription: true,
    matchOnDetail: true
  });
  return picked?.log;
}

async function analyzeText(
  context: vscode.ExtensionContext,
  text: string,
  uri: vscode.Uri,
  parser: ApexLogParser,
  analyzer: ApexLogAnalyzer,
  ai: AiService,
  sf: SalesforceService,
  classResolver: ApexClassResolver
) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Analysing Apex log…' },
    async () => {
      const parsed = parser.parse(text);
      const analysis = analyzer.analyze(parsed);

      if (currentPanel && currentLogUri?.fsPath !== uri.fsPath) {
        currentPanel.dispose();
      }

      currentAnalysis = analysis;
      currentLogUri = uri;
      openAnalysisPanel(context, analysis, ai, sf, classResolver);
    }
  );
}

function openAnalysisPanel(
  context: vscode.ExtensionContext,
  analysis: Analysis,
  ai: AiService,
  sf: SalesforceService,
  classResolver: ApexClassResolver
) {
  if (currentPanel) {
    currentPanel.webview.html = renderAnalysisHtml(analysis);
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'apexLogAnalysis',
    'Apex Log Analyzer by Aman',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  currentPanel = panel;
  panel.webview.html = renderAnalysisHtml(analysis);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'explainAll') {
      if (!currentAnalysis) { return; }
      await ai.streamExplanation(
        currentAnalysis,
        undefined,
        (chunk) => panel.webview.postMessage({ command: 'aiChunk', text: chunk }),
        () => panel.webview.postMessage({ command: 'aiDone' }),
        (err) => panel.webview.postMessage({ command: 'aiError', error: err })
      );
    } else if (msg.command === 'explainIssue') {
      if (!currentAnalysis) { return; }
      const issue = currentAnalysis.issues[msg.index];
      if (!issue) { return; }
      await ai.streamExplanation(
        currentAnalysis,
        issue,
        (chunk) => panel.webview.postMessage({ command: 'aiChunk', text: chunk }),
        () => panel.webview.postMessage({ command: 'aiDone' }),
        (err) => panel.webview.postMessage({ command: 'aiError', error: err })
      );
    } else if (msg.command === 'jumpToLine') {
      await jumpToLogLine(msg.line);
    } else if (msg.command === 'openClass') {
      await handleOpenClass(msg.className, msg.line, classResolver, sf);
    } else if (msg.command === 'exportMarkdown') {
      if (!currentAnalysis) { return; }
      const md = buildMarkdownReport(currentAnalysis, msg.aiText || '');
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage('Analysis copied to clipboard as Markdown.');
    }
  });

  panel.onDidDispose(() => {
    currentPanel = undefined;
    currentAnalysis = undefined;
    currentLogUri = undefined;
  });
}

async function handleOpenClass(
  className: string,
  line: number | undefined,
  classResolver: ApexClassResolver,
  sf: SalesforceService
) {
  if (!classResolver.isSfdxProject()) {
    vscode.window.showWarningMessage(
      `Open an SFDX project folder (with sfdx-project.json) to jump to Apex class source files.`
    );
    return;
  }

  const loc = await classResolver.resolve(className);
  if (loc) {
    await classResolver.open(loc, line);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `Class "${className}" not found in your workspace. Retrieve it from Salesforce?`,
    'Retrieve from org',
    'Cancel'
  );
  if (choice !== 'Retrieve from org') { return; }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Retrieving ${className} from Salesforce…` },
      async () => {
        await sf.retrieveClass(className);
        classResolver.clearCache();
      }
    );
    const retrieved = await classResolver.resolve(className);
    if (retrieved) {
      await classResolver.open(retrieved, line);
    } else {
      vscode.window.showWarningMessage(
        `${className} was retrieved but could not be located. It may exist under a different package directory.`
      );
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Retrieve failed: ${e.message}`);
  }
}

async function jumpToLogLine(line: number) {
  if (!currentLogUri) { return; }
  try {
    const doc = await vscode.workspace.openTextDocument(currentLogUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const marker = `|[${line}]|`;
    const text = doc.getText();
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      const pos = doc.positionAt(idx);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(pos, pos);
    } else {
      vscode.window.showInformationMessage(`No [${line}] marker in the log.`);
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Could not jump to line: ${e.message}`);
  }
}

async function runCompareFlow(
  parser: ApexLogParser,
  analyzer: ApexLogAnalyzer,
  compareService: CompareService
) {
  const candidates = await collectLogCandidates();
  if (candidates.length < 2) {
    vscode.window.showWarningMessage(
      'Compare Two Logs needs at least 2 open log files. Open your two logs (paste them into VS Code tabs if needed) and try again.'
    );
    return;
  }

  const baseline = await vscode.window.showQuickPick(
    candidates.map(c => ({
      label: c.label,
      description: c.description,
      detail: c.detail,
      candidate: c
    })),
    { placeHolder: 'Step 1 of 2 — Select the BASELINE log', matchOnDescription: true, matchOnDetail: true }
  );
  if (!baseline) { return; }

  const remaining = candidates.filter(c => c.key !== baseline.candidate.key);
  const comparison = await vscode.window.showQuickPick(
    remaining.map(c => ({
      label: c.label,
      description: c.description,
      detail: c.detail,
      candidate: c
    })),
    { placeHolder: 'Step 2 of 2 — Select the COMPARISON log', matchOnDescription: true, matchOnDetail: true }
  );
  if (!comparison) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Comparing logs…' },
    async () => {
      const baselineText = await baseline.candidate.getText();
      const comparisonText = await comparison.candidate.getText();
      const baselineAnalysis = analyzer.analyze(parser.parse(baselineText));
      const comparisonAnalysis = analyzer.analyze(parser.parse(comparisonText));
      const diff = compareService.compare(
        baselineAnalysis,
        comparisonAnalysis,
        baseline.candidate.label,
        comparison.candidate.label
      );
      showComparisonPanel(diff);
    }
  );
}

interface LogCandidate {
  key: string;
  label: string;
  description: string;
  detail: string;
  getText: () => Promise<string>;
}

async function collectLogCandidates(): Promise<LogCandidate[]> {
  const candidates: LogCandidate[] = [];
  const seen = new Set<string>();
  const isApexLog = (text: string) =>
    /\|EXECUTION_STARTED\b/.test(text) || /^\s*\d+\.\d+\s+APEX_CODE,/m.test(text);

  // All open text documents (saved + untitled)
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isClosed) { continue; }
    const key = doc.uri.toString();
    if (seen.has(key)) { continue; }
    const sample = doc.getText().slice(0, 2048);
    if (!isApexLog(sample)) { continue; }
    seen.add(key);
    const fsPath = doc.uri.fsPath;
    const label = doc.isUntitled ? `$(file) ${doc.uri.path}` : `$(file) ${fsPath.split('/').pop()}`;
    candidates.push({
      key,
      label,
      description: `${(doc.getText().length / 1024).toFixed(1)} KB`,
      detail: doc.isUntitled ? 'Untitled tab' : fsPath,
      getText: async () => doc.getText()
    });
  }

  // Also scan the workspace for .log files (limit 20)
  const files = await vscode.workspace.findFiles('**/*.log', '**/node_modules/**', 20);
  for (const uri of files) {
    const key = uri.toString();
    if (seen.has(key)) { continue; }
    seen.add(key);
    candidates.push({
      key,
      label: `$(file) ${uri.fsPath.split('/').pop()}`,
      description: 'workspace file',
      detail: uri.fsPath,
      getText: async () => {
        const buf = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder('utf8').decode(buf);
      }
    });
  }

  return candidates;
}

function showComparisonPanel(comparison: import('./compareService').Comparison) {
  const panel = vscode.window.createWebviewPanel(
    'apexLogCompare',
    `📊 Compare: ${comparison.summary.baseline.label} vs ${comparison.summary.comparison.label}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = renderComparisonHtml(comparison);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === 'exportCompareMarkdown') {
      const md = buildComparisonMarkdown(comparison);
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage('Comparison copied to clipboard as Markdown.');
    }
  });
}

function buildMarkdownReport(a: Analysis, aiText: string): string {
  const fmt = (n?: number) => (n ?? 0).toFixed(2);
  const lines: string[] = [];
  lines.push(`# Apex Log Analysis`);
  lines.push('');
  lines.push(`*Generated by Apex Log Analyzer by Aman*`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- **API Version:** ${a.summary.apiVersion}`);
  lines.push(`- **Total Duration:** ${fmt(a.summary.totalDurationMs)} ms`);
  lines.push(`- **SOQL Queries:** ${a.soql.length}`);
  lines.push(`- **DML Operations:** ${a.dml.length}`);
  lines.push(`- **Errors:** ${a.issues.filter(i => i.severity === 'fatal' || i.severity === 'error').length}`);
  lines.push(`- **Warnings:** ${a.issues.filter(i => i.severity === 'warning').length}`);
  lines.push(`- **Debug Statements:** ${a.debugs.length}`);
  if (a.userInfo) {
    lines.push(`- **Executed by:** ${a.userInfo.Name} (${a.userInfo.Username}) — ${a.userInfo.ProfileName ?? 'No profile'}`);
  }
  lines.push('');

  if (a.issues.length) {
    lines.push(`## Issues`);
    lines.push('');
    for (const i of a.issues) {
      lines.push(`### [${i.severity.toUpperCase()}] ${i.type}${i.lineNumber ? ` (line ${i.lineNumber})` : ''}`);
      lines.push('');
      lines.push('```');
      lines.push(i.message);
      lines.push('```');
      if (i.context) { lines.push(`> ${i.context}`); }
      lines.push('');
    }
  }

  if (aiText) {
    lines.push(`## AI Root-Cause Analysis`);
    lines.push('');
    lines.push(aiText);
    lines.push('');
  }

  if (a.methods.length) {
    lines.push(`## Slowest Methods`);
    lines.push('');
    lines.push(`| Method | Duration (ms) | Line |`);
    lines.push(`|---|---|---|`);
    for (const m of a.methods.slice(0, 20)) {
      lines.push(`| \`${m.name}\` | ${fmt(m.durationMs)} | ${m.lineNumber ?? '-'} |`);
    }
    lines.push('');
  }

  if (a.soql.length) {
    lines.push(`## SOQL Queries`);
    lines.push('');
    lines.push(`| # | Duration (ms) | Rows | Line | Query |`);
    lines.push(`|---|---|---|---|---|`);
    a.soql.forEach((q, i) => {
      lines.push(`| ${i + 1} | ${fmt(q.durationMs)} | ${q.rows ?? '-'} | ${q.lineNumber ?? '-'} | \`${q.query.replace(/\|/g, '\\|')}\` |`);
    });
    lines.push('');
  }

  if (a.dml.length) {
    lines.push(`## DML Operations`);
    lines.push('');
    lines.push(`| # | Op | Rows | Duration (ms) | Line |`);
    lines.push(`|---|---|---|---|---|`);
    a.dml.forEach((d, i) => {
      lines.push(`| ${i + 1} | ${d.operation} | ${d.rows ?? '-'} | ${fmt(d.durationMs)} | ${d.lineNumber ?? '-'} |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

export function deactivate() {
  currentPanel?.dispose();
}