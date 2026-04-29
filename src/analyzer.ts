import { ParsedLog, LogEvent } from './parser';
import * as vscode from 'vscode';
import { Insight, generateInsights } from './insights';


export interface Issue {
  severity: 'fatal' | 'error' | 'warning' | 'info';
  type: string;
  message: string;
  lineNumber?: number;
  timestamp: string;
  context?: string;
}

export interface SoqlEntry { query: string; rows?: number; durationMs?: number; lineNumber?: number; timestamp: string; }
export interface DmlEntry { operation: string; rows?: number; durationMs?: number; lineNumber?: number; timestamp: string; }
export interface MethodEntry { name: string; lineNumber?: number; durationMs: number; timestamp: string; }
export interface DebugEntry { level: string; message: string; lineNumber?: number; timestamp: string; }

export interface FlameNode {
  name: string;
  kind: 'code_unit' | 'method' | 'soql' | 'dml' | 'callout' | 'root';
  startNs: number;
  endNs: number;
  durationMs: number;
  lineNumber?: number;
  children: FlameNode[];
}

export interface Analysis {
  summary: {
    apiVersion: string;
    totalEvents: number;
    totalDurationMs: number;
    executionStart?: string;
    executionEnd?: string;
    logLevels: Record<string, string>;
  };
  issues: Issue[];
  soql: SoqlEntry[];
  dml: DmlEntry[];
  methods: MethodEntry[];
  debugs: DebugEntry[];
  limits: string[];
  codeUnits: { name: string; durationMs: number; timestamp: string }[];
  userInfo?: { Name: string; Username: string; Email: string; ProfileName?: string };
  flameRoot: FlameNode;
  insights: Insight[];
}

export class ApexDoctor {
  analyze(parsed: ParsedLog): Analysis {
    const issues: Issue[] = [];
    const soql: SoqlEntry[] = [];
    const dml: DmlEntry[] = [];
    const methods: MethodEntry[] = [];
    const debugs: DebugEntry[] = [];
    const limits: string[] = [];
    const codeUnits: { name: string; durationMs: number; timestamp: string }[] = [];

    let execStart: LogEvent | undefined;
    let execEnd: LogEvent | undefined;

    // Parallel stacks for durations
    const methodStack: { ev: LogEvent; name: string }[] = [];
    const soqlStack: { ev: LogEvent; query: string }[] = [];
    const dmlStack: { ev: LogEvent; op: string; rows?: number }[] = [];
    const codeUnitStack: { ev: LogEvent; name: string }[] = [];

    // Flame-graph tree built via an "active" stack
    const flameRoot: FlameNode = {
      name: 'Execution', kind: 'root',
      startNs: 0, endNs: 0, durationMs: 0,
      children: []
    };
    const flameStack: FlameNode[] = [flameRoot];

    const openNode = (ev: LogEvent, name: string, kind: FlameNode['kind']) => {
      const node: FlameNode = {
        name, kind,
        startNs: ev.nanoseconds,
        endNs: ev.nanoseconds,
        durationMs: 0,
        lineNumber: ev.lineNumber,
        children: []
      };
      flameStack[flameStack.length - 1].children.push(node);
      flameStack.push(node);
    };

    const closeNode = (ev: LogEvent) => {
      if (flameStack.length <= 1) {return;}
      const node = flameStack.pop()!;
      node.endNs = ev.nanoseconds;
      node.durationMs = (node.endNs - node.startNs) / 1e6;
    };

    for (const ev of parsed.events) {
      switch (ev.eventType) {
        case 'EXECUTION_STARTED':
          execStart = ev;
          flameRoot.startNs = ev.nanoseconds;
          break;
        case 'EXECUTION_FINISHED':
          execEnd = ev;
          flameRoot.endNs = ev.nanoseconds;
          flameRoot.durationMs = (flameRoot.endNs - flameRoot.startNs) / 1e6;
          break;

        case 'CODE_UNIT_STARTED': {
          const parts = ev.details.split('|');
          const name = parts[parts.length - 1] || ev.details;
          codeUnitStack.push({ ev, name });
          openNode(ev, name, 'code_unit');
          break;
        }
        case 'CODE_UNIT_FINISHED': {
          const opened = codeUnitStack.pop();
          if (opened) {codeUnits.push({
            name: opened.name,
            durationMs: (ev.nanoseconds - opened.ev.nanoseconds) / 1e6,
            timestamp: opened.ev.timestamp
          });}
          closeNode(ev);
          break;
        }

        case 'METHOD_ENTRY': {
          const parts = ev.details.split('|');
          const name = parts[parts.length - 1];
          methodStack.push({ ev, name });
          openNode(ev, name, 'method');
          break;
        }
        case 'METHOD_EXIT': {
          const opened = methodStack.pop();
          if (opened) {methods.push({
            name: opened.name,
            lineNumber: opened.ev.lineNumber,
            durationMs: (ev.nanoseconds - opened.ev.nanoseconds) / 1e6,
            timestamp: opened.ev.timestamp
          });}
          closeNode(ev);
          break;
        }

        case 'SOQL_EXECUTE_BEGIN': {
          const parts = ev.details.split('|');
          const query = parts[parts.length - 1] || ev.details;
          soqlStack.push({ ev, query });
          openNode(ev, `SOQL: ${query.slice(0, 60)}…`, 'soql');
          break;
        }
        case 'SOQL_EXECUTE_END': {
          const opened = soqlStack.pop();
          const rowsMatch = /Rows:(\d+)/.exec(ev.details);
          soql.push({
            query: opened?.query || 'Unknown',
            rows: rowsMatch ? Number(rowsMatch[1]) : undefined,
            durationMs: opened ? (ev.nanoseconds - opened.ev.nanoseconds) / 1e6 : undefined,
            lineNumber: opened?.ev.lineNumber,
            timestamp: opened?.ev.timestamp || ev.timestamp
          });
          closeNode(ev);
          break;
        }

        case 'DML_BEGIN': {
          const opMatch = /Op:(\w+)/.exec(ev.details);
          const rowsMatch = /Rows:(\d+)/.exec(ev.details);
          const op = opMatch ? opMatch[1] : 'UNKNOWN';
          dmlStack.push({ ev, op, rows: rowsMatch ? Number(rowsMatch[1]) : undefined });
          openNode(ev, `DML: ${op}`, 'dml');
          break;
        }
        case 'DML_END': {
          const opened = dmlStack.pop();
          dml.push({
            operation: opened?.op || 'UNKNOWN',
            rows: opened?.rows,
            durationMs: opened ? (ev.nanoseconds - opened.ev.nanoseconds) / 1e6 : undefined,
            lineNumber: opened?.ev.lineNumber,
            timestamp: opened?.ev.timestamp || ev.timestamp
          });
          closeNode(ev);
          break;
        }

        case 'CALLOUT_REQUEST':
          openNode(ev, 'CALLOUT', 'callout');
          break;
        case 'CALLOUT_RESPONSE':
          closeNode(ev);
          break;

        case 'USER_DEBUG': {
          const parts = ev.details.split('|');
          debugs.push({
            level: parts[0] || 'DEBUG',
            message: parts.slice(1).join('|'),
            lineNumber: ev.lineNumber,
            timestamp: ev.timestamp
          });
          break;
        }

        case 'EXCEPTION_THROWN':
          issues.push({
            severity: 'error',
            type: 'Exception Thrown',
            message: ev.details,
            lineNumber: ev.lineNumber,
            timestamp: ev.timestamp,
            context: 'An exception was thrown — check the stack trace and surrounding methods.'
          });
          break;

        case 'FATAL_ERROR':
          issues.push({
            severity: 'fatal',
            type: 'Fatal Error',
            message: ev.details,
            lineNumber: ev.lineNumber,
            timestamp: ev.timestamp,
            context: 'Execution was halted by this error. This is most likely the root cause.'
          });
          break;

        case 'CUMULATIVE_LIMIT_USAGE':
        case 'LIMIT_USAGE_FOR_NS':
          limits.push(ev.raw);
          break;
      }
    }

    // Read thresholds from user settings
    const config = vscode.workspace.getConfiguration('apexDoctor');
    const largeQueryThreshold = config.get<number>('largeQueryThreshold') ?? 1000;
    const soqlInLoopThreshold = config.get<number>('soqlInLoopThreshold') ?? 5;

    // Heuristic: large and slow queries
    for (const q of soql) {
      if ((q.rows ?? 0) >= largeQueryThreshold) {
        issues.push({
          severity: 'warning',
          type: 'Large Query Result',
          message: `Query returned ${q.rows} rows`,
          lineNumber: q.lineNumber,
          timestamp: q.timestamp,
          context: `Query: ${q.query}`
        });
      }
      if ((q.durationMs ?? 0) > 1000) {
        issues.push({
          severity: 'warning',
          type: 'Slow SOQL Query',
          message: `Query took ${q.durationMs?.toFixed(2)} ms`,
          lineNumber: q.lineNumber,
          timestamp: q.timestamp,
          context: `Query: ${q.query}`
        });
      }
    }

    // Heuristic: SOQL-in-loop detection (group by normalised query text)
    const queryFrequency = new Map<string, SoqlEntry[]>();
    for (const q of soql) {
      // Normalise bind-variable differences: :oppIds, 'abc', 12345 become placeholders
      const key = q.query
        .replace(/:\w+/g, ':?')
        .replace(/'[^']*'/g, "'?'")
        .replace(/\b\d+\b/g, '?')
        .trim();
      if (!queryFrequency.has(key)) {queryFrequency.set(key, []);}
      queryFrequency.get(key)!.push(q);
    }
    for (const [normalisedQuery, entries] of queryFrequency) {
      if (entries.length >= soqlInLoopThreshold) {
        issues.push({
          severity: 'error',
          type: 'SOQL in Loop',
          message: `Same query executed ${entries.length} times — likely inside a loop`,
          lineNumber: entries[0].lineNumber,
          timestamp: entries[0].timestamp,
          context: `Bulkify: collect IDs into a Set, then run ONE query with WHERE ... IN :ids. Query pattern: ${normalisedQuery.slice(0, 200)}`
        });
      }
    }

    // Governor limit warnings
    if (soql.length > 100) {
      issues.push({
        severity: 'error',
        type: 'SOQL Governor Limit Exceeded',
        message: `${soql.length} SOQL queries executed (synchronous limit is 100)`,
        timestamp: execStart?.timestamp || '00:00:00.000',
        context: 'Look for SOQL inside loops — the classic culprit.'
      });
    }
    if (dml.length > 150) {
      issues.push({
        severity: 'error',
        type: 'DML Governor Limit Exceeded',
        message: `${dml.length} DML statements (limit is 150)`,
        timestamp: execStart?.timestamp || '00:00:00.000',
        context: 'Bulkify your DML.'
      });
    }

    // Close any lingering flame nodes (defensive, in case the log ended mid-stack)
    while (flameStack.length > 1) {
      const node = flameStack.pop()!;
      node.endNs = flameRoot.endNs || node.startNs;
      node.durationMs = (node.endNs - node.startNs) / 1e6;
    }
    if (flameRoot.endNs === 0 && parsed.events.length > 0) {
      flameRoot.endNs = parsed.events[parsed.events.length - 1].nanoseconds;
      flameRoot.durationMs = (flameRoot.endNs - flameRoot.startNs) / 1e6;
    }

    const sortedIssues = issues.sort((a, b) => this.sev(a.severity) - this.sev(b.severity));
    const sortedMethods = methods.sort((a, b) => b.durationMs - a.durationMs).slice(0, 50);

    const preliminary: Analysis = {
      summary: {
        apiVersion: parsed.apiVersion,
        totalEvents: parsed.events.length,
        totalDurationMs: execEnd && execStart ? (execEnd.nanoseconds - execStart.nanoseconds) / 1e6 : 0,
        executionStart: execStart?.timestamp,
        executionEnd: execEnd?.timestamp,
        logLevels: parsed.logLevels
      },
      issues: sortedIssues,
      soql,
      dml,
      methods: sortedMethods,
      debugs,
      limits,
      codeUnits,
      flameRoot,
      insights: []
    };

    // Compute insights from the preliminary analysis, then populate
     
    preliminary.insights = generateInsights(preliminary);

    return preliminary;
  }

  private sev(s: Issue['severity']): number {
    return { fatal: 0, error: 1, warning: 2, info: 3 }[s];
  }
}