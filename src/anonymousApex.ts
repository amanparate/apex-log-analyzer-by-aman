import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fsPromises from "fs/promises";
import { SalesforceService } from "./salesforceService";

const STARTER_TEMPLATE = `// Apex Doctor — Anonymous Apex playground
// Save the file (Cmd/Ctrl+S) then click "Run with Apex Doctor" or run the
// "Apex Doctor: Run This Anonymous Apex" command.
//
// Whatever this script does will be executed against your default org and
// the resulting debug log will be analysed for you automatically.

System.debug('Hello from Apex Doctor');
`;

let currentOpenFile: vscode.Uri | undefined;
let runStatusBarItem: vscode.StatusBarItem | undefined;

/** Open a fresh editor for ad-hoc Apex execution. */
export async function openAnonymousEditor(): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), "apex-doctor", "anonymous");
  await fsPromises.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `script-${Date.now()}.apex`);
  await fsPromises.writeFile(filePath, STARTER_TEMPLATE, "utf8");
  const uri = vscode.Uri.file(filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "apex").then(
    () => undefined,
    () => undefined, // No Apex language extension installed — that's fine
  );
  await vscode.window.showTextDocument(doc, { preview: false });
  currentOpenFile = uri;
  ensureStatusBarItem();
  refreshStatusBarVisibility();
}

/**
 * Run the active editor (or last-opened anonymous file) and analyse the
 * resulting debug log.
 */
export async function runAnonymousApex(
  sf: SalesforceService,
  onAnalyseLog: (logFilePath: string) => Promise<void>,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  let filePath: string | undefined;
  if (editor && isApexFile(editor.document.uri)) {
    await editor.document.save();
    filePath = editor.document.uri.fsPath;
  } else if (currentOpenFile) {
    filePath = currentOpenFile.fsPath;
  }
  if (!filePath) {
    vscode.window.showWarningMessage(
      "Open an .apex file first (Apex Doctor: Open Anonymous Apex Editor).",
    );
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Running anonymous Apex…",
    },
    async (progress) => {
      const since = new Date(Date.now() - 5_000).toISOString();
      progress.report({ message: "Executing via sf CLI" });

      const result = await sf.runAnonymousApex(filePath!);
      if (!result.success) {
        vscode.window.showErrorMessage(
          `Anonymous Apex failed:\n${result.stdout.slice(0, 800)}`,
        );
        return;
      }

      progress.report({ message: "Waiting for log to land in the org…" });
      // Logs sometimes appear with a 1–3s delay
      let logId: string | undefined;
      for (let attempt = 0; attempt < 8 && !logId; attempt++) {
        await sleep(750);
        try {
          logId = await sf.getMostRecentLogId(since);
        } catch {
          /* keep retrying */
        }
      }
      if (!logId) {
        vscode.window.showWarningMessage(
          "Anonymous Apex ran but no log was found in the org. Set up a TraceFlag for your user (Apex Doctor: Manage Trace Flags) and try again.",
        );
        return;
      }

      progress.report({ message: `Downloading log ${logId}…` });
      const logFilePath = await sf.downloadLog(logId);
      progress.report({ message: "Analysing…" });
      await onAnalyseLog(logFilePath);
    },
  );
}

function ensureStatusBarItem(): void {
  if (runStatusBarItem) {
    return;
  }
  runStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    98,
  );
  runStatusBarItem.text = "$(play) Run with Apex Doctor";
  runStatusBarItem.tooltip = "Execute this anonymous Apex and analyse the resulting log";
  runStatusBarItem.command = "apexDoctor.runAnonymousApex";
}

/** Show / hide the status-bar runner depending on the active editor. */
export function refreshStatusBarVisibility(): void {
  if (!runStatusBarItem) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && isApexFile(editor.document.uri)) {
    runStatusBarItem.show();
  } else {
    runStatusBarItem.hide();
  }
}

export function disposeStatusBarItem(): void {
  runStatusBarItem?.dispose();
  runStatusBarItem = undefined;
}

function isApexFile(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith(".apex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
