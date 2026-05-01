import * as vscode from "vscode";
import * as fsPromises from "fs/promises";
import { ApexLogParser } from "./parser";
import { ApexDoctor, Analysis } from "./analyzer";
import { AiService, ChatMessage } from "./aiService";
import { renderAnalysisHtml } from "./webview";
import { StreamingService } from "./streamingService";
import { StreamView } from "./streamView";
import { ApexClassResolver } from "./apexClassResolver";
import { CompareService } from "./compareService";
import { renderComparisonHtml, buildComparisonMarkdown } from "./compareView";
import { TraceFlagView } from "./traceFlagView";
import {
  SalesforceService,
  ApexLogRecord,
  UserSummary,
  DebugLevel,
} from "./salesforceService";
import {
  RecentAnalysesProvider,
  loadHistory,
  saveAnalysisToHistory as saveEntryToWorkspace,
  clearHistory,
  removeEntry,
} from "./recentHistory";
import { detectRecurringPatterns, RecurringPatterns } from "./recurringPatterns";
import { linkAsyncChain, AsyncHistoryEntry, AsyncLink } from "./asyncTracer";
import { RecurringIssuesProvider } from "./recurringIssuesView";
import { suggestFixForIssue, FixDiffContentProvider } from "./fixSuggestions";
import { buildNlQueryPrompt, parseNlQueryResponse, NlQueryResult } from "./nlQuery";
import { CoverageProvider } from "./coverageProvider";
import { showQueryPlan } from "./queryPlanView";
import {
  openAnonymousEditor,
  runAnonymousApex,
  refreshStatusBarVisibility,
  disposeStatusBarItem,
} from "./anonymousApex";

let currentPanel: vscode.WebviewPanel | undefined;
let currentAnalysis: Analysis | undefined;
let currentLogUri: vscode.Uri | undefined;
let currentChat: ChatMessage[] = [];
let diagnosticCollection: vscode.DiagnosticCollection | undefined;
let recentProvider: RecentAnalysesProvider | undefined;
let recurringProvider: RecurringIssuesProvider | undefined;

function buildAsyncHistory(context: vscode.ExtensionContext): AsyncHistoryEntry[] {
  return loadHistory(context).map((h) => ({
    label: h.label,
    savedAt: h.savedAt,
    entryPoint: h.analysis.asyncEntryPoint,
  }));
}

function computeRenderOptions(
  context: vscode.ExtensionContext,
  analysis: Analysis,
): { recurring: RecurringPatterns; asyncLinks: AsyncLink[] } {
  const history = loadHistory(context);
  const recurring = detectRecurringPatterns(history);
  const asyncHistory = buildAsyncHistory(context);
  const asyncLinks = linkAsyncChain(analysis.asyncInvocations, asyncHistory);
  return { recurring, asyncLinks };
}

function saveAnalysisToHistory(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  analysis: Analysis,
): void {
  saveEntryToWorkspace(context, uri, analysis);
  recentProvider?.refresh();
  recurringProvider?.refresh();
}

function severityToDiagnostic(s: Analysis["issues"][number]["severity"]): vscode.DiagnosticSeverity {
  switch (s) {
    case "fatal":
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}

function publishDiagnostics(uri: vscode.Uri, text: string, analysis: Analysis) {
  if (!diagnosticCollection) { return; }
  const enabled = vscode.workspace
    .getConfiguration("apexDoctor")
    .get<boolean>("enableInlineDiagnostics", true);
  if (!enabled) {
    diagnosticCollection.set(uri, []);
    return;
  }
  const lines = text.split(/\r?\n/);
  const apexLineToLogLine = new Map<number, number>();
  const lineRefRegex = /\|\[(\d+)\]\|/;
  for (let i = 0; i < lines.length; i++) {
    const m = lineRefRegex.exec(lines[i]);
    if (m) {
      const apexLine = Number(m[1]);
      if (!apexLineToLogLine.has(apexLine)) {
        apexLineToLogLine.set(apexLine, i);
      }
    }
  }
  const diags: vscode.Diagnostic[] = [];
  for (const issue of analysis.issues) {
    if (!issue.lineNumber) { continue; }
    const logLine = apexLineToLogLine.get(issue.lineNumber);
    if (logLine === undefined) { continue; }
    const lineText = lines[logLine] ?? "";
    const range = new vscode.Range(logLine, 0, logLine, Math.max(0, lineText.length));
    const diag = new vscode.Diagnostic(
      range,
      `[${issue.type}] ${issue.message.split(/\r?\n/)[0]}`,
      severityToDiagnostic(issue.severity),
    );
    diag.source = "Apex Doctor";
    diags.push(diag);
  }
  diagnosticCollection.set(uri, diags);
}

function isApexLogText(text: string): boolean {
  const sample = text.slice(0, 4096);
  return (
    /\|EXECUTION_STARTED\b/.test(sample) ||
    /^\s*\d+\.\d+\s+APEX_CODE,/m.test(sample) ||
    /^\d{2}:\d{2}:\d{2}\.\d+\s*\(\d+\)\|/m.test(sample)
  );
}

export function activate(context: vscode.ExtensionContext) {
  const parser = new ApexLogParser();
  const analyzer = new ApexDoctor();
  diagnosticCollection = vscode.languages.createDiagnosticCollection("apexDoctor");
  context.subscriptions.push(diagnosticCollection);
  recentProvider = new RecentAnalysesProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "apexDoctor.recent",
      recentProvider,
    ),
  );
  recurringProvider = new RecurringIssuesProvider(context);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      "apexDoctor.recurring",
      recurringProvider,
    ),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "apexdoctor-fix",
      new FixDiffContentProvider(),
    ),
  );
  const sf = new SalesforceService();
  const ai = new AiService(context.secrets);
  const classResolver = new ApexClassResolver();
  const compareService = new CompareService();
  const streaming = new StreamingService(sf);
  const streamView = new StreamView();
  const traceFlagView = new TraceFlagView();
  const coverageProvider = new CoverageProvider(context, sf);
  context.subscriptions.push({ dispose: () => coverageProvider.dispose() });

  const refreshTraceFlags = async () => {
    try {
      traceFlagView.setBusy(true, "Loading trace flags…");
      const flags = await sf.listActiveTraceFlags();
      traceFlagView.setFlags(flags);
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Could not load trace flags: ${e.message}`,
      );
    } finally {
      traceFlagView.setBusy(false);
    }
  };

  traceFlagView.onRefresh(refreshTraceFlags);

  traceFlagView.onNewTrace(async () => {
    try {
      const user = await pickUser(sf);
      if (!user) {
        return;
      }
      const minutes = await pickDuration();
      if (!minutes) {
        return;
      }
      const debugLevel = await pickDebugLevel(sf);
      if (!debugLevel) {
        return;
      }
      traceFlagView.setBusy(true, `Creating trace flag for ${user.Name}…`);
      try {
        await sf.createTraceFlag(user.Id, debugLevel.Id, minutes);
        vscode.window.showInformationMessage(
          `Now tracing ${user.Name} for ${formatMinutes(minutes)}. Watch the Live Stream for their logs.`,
        );
      } catch (e: any) {
        const msg = String(e.message || e);
        // Detect duplicate-trace error and offer to extend the existing one
        if (/DUPLICATE_VALUE|already.*active/i.test(msg)) {
          const choice = await vscode.window.showWarningMessage(
            `${user.Name} already has an active trace flag. Extend it by 1 hour instead?`,
            "Extend by 1h",
            "Cancel",
          );
          if (choice === "Extend by 1h") {
            const flags = await sf.listActiveTraceFlags();
            const existing = flags.find((f) => f.TracedEntityId === user.Id);
            if (existing) {
              await sf.extendTraceFlag(
                existing.Id,
                existing.ExpirationDate,
                60,
              );
              vscode.window.showInformationMessage(
                `Extended trace for ${user.Name} by 1 hour.`,
              );
            }
          }
        } else {
          vscode.window.showErrorMessage(`Trace flag creation failed: ${msg}`);
        }
      }
    } finally {
      traceFlagView.setBusy(false);
      refreshTraceFlags();
    }
  });

  traceFlagView.onDelete(async (flagId) => {
    const choice = await vscode.window.showWarningMessage(
      "Delete this trace flag? Logs will stop being captured for this user.",
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") {
      return;
    }
    traceFlagView.setBusy(true, "Deleting…");
    try {
      await sf.deleteTraceFlag(flagId);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Delete failed: ${e.message}`);
    } finally {
      traceFlagView.setBusy(false);
      refreshTraceFlags();
    }
  });

  traceFlagView.onExtend(async (flagId, expirationIso, minutes) => {
    traceFlagView.setBusy(true, `Extending by ${formatMinutes(minutes)}…`);
    try {
      const result = await sf.extendTraceFlag(flagId, expirationIso, minutes);
      const newDate = new Date(result.newExpirationIso);
      const proposed = new Date(expirationIso).getTime() + minutes * 60_000;
      if (newDate.getTime() < proposed) {
        vscode.window.showInformationMessage(
          `Capped at the 24-hour Salesforce limit. New expiration: ${newDate.toLocaleString()}.`,
        );
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Extend failed: ${e.message}`);
    } finally {
      traceFlagView.setBusy(false);
      refreshTraceFlags();
    }
  });

  const traceFlagsCmd = vscode.commands.registerCommand(
    "apexDoctor.manageTraceFlags",
    () => {
      traceFlagView.show(context);
      refreshTraceFlags();
    },
  );

  // Status bar indicator
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(record) Stream Apex Logs";
  statusBarItem.tooltip = "Click to start streaming Apex logs from Salesforce";
  statusBarItem.command = "apexDoctor.startStream";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  streaming.onStatus((running, message) => {
    if (running) {
      statusBarItem.text = `$(record) ${message || "Streaming"}`;
      statusBarItem.tooltip = "Click to stop streaming";
      statusBarItem.command = "apexDoctor.stopStream";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      statusBarItem.text = "$(record) Stream Apex Logs";
      statusBarItem.tooltip =
        "Click to start streaming Apex logs from Salesforce";
      statusBarItem.command = "apexDoctor.startStream";
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
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading log ${logId}…`,
        },
        async () => sf.downloadLog(logId),
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

      const freshText = await fsPromises.readFile(filePath, "utf8");
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: false,
      });
      await analyzeText(
        context,
        freshText,
        uri,
        parser,
        analyzer,
        ai,
        sf,
        classResolver,
      );

      sf.fetchUserForLogId(logId)
        .then((user) => {
          if (!user || !currentAnalysis || !currentPanel) {
            return;
          }
          currentAnalysis.userInfo = {
            Name: user.Name,
            Username: user.Username,
            Email: user.Email,
            ProfileName: user.Profile?.Name,
          };
          currentPanel.webview.html = renderAnalysisHtml(
            currentAnalysis,
            computeRenderOptions(context, currentAnalysis),
          );
        })
        .catch(() => {
          /* silent */
        });
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to open log: ${e.message}`);
    }
  });

  streamView.onStartRequested(() => {
    vscode.commands.executeCommand("apexDoctor.startStream");
  });
  streamView.onStopRequested(() => {
    vscode.commands.executeCommand("apexDoctor.stopStream");
  });
  streamView.onTraceUser(() => {
    vscode.commands.executeCommand("apexDoctor.manageTraceFlags");
  });

  context.subscriptions.push({ dispose: () => streaming.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand("apexDoctor.setApiKey", () =>
      ai.setApiKey(),
    ),
    vscode.commands.registerCommand("apexDoctor.clearApiKey", () =>
      ai.clearApiKey(),
    ),
  );

  const analyzeCmd = vscode.commands.registerCommand(
    "apexDoctor.analyze",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "Open a file with Apex log content first.",
        );
        return;
      }
      const text = editor.document.getText(
        editor.selection.isEmpty ? undefined : editor.selection,
      );
      if (!text.trim()) {
        vscode.window.showErrorMessage("The file (or selection) is empty.");
        return;
      }
      if (!isApexLogText(text)) {
        const choice = await vscode.window.showWarningMessage(
          "This doesn't look like a Salesforce Apex debug log. Continue anyway?",
          "Analyse anyway",
          "Cancel",
        );
        if (choice !== "Analyse anyway") {
          return;
        }
      }

      await analyzeText(
        context,
        text,
        editor.document.uri,
        parser,
        analyzer,
        ai,
        sf,
        classResolver,
      );
    },
  );

  const fetchLogCmd = vscode.commands.registerCommand(
    "apexDoctor.fetchLog",
    async () => {
      try {
        const logs = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Fetching logs from Salesforce…",
          },
          async () => sf.listRecentLogs(20),
        );

        if (!logs.length) {
          vscode.window.showWarningMessage(
            "No Apex logs found in the default org.",
          );
          return;
        }

        const picked = await showLogPicker(logs);
        if (!picked) {
          return;
        }

        const filePath = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Downloading log ${picked.Id}…`,
          },
          async () => sf.downloadLog(picked.Id),
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

        const freshText = await fsPromises.readFile(filePath, "utf8");

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.One,
          preview: false,
          preserveFocus: false,
        });

        await analyzeText(
          context,
          freshText,
          uri,
          parser,
          analyzer,
          ai,
          sf,
          classResolver,
        );

        sf.fetchUserForLogId(picked.Id)
          .then((user) => {
            if (!user || !currentAnalysis || !currentPanel) {
              return;
            }
            currentAnalysis.userInfo = {
              Name: user.Name,
              Username: user.Username,
              Email: user.Email,
              ProfileName: user.Profile?.Name,
            };
            currentPanel.webview.html = renderAnalysisHtml(
            currentAnalysis,
            computeRenderOptions(context, currentAnalysis),
          );
          })
          .catch(() => {
            /* silent */
          });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Fetch failed: ${e.message}`);
      }
    },
  );

  const exportCmd = vscode.commands.registerCommand(
    "apexDoctor.exportMarkdown",
    async () => {
      if (!currentAnalysis) {
        vscode.window.showWarningMessage(
          "No analysis to export. Analyse a log first.",
        );
        return;
      }
      const md = buildMarkdownReport(currentAnalysis, "");
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage(
        "Analysis copied to clipboard as Markdown.",
      );
    },
  );

  const startStreamCmd = vscode.commands.registerCommand(
    "apexDoctor.startStream",
    async () => {
      streamView.show(context);
      await streaming.start();
    },
  );

  const stopStreamCmd = vscode.commands.registerCommand(
    "apexDoctor.stopStream",
    () => {
      streaming.stop();
      vscode.window.showInformationMessage("Log streaming stopped.");
    },
  );

  const compareCmd = vscode.commands.registerCommand(
    "apexDoctor.compareLogs",
    async () => {
      await runCompareFlow(parser, analyzer, compareService);
    },
  );

  const openRecentCmd = vscode.commands.registerCommand(
    "apexDoctor.openRecent",
    async (id: string) => {
      const entry = loadHistory(context).find((e) => e.id === id);
      if (!entry) {
        vscode.window.showWarningMessage(
          "That recent analysis is no longer available.",
        );
        recentProvider?.refresh();
        return;
      }
      currentAnalysis = entry.analysis;
      currentChat = [];
      try {
        currentLogUri = vscode.Uri.file(entry.source);
      } catch {
        currentLogUri = undefined;
      }
      openAnalysisPanel(context, entry.analysis, ai, sf, classResolver);
    },
  );

  const clearRecentCmd = vscode.commands.registerCommand(
    "apexDoctor.clearRecent",
    () => {
      clearHistory(context);
      recentProvider?.refresh();
      vscode.window.showInformationMessage("Recent analyses cleared.");
    },
  );

  const removeRecentCmd = vscode.commands.registerCommand(
    "apexDoctor.removeRecent",
    (item: { id?: string } | undefined) => {
      const id = item?.id;
      if (!id) { return; }
      removeEntry(context, id);
      recentProvider?.refresh();
    },
  );

  const refreshCoverageCmd = vscode.commands.registerCommand(
    "apexDoctor.refreshCoverage",
    async () => {
      try {
        await coverageProvider.refresh();
      } catch (e: any) {
        vscode.window.showErrorMessage(`Coverage refresh failed: ${e.message}`);
      }
    },
  );

  const toggleCoverageCmd = vscode.commands.registerCommand(
    "apexDoctor.toggleCoverage",
    () => coverageProvider.toggle(),
  );

  const queryPlanCmd = vscode.commands.registerCommand(
    "apexDoctor.queryPlan",
    async (queryArg?: string) => {
      const query = queryArg ?? (await vscode.window.showInputBox({
        prompt: "Paste a SOQL query to run through the Query Plan tool",
        placeHolder: "SELECT Id FROM Account WHERE Industry = 'Tech'",
      }));
      if (!query) { return; }
      await showQueryPlan(query, sf);
    },
  );

  const openAnonymousEditorCmd = vscode.commands.registerCommand(
    "apexDoctor.openAnonymousEditor",
    async () => {
      await openAnonymousEditor();
    },
  );

  const runAnonymousApexCmd = vscode.commands.registerCommand(
    "apexDoctor.runAnonymousApex",
    async () => {
      try {
        await runAnonymousApex(sf, async (logFilePath: string) => {
          const uri = vscode.Uri.file(logFilePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
          });
          await analyzeText(
            context,
            doc.getText(),
            uri,
            parser,
            analyzer,
            ai,
            sf,
            classResolver,
          );
        });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Run failed: ${e.message}`);
      }
    },
  );

  // Show/hide the "Run with Apex Doctor" status-bar item based on the active editor
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatusBarVisibility()),
    { dispose: () => disposeStatusBarItem() },
  );
  refreshStatusBarVisibility();

  context.subscriptions.push(
    analyzeCmd,
    fetchLogCmd,
    exportCmd,
    startStreamCmd,
    stopStreamCmd,
    compareCmd,
    openRecentCmd,
    clearRecentCmd,
    removeRecentCmd,
    traceFlagsCmd,
    refreshCoverageCmd,
    toggleCoverageCmd,
    queryPlanCmd,
    openAnonymousEditorCmd,
    runAnonymousApexCmd,
  );
}

async function showLogPicker(
  logs: ApexLogRecord[],
): Promise<ApexLogRecord | undefined> {
  const items = logs.map((log) => ({
    label: `$(file-code) ${log.Operation || "Anonymous"}`,
    description: `${log.DurationMilliseconds}ms · ${log.Status}`,
    detail: `${log.Id} · ${log.LogUser?.Name ?? "Unknown"} · ${new Date(log.StartTime).toLocaleString()} · ${(log.LogLength / 1024).toFixed(1)} KB`,
    log,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select an Apex log",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.log;
}

async function analyzeText(
  context: vscode.ExtensionContext,
  text: string,
  uri: vscode.Uri,
  parser: ApexLogParser,
  analyzer: ApexDoctor,
  ai: AiService,
  sf: SalesforceService,
  classResolver: ApexClassResolver,
) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Analysing Apex log…",
    },
    async () => {
      const parsed = parser.parse(text);
      const analysis = analyzer.analyze(parsed);

      if (currentPanel && currentLogUri?.fsPath !== uri.fsPath) {
        currentPanel.dispose();
      }

      currentAnalysis = analysis;
      currentLogUri = uri;
      currentChat = [];
      publishDiagnostics(uri, text, analysis);
      saveAnalysisToHistory(context, uri, analysis);
      openAnalysisPanel(context, analysis, ai, sf, classResolver);
    },
  );
}

function openAnalysisPanel(
  context: vscode.ExtensionContext,
  analysis: Analysis,
  ai: AiService,
  sf: SalesforceService,
  classResolver: ApexClassResolver,
) {
  if (currentPanel) {
    currentPanel.webview.html = renderAnalysisHtml(
      analysis,
      computeRenderOptions(context, analysis),
    );
    currentPanel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "apexLogAnalysis",
    "Apex Doctor",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
    },
  );
  currentPanel = panel;
  panel.webview.html = renderAnalysisHtml(
    analysis,
    computeRenderOptions(context, analysis),
  );

  const startInitialExplanation = async (focusIssue?: import("./analyzer").Issue) => {
    if (!currentAnalysis) { return; }
    const userPrompt = ai.buildInitialUserPrompt(currentAnalysis, focusIssue);
    currentChat = [{ role: "user", content: userPrompt }];
    let assistantText = "";
    await ai.streamChat(
      currentAnalysis,
      currentChat,
      (chunk) => {
        assistantText += chunk;
        panel.webview.postMessage({ command: "aiChunk", text: chunk });
      },
      () => {
        currentChat.push({ role: "assistant", content: assistantText });
        panel.webview.postMessage({ command: "aiDone" });
      },
      (err) => panel.webview.postMessage({ command: "aiError", error: err }),
    );
  };

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === "explainAll") {
      await startInitialExplanation(undefined);
    } else if (msg.command === "explainIssue") {
      if (!currentAnalysis) { return; }
      const issue = currentAnalysis.issues[msg.index];
      if (!issue) { return; }
      await startInitialExplanation(issue);
    } else if (msg.command === "chatTurn") {
      if (!currentAnalysis) { return; }
      const userMessage: string = (msg.text || "").trim();
      if (!userMessage) { return; }
      if (!currentChat.length) {
        currentChat = [{ role: "user", content: ai.buildInitialUserPrompt(currentAnalysis) }];
      }
      currentChat.push({ role: "user", content: userMessage });
      panel.webview.postMessage({ command: "chatUserEcho", text: userMessage });
      let assistantText = "";
      await ai.streamChat(
        currentAnalysis,
        currentChat,
        (chunk) => {
          assistantText += chunk;
          panel.webview.postMessage({ command: "aiChunk", text: chunk });
        },
        () => {
          currentChat.push({ role: "assistant", content: assistantText });
          panel.webview.postMessage({ command: "aiDone" });
        },
        (err) => panel.webview.postMessage({ command: "aiError", error: err }),
      );
    } else if (msg.command === "jumpToLine") {
      await jumpToLogLine(msg.line);
    } else if (msg.command === "openClass") {
      await handleOpenClass(msg.className, msg.line, classResolver, sf);
    } else if (msg.command === "exportMarkdown") {
      if (!currentAnalysis) { return; }
      const md = buildMarkdownReport(currentAnalysis, msg.aiText || "");
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage(
        "Analysis copied to clipboard as Markdown.",
      );
    } else if (msg.command === "suggestFix") {
      if (!currentAnalysis) { return; }
      const issue = currentAnalysis.issues[msg.index];
      if (!issue) { return; }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Generating fix…" },
        async () => {
          await suggestFixForIssue(issue, msg.classNameHint, ai, classResolver);
        },
      );
    } else if (msg.command === "queryPlan") {
      const query: string = (msg.query || "").trim();
      if (!query) { return; }
      await showQueryPlan(query, sf);
    } else if (msg.command === "askLog") {
      if (!currentAnalysis) { return; }
      const question: string = (msg.text || "").trim();
      if (!question) { return; }
      panel.webview.postMessage({ command: "askLogPending" });
      try {
        const prompt = buildNlQueryPrompt(currentAnalysis, question);
        const raw = await ai.completeOnce(prompt, { maxTokens: 800 });
        if (!raw) {
          panel.webview.postMessage({
            command: "askLogResult",
            error: "No response from the AI provider. Check your API key.",
          });
          return;
        }
        let result: NlQueryResult;
        try {
          result = parseNlQueryResponse(currentAnalysis, raw);
        } catch (e: any) {
          panel.webview.postMessage({
            command: "askLogResult",
            error: `Couldn't parse the AI response: ${e.message}`,
            raw: raw.slice(0, 400),
          });
          return;
        }
        panel.webview.postMessage({
          command: "askLogResult",
          result,
        });
      } catch (e: any) {
        panel.webview.postMessage({
          command: "askLogResult",
          error: e.message || "Unknown error.",
        });
      }
    }
  });

  panel.onDidDispose(() => {
    currentPanel = undefined;
    currentAnalysis = undefined;
    currentLogUri = undefined;
    currentChat = [];
  });
}

async function handleOpenClass(
  className: string,
  line: number | undefined,
  classResolver: ApexClassResolver,
  sf: SalesforceService,
) {
  if (!classResolver.isSfdxProject()) {
    vscode.window.showWarningMessage(
      `Open an SFDX project folder (with sfdx-project.json) to jump to Apex class source files.`,
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
    "Retrieve from org",
    "Cancel",
  );
  if (choice !== "Retrieve from org") {
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Retrieving ${className} from Salesforce…`,
      },
      async () => {
        await sf.retrieveClass(className);
        classResolver.clearCache();
      },
    );
    const retrieved = await classResolver.resolve(className);
    if (retrieved) {
      await classResolver.open(retrieved, line);
    } else {
      vscode.window.showWarningMessage(
        `${className} was retrieved but could not be located. It may exist under a different package directory.`,
      );
    }
  } catch (e: any) {
    vscode.window.showErrorMessage(`Retrieve failed: ${e.message}`);
  }
}

async function jumpToLogLine(line: number) {
  if (!currentLogUri) {
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(currentLogUri);
    const editor = await vscode.window.showTextDocument(
      doc,
      vscode.ViewColumn.One,
    );
    const marker = `|[${line}]|`;
    const text = doc.getText();
    const idx = text.indexOf(marker);
    if (idx >= 0) {
      const pos = doc.positionAt(idx);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter,
      );
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
  analyzer: ApexDoctor,
  compareService: CompareService,
) {
  const candidates = await collectLogCandidates();
  if (candidates.length < 2) {
    vscode.window.showWarningMessage(
      "Compare Two Logs needs at least 2 open log files. Open your two logs (paste them into VS Code tabs if needed) and try again.",
    );
    return;
  }

  const baseline = await vscode.window.showQuickPick(
    candidates.map((c) => ({
      label: c.label,
      description: c.description,
      detail: c.detail,
      candidate: c,
    })),
    {
      placeHolder: "Step 1 of 2 — Select the BASELINE log",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!baseline) {
    return;
  }

  const remaining = candidates.filter((c) => c.key !== baseline.candidate.key);
  const comparison = await vscode.window.showQuickPick(
    remaining.map((c) => ({
      label: c.label,
      description: c.description,
      detail: c.detail,
      candidate: c,
    })),
    {
      placeHolder: "Step 2 of 2 — Select the COMPARISON log",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!comparison) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Comparing logs…",
    },
    async () => {
      const baselineText = await baseline.candidate.getText();
      const comparisonText = await comparison.candidate.getText();
      const baselineParsed = parser.parse(baselineText);
      const comparisonParsed = parser.parse(comparisonText);
      const baselineAnalysis = analyzer.analyze(baselineParsed);
      const comparisonAnalysis = analyzer.analyze(comparisonParsed);
      const diff = compareService.compare(
        baselineAnalysis,
        comparisonAnalysis,
        baseline.candidate.label,
        comparison.candidate.label,
        { baseline: baselineParsed, comparison: comparisonParsed },
      );
      showComparisonPanel(diff);
    },
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
    /\|EXECUTION_STARTED\b/.test(text) ||
    /^\s*\d+\.\d+\s+APEX_CODE,/m.test(text);

  // All open text documents (saved + untitled)
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isClosed) {
      continue;
    }
    const key = doc.uri.toString();
    if (seen.has(key)) {
      continue;
    }
    const sample = doc.getText().slice(0, 2048);
    if (!isApexLog(sample)) {
      continue;
    }
    seen.add(key);
    const fsPath = doc.uri.fsPath;
    const label = doc.isUntitled
      ? `$(file) ${doc.uri.path}`
      : `$(file) ${fsPath.split("/").pop()}`;
    candidates.push({
      key,
      label,
      description: `${(Buffer.byteLength(doc.getText(), "utf8") / 1024).toFixed(1)} KB`,
      detail: doc.isUntitled ? "Untitled tab" : fsPath,
      getText: async () => doc.getText(),
    });
  }

  // Also scan the workspace for .log files (limit 20)
  const files = await vscode.workspace.findFiles(
    "**/*.log",
    "**/node_modules/**",
    20,
  );
  for (const uri of files) {
    const key = uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({
      key,
      label: `$(file) ${uri.fsPath.split("/").pop()}`,
      description: "workspace file",
      detail: uri.fsPath,
      getText: async () => {
        const buf = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder("utf8").decode(buf);
      },
    });
  }

  return candidates;
}

function showComparisonPanel(
  comparison: import("./compareService").Comparison,
) {
  const panel = vscode.window.createWebviewPanel(
    "apexLogCompare",
    `📊 Compare: ${comparison.summary.baseline.label} vs ${comparison.summary.comparison.label}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
    },
  );
  panel.webview.html = renderComparisonHtml(comparison);
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.command === "exportCompareMarkdown") {
      const md = buildComparisonMarkdown(comparison);
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage(
        "Comparison copied to clipboard as Markdown.",
      );
    }
  });
}

function buildMarkdownReport(a: Analysis, aiText: string): string {
  const fmt = (n?: number) => (n ?? 0).toFixed(2);
  const lines: string[] = [];
  lines.push(`# Apex Log Analysis`);
  lines.push("");
  lines.push(`*Generated by Apex Doctor*`);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- **API Version:** ${a.summary.apiVersion}`);
  lines.push(`- **Total Duration:** ${fmt(a.summary.totalDurationMs)} ms`);
  lines.push(`- **SOQL Queries:** ${a.soql.length}`);
  lines.push(`- **DML Operations:** ${a.dml.length}`);
  lines.push(
    `- **Errors:** ${a.issues.filter((i) => i.severity === "fatal" || i.severity === "error").length}`,
  );
  lines.push(
    `- **Warnings:** ${a.issues.filter((i) => i.severity === "warning").length}`,
  );
  lines.push(`- **Debug Statements:** ${a.debugs.length}`);
  if (a.userInfo) {
    lines.push(
      `- **Executed by:** ${a.userInfo.Name} (${a.userInfo.Username}) — ${a.userInfo.ProfileName ?? "No profile"}`,
    );
  }
  lines.push("");

  if (a.issues.length) {
    lines.push(`## Issues`);
    lines.push("");
    for (const i of a.issues) {
      lines.push(
        `### [${i.severity.toUpperCase()}] ${i.type}${i.lineNumber ? ` (line ${i.lineNumber})` : ""}`,
      );
      lines.push("");
      lines.push("```");
      lines.push(i.message);
      lines.push("```");
      if (i.context) {
        lines.push(`> ${i.context}`);
      }
      lines.push("");
    }
  }

  if (aiText) {
    lines.push(`## AI Root-Cause Analysis`);
    lines.push("");
    lines.push(aiText);
    lines.push("");
  }

  if (a.methods.length) {
    lines.push(`## Slowest Methods`);
    lines.push("");
    lines.push(`| Method | Duration (ms) | Line |`);
    lines.push(`|---|---|---|`);
    for (const m of a.methods.slice(0, 20)) {
      lines.push(
        `| \`${m.name}\` | ${fmt(m.durationMs)} | ${m.lineNumber ?? "-"} |`,
      );
    }
    lines.push("");
  }

  if (a.soql.length) {
    lines.push(`## SOQL Queries`);
    lines.push("");
    lines.push(`| # | Duration (ms) | Rows | Line | Query |`);
    lines.push(`|---|---|---|---|---|`);
    a.soql.forEach((q, i) => {
      lines.push(
        `| ${i + 1} | ${fmt(q.durationMs)} | ${q.rows ?? "-"} | ${q.lineNumber ?? "-"} | \`${q.query.replace(/\|/g, "\\|")}\` |`,
      );
    });
    lines.push("");
  }

  if (a.dml.length) {
    lines.push(`## DML Operations`);
    lines.push("");
    lines.push(`| # | Op | Rows | Duration (ms) | Line |`);
    lines.push(`|---|---|---|---|---|`);
    a.dml.forEach((d, i) => {
      lines.push(
        `| ${i + 1} | ${d.operation} | ${d.rows ?? "-"} | ${fmt(d.durationMs)} | ${d.lineNumber ?? "-"} |`,
      );
    });
    lines.push("");
  }

  return lines.join("\n");
}

// ---- Trace flag UI helpers ----

async function pickUser(
  sf: SalesforceService,
): Promise<UserSummary | undefined> {
  const query = await vscode.window.showInputBox({
    prompt: "Search for the user to trace (by name, username, or email)",
    placeHolder: "e.g. Jane Doe or jane@example.com",
    ignoreFocusOut: true,
  });
  if (!query || !query.trim()) {
    return undefined;
  }

  const users = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Searching for "${query}"…`,
    },
    async () => sf.searchUsers(query.trim(), 25),
  );

  if (!users.length) {
    vscode.window.showWarningMessage(`No active users matched "${query}".`);
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    users.map((u) => ({
      label: `$(person) ${u.Name}`,
      description: u.Profile?.Name ?? "",
      detail: `${u.Username} · ${u.Email}`,
      user: u,
    })),
    {
      placeHolder: "Select a user to trace",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return picked?.user;
}

async function pickDuration(): Promise<number | undefined> {
  const choices: { label: string; description?: string; minutes: number }[] = [
    { label: "30 minutes", minutes: 30 },
    { label: "1 hour", minutes: 60 },
    { label: "4 hours", minutes: 240 },
    { label: "8 hours", minutes: 480 },
    { label: "24 hours", description: "Salesforce maximum", minutes: 1440 },
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: "How long should the trace flag stay active?",
  });
  return picked?.minutes;
}

async function pickDebugLevel(
  sf: SalesforceService,
): Promise<DebugLevel | undefined> {
  const levels = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading debug levels…",
    },
    async () => sf.listDebugLevels(),
  );

  if (!levels.length) {
    vscode.window.showWarningMessage(
      "No debug levels found in the org. Create one in Setup → Debug Levels first.",
    );
    return undefined;
  }

  // Float the standard Dev Console level to the top — it's what most people want
  const sorted = [...levels].sort((a, b) => {
    if (a.DeveloperName === "SFDC_DevConsole") {
      return -1;
    }
    if (b.DeveloperName === "SFDC_DevConsole") {
      return 1;
    }
    return a.DeveloperName.localeCompare(b.DeveloperName);
  });

  const picked = await vscode.window.showQuickPick(
    sorted.map((d) => ({
      label: `$(debug) ${d.DeveloperName}`,
      description: `Apex: ${d.ApexCode} · DB: ${d.Database}`,
      detail: `System: ${d.System} · Profiling: ${d.ApexProfiling} · Callout: ${d.Callout}`,
      level: d,
    })),
    {
      placeHolder: "Select a debug level (controls what gets logged)",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  return picked?.level;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours}h ${mins}m`;
}

export function deactivate() {
  currentPanel?.dispose();
}
