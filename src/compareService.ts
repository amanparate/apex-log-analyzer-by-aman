import { Analysis, Issue, MethodEntry, SoqlEntry } from './analyzer';

export interface ComparisonSummary {
  baseline: { label: string; durationMs: number; soqlCount: number; dmlCount: number; errorCount: number; warningCount: number; debugCount: number };
  comparison: { label: string; durationMs: number; soqlCount: number; dmlCount: number; errorCount: number; warningCount: number; debugCount: number };
  deltas: { durationMs: number; durationPct: number; soqlCount: number; dmlCount: number; errorCount: number; warningCount: number; debugCount: number };
  verdict: 'faster' | 'slower' | 'equivalent' | 'regressed';
  verdictText: string;
}

export interface IssueDiff {
  onlyInBaseline: Issue[];     // resolved in comparison
  onlyInComparison: Issue[];   // new in comparison
  commonCount: number;
}

export interface MethodDelta {
  name: string;
  baselineMs?: number;
  comparisonMs?: number;
  deltaMs: number;
  deltaPct: number;  // positive = slower, negative = faster
  status: 'new' | 'removed' | 'regressed' | 'improved' | 'unchanged';
}

export interface SoqlDelta {
  queryPattern: string;
  baselineCount: number;
  comparisonCount: number;
  baselineRows: number;
  comparisonRows: number;
  baselineTotalMs: number;
  comparisonTotalMs: number;
  countDelta: number;
  rowsDelta: number;
  msDelta: number;
}

export interface Comparison {
  summary: ComparisonSummary;
  issues: IssueDiff;
  methods: MethodDelta[];
  soql: SoqlDelta[];
}

export class CompareService {
  compare(baseline: Analysis, comparison: Analysis, baselineLabel: string, comparisonLabel: string): Comparison {
    return {
      summary: this.buildSummary(baseline, comparison, baselineLabel, comparisonLabel),
      issues: this.diffIssues(baseline.issues, comparison.issues),
      methods: this.diffMethods(baseline.methods, comparison.methods),
      soql: this.diffSoql(baseline.soql, comparison.soql)
    };
  }

  private buildSummary(b: Analysis, c: Analysis, bLabel: string, cLabel: string): ComparisonSummary {
    const bStats = this.stats(b, bLabel);
    const cStats = this.stats(c, cLabel);
    const durationDelta = cStats.durationMs - bStats.durationMs;
    const durationPct = bStats.durationMs > 0 ? (durationDelta / bStats.durationMs) * 100 : 0;

    let verdict: ComparisonSummary['verdict'];
    let verdictText: string;
    const newErrors = cStats.errorCount - bStats.errorCount;

    if (newErrors > 0) {
      verdict = 'regressed';
      verdictText = `Comparison has ${newErrors} more error${newErrors === 1 ? '' : 's'}`;
    } else if (Math.abs(durationPct) < 5) {
      verdict = 'equivalent';
      verdictText = 'Performance is essentially the same';
    } else if (durationPct < 0) {
      verdict = 'faster';
      verdictText = `Comparison is ${Math.abs(durationPct).toFixed(1)}% faster (${Math.abs(durationDelta).toFixed(0)} ms)`;
    } else {
      verdict = 'slower';
      verdictText = `Comparison is ${durationPct.toFixed(1)}% slower (${durationDelta.toFixed(0)} ms)`;
    }

    return {
      baseline: bStats,
      comparison: cStats,
      deltas: {
        durationMs: durationDelta,
        durationPct,
        soqlCount: cStats.soqlCount - bStats.soqlCount,
        dmlCount: cStats.dmlCount - bStats.dmlCount,
        errorCount: cStats.errorCount - bStats.errorCount,
        warningCount: cStats.warningCount - bStats.warningCount,
        debugCount: cStats.debugCount - bStats.debugCount
      },
      verdict,
      verdictText
    };
  }

  private stats(a: Analysis, label: string) {
    return {
      label,
      durationMs: a.summary.totalDurationMs,
      soqlCount: a.soql.length,
      dmlCount: a.dml.length,
      errorCount: a.issues.filter(i => i.severity === 'fatal' || i.severity === 'error').length,
      warningCount: a.issues.filter(i => i.severity === 'warning').length,
      debugCount: a.debugs.length
    };
  }

  private issueKey(i: Issue): string {
    // Similar issues have same type + line number + first 60 chars of message
    return `${i.type}|${i.lineNumber ?? '?'}|${i.message.slice(0, 60)}`;
  }

  private diffIssues(baseline: Issue[], comparison: Issue[]): IssueDiff {
    const bKeys = new Set(baseline.map(i => this.issueKey(i)));
    const cKeys = new Set(comparison.map(i => this.issueKey(i)));
    const onlyInBaseline = baseline.filter(i => !cKeys.has(this.issueKey(i)));
    const onlyInComparison = comparison.filter(i => !bKeys.has(this.issueKey(i)));
    const commonCount = baseline.length - onlyInBaseline.length;
    return { onlyInBaseline, onlyInComparison, commonCount };
  }

  private diffMethods(baseline: MethodEntry[], comparison: MethodEntry[]): MethodDelta[] {
    const bMap = new Map<string, MethodEntry>();
    const cMap = new Map<string, MethodEntry>();
    for (const m of baseline) {
      const existing = bMap.get(m.name);
      if (!existing || m.durationMs > existing.durationMs) { bMap.set(m.name, m); }
    }
    for (const m of comparison) {
      const existing = cMap.get(m.name);
      if (!existing || m.durationMs > existing.durationMs) { cMap.set(m.name, m); }
    }

    const allNames = new Set<string>([...bMap.keys(), ...cMap.keys()]);
    const deltas: MethodDelta[] = [];

    for (const name of allNames) {
      const b = bMap.get(name);
      const c = cMap.get(name);
      const bMs = b?.durationMs ?? 0;
      const cMs = c?.durationMs ?? 0;
      const deltaMs = cMs - bMs;
      const deltaPct = bMs > 0 ? (deltaMs / bMs) * 100 : (cMs > 0 ? 100 : 0);

      let status: MethodDelta['status'];
      if (!b) { status = 'new'; }
      else if (!c) { status = 'removed'; }
      else if (Math.abs(deltaPct) < 10) { status = 'unchanged'; }
      else if (deltaMs > 0) { status = 'regressed'; }
      else { status = 'improved'; }

      deltas.push({
        name,
        baselineMs: b?.durationMs,
        comparisonMs: c?.durationMs,
        deltaMs,
        deltaPct,
        status
      });
    }

    // Sort: biggest regressions first, then new methods, then others
    return deltas.sort((x, y) => {
      const xRank = this.rank(x);
      const yRank = this.rank(y);
      if (xRank !== yRank) { return xRank - yRank; }
      return y.deltaMs - x.deltaMs;
    });
  }

  private rank(d: MethodDelta): number {
    if (d.status === 'regressed') { return 0; }
    if (d.status === 'new') { return 1; }
    if (d.status === 'removed') { return 2; }
    if (d.status === 'improved') { return 3; }
    return 4;
  }

  private normaliseQuery(q: string): string {
    return q
      .replace(/:\w+/g, ':?')
      .replace(/'[^']*'/g, "'?'")
      .replace(/\b\d+\b/g, '?')
      .trim();
  }

  private diffSoql(baseline: SoqlEntry[], comparison: SoqlEntry[]): SoqlDelta[] {
    const bGroups = this.groupSoql(baseline);
    const cGroups = this.groupSoql(comparison);
    const allPatterns = new Set<string>([...bGroups.keys(), ...cGroups.keys()]);
    const deltas: SoqlDelta[] = [];

    for (const pattern of allPatterns) {
      const b = bGroups.get(pattern) || { count: 0, rows: 0, totalMs: 0 };
      const c = cGroups.get(pattern) || { count: 0, rows: 0, totalMs: 0 };
      deltas.push({
        queryPattern: pattern,
        baselineCount: b.count,
        comparisonCount: c.count,
        baselineRows: b.rows,
        comparisonRows: c.rows,
        baselineTotalMs: b.totalMs,
        comparisonTotalMs: c.totalMs,
        countDelta: c.count - b.count,
        rowsDelta: c.rows - b.rows,
        msDelta: c.totalMs - b.totalMs
      });
    }

    // Sort by biggest total ms delta (regressions first)
    return deltas.sort((x, y) => y.msDelta - x.msDelta);
  }

  private groupSoql(queries: SoqlEntry[]): Map<string, { count: number; rows: number; totalMs: number }> {
    const map = new Map<string, { count: number; rows: number; totalMs: number }>();
    for (const q of queries) {
      const key = this.normaliseQuery(q.query);
      const existing = map.get(key) || { count: 0, rows: 0, totalMs: 0 };
      existing.count += 1;
      existing.rows += q.rows ?? 0;
      existing.totalMs += q.durationMs ?? 0;
      map.set(key, existing);
    }
    return map;
  }
}