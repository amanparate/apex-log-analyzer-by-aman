import * as vscode from 'vscode';
import { SalesforceService, ApexLogRecord } from './salesforceService';

export interface StreamEvent {
  log: ApexLogRecord;
}

type Listener = (event: StreamEvent) => void;
type StatusListener = (running: boolean, message?: string) => void;

const POLL_INTERVAL_MS = 3000;

export class StreamingService {
  private isActive = false;
  private seenIds = new Set<string>();
  private listeners: Listener[] = [];
  private statusListeners: StatusListener[] = [];
  private pollTimer: NodeJS.Timeout | undefined;
  private streamStartedAt: Date = new Date();

  constructor(private sf: SalesforceService) {}

  isRunning(): boolean {
    return this.isActive;
  }

  onLog(listener: Listener): vscode.Disposable {
    this.listeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) { this.listeners.splice(idx, 1); }
    });
  }

  onStatus(listener: StatusListener): vscode.Disposable {
    this.statusListeners.push(listener);
    return new vscode.Disposable(() => {
      const idx = this.statusListeners.indexOf(listener);
      if (idx >= 0) { this.statusListeners.splice(idx, 1); }
    });
  }

  private emit(log: ApexLogRecord) {
    for (const l of this.listeners) { l({ log }); }
  }

  private emitStatus(running: boolean, message?: string) {
    for (const l of this.statusListeners) { l(running, message); }
  }

  async start(): Promise<void> {
    if (this.isActive) {
      // Already running — just re-emit status so any newly-mounted listeners refresh
      this.emitStatus(true, `Streaming (polling every ${POLL_INTERVAL_MS / 1000}s)`);
      return;
    }

    const org = await this.sf.getDefaultOrg();
    if (!org) {
      vscode.window.showErrorMessage('No default Salesforce org. Run: sf org login web');
      return;
    }

    // Fresh window on each start — logs that arrived during a paused stream
    // shouldn't surface when streaming resumes.
    this.seenIds.clear();
    this.streamStartedAt = new Date(Date.now() - 60_000); // also catch logs from ~1 min ago

    this.isActive = true;
    this.emitStatus(true, 'Starting…');

    this.pollTimer = setInterval(
      () => this.pollForNewLogs().catch(() => { /* swallow */ }),
      POLL_INTERVAL_MS,
    );

    // Immediate first poll so the UI doesn't sit empty for 3 seconds
    this.pollForNewLogs().catch(() => { /* swallow */ });

    this.emitStatus(true, `Streaming (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  private async pollForNewLogs() {
    if (!this.isActive) { return; }
    try {
      const logs = await this.sf.listRecentLogs(20);
      // Sort ascending by StartTime so we emit in chronological order
      const sorted = [...logs].sort(
        (a, b) => new Date(a.StartTime).getTime() - new Date(b.StartTime).getTime(),
      );
      for (const log of sorted) {
        if (this.seenIds.has(log.Id)) { continue; }
        this.seenIds.add(log.Id);
        if (new Date(log.StartTime).getTime() < this.streamStartedAt.getTime()) { continue; }
        this.emit(log);
      }
    } catch (e: any) {
      this.emitStatus(true, `Poll error: ${e.message}`);
    }
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.isActive = false;
    this.emitStatus(false);
  }

  dispose() {
    this.stop();
    this.listeners = [];
    this.statusListeners = [];
  }
}