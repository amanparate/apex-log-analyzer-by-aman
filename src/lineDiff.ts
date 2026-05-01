import { LogEvent } from "./parser";

export type DiffOpKind = "same" | "added" | "removed" | "changed";

export interface DiffOp {
  kind: DiffOpKind;
  /** Index into the baseline event stream, if applicable */
  baselineIdx?: number;
  /** Index into the comparison event stream, if applicable */
  comparisonIdx?: number;
  /** Human-readable label for the row */
  label: string;
  /** Optional sub-label for "changed" ops, e.g. duration delta */
  detail?: string;
}

export interface LineDiffResult {
  ops: DiffOp[];
  stats: {
    same: number;
    added: number;
    removed: number;
    changed: number;
  };
}

/**
 * Run a line-by-line diff between two parsed Apex logs. Only "interesting"
 * events are included (METHOD_ENTRY, SOQL_EXECUTE_BEGIN, DML_BEGIN,
 * CODE_UNIT_STARTED, USER_DEBUG, EXCEPTION_THROWN, FATAL_ERROR, CALLOUT_REQUEST).
 *
 * Each event is fingerprinted by its `eventType + first 80 chars of details`
 * so two semantically identical events match even if their numeric prefixes
 * (timestamps / nanoseconds) differ.
 */
export function diffEvents(baseline: LogEvent[], comparison: LogEvent[]): LineDiffResult {
  const a = filterSignificant(baseline);
  const b = filterSignificant(comparison);

  const ops: DiffOp[] = [];
  const aIdx = a.map((_, i) => i);
  const bIdx = b.map((_, i) => i);

  // Run LCS over fingerprints
  const aFp = a.map(fingerprint);
  const bFp = b.map(fingerprint);
  const lcs = computeLcs(aFp, bFp);

  // Walk the LCS matches to emit add/remove/same/changed ops
  let i = 0;
  let j = 0;
  for (const [ai, bj] of lcs) {
    while (i < ai) {
      ops.push({
        kind: "removed",
        baselineIdx: aIdx[i],
        label: labelOf(a[i]),
      });
      i++;
    }
    while (j < bj) {
      ops.push({
        kind: "added",
        comparisonIdx: bIdx[j],
        label: labelOf(b[j]),
      });
      j++;
    }
    // Same fingerprint match. Mark as "changed" if a numeric duration drift exists.
    const ev1 = a[ai];
    const ev2 = b[bj];
    const change = describeChange(ev1, ev2);
    ops.push({
      kind: change ? "changed" : "same",
      baselineIdx: aIdx[ai],
      comparisonIdx: bIdx[bj],
      label: labelOf(ev1),
      detail: change,
    });
    i = ai + 1;
    j = bj + 1;
  }
  while (i < a.length) {
    ops.push({ kind: "removed", baselineIdx: aIdx[i], label: labelOf(a[i]) });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "added", comparisonIdx: bIdx[j], label: labelOf(b[j]) });
    j++;
  }

  const stats = ops.reduce(
    (acc, op) => {
      acc[op.kind] += 1;
      return acc;
    },
    { same: 0, added: 0, removed: 0, changed: 0 } as LineDiffResult["stats"],
  );

  return { ops, stats };
}

/** Keep only the events most useful in a behaviour diff. */
function filterSignificant(events: LogEvent[]): LogEvent[] {
  const keep = new Set([
    "METHOD_ENTRY",
    "SOQL_EXECUTE_BEGIN",
    "DML_BEGIN",
    "CODE_UNIT_STARTED",
    "USER_DEBUG",
    "EXCEPTION_THROWN",
    "FATAL_ERROR",
    "CALLOUT_REQUEST",
    "TEST_PASS",
    "TEST_FAIL",
  ]);
  return events.filter((e) => keep.has(e.eventType));
}

function fingerprint(ev: LogEvent): string {
  // Strip line numbers + numeric IDs that vary across runs.
  const cleaned = ev.details
    .replace(/\[\d+\]/g, "[?]")
    .replace(/\b07L[a-zA-Z0-9]{12,15}\b/g, "[logId]")
    .replace(/\b001[a-zA-Z0-9]{12,15}\b/g, "[recId]")
    .replace(/Rows:\s*\d+/g, "Rows:?")
    .slice(0, 120);
  return `${ev.eventType}|${cleaned}`;
}

function labelOf(ev: LogEvent): string {
  const parts = ev.details.split("|");
  const tail = parts[parts.length - 1] || ev.details;
  switch (ev.eventType) {
    case "METHOD_ENTRY":
      return `→ ${tail}`;
    case "SOQL_EXECUTE_BEGIN":
      return `SOQL: ${tail.slice(0, 80)}${tail.length > 80 ? "…" : ""}`;
    case "DML_BEGIN":
      return `DML: ${ev.details.slice(0, 60)}`;
    case "CODE_UNIT_STARTED":
      return `▼ ${tail}`;
    case "USER_DEBUG":
      return `debug: ${parts.slice(1).join("|").slice(0, 80)}`;
    case "EXCEPTION_THROWN":
      return `⚠ ${ev.details.slice(0, 80)}`;
    case "FATAL_ERROR":
      return `🛑 ${ev.details.split("\n")[0].slice(0, 80)}`;
    case "CALLOUT_REQUEST":
      return `📡 ${tail.slice(0, 80)}`;
    case "TEST_PASS":
      return `✅ TEST_PASS ${parts[0]}`;
    case "TEST_FAIL":
      return `❌ TEST_FAIL ${parts[0]}`;
    default:
      return `${ev.eventType} ${tail.slice(0, 60)}`;
  }
}

function describeChange(a: LogEvent, b: LogEvent): string | undefined {
  // For the events we care about, the only easy "change" signal is a
  // change in row count baked into the details (Rows:N).
  const ra = /Rows:\s*(\d+)/.exec(a.details)?.[1];
  const rb = /Rows:\s*(\d+)/.exec(b.details)?.[1];
  if (ra && rb && ra !== rb) {
    return `Rows: ${ra} → ${rb}`;
  }
  return undefined;
}

/**
 * Compute the longest common subsequence between two arrays of strings.
 * Returns matched index pairs `[i, j]` in order.
 *
 * O(N*M) time + space — fine for logs up to a few thousand events. For
 * very long logs we'd want Myers' diff; not yet warranted.
 */
function computeLcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  // Hard cap to avoid pathological logs OOM-ing
  const CAP = 5000;
  if (n > CAP || m > CAP) {
    return computeLcsHashed(
      a.length > CAP ? a.slice(-CAP) : a,
      b.length > CAP ? b.slice(-CAP) : b,
    );
  }
  return computeLcsHashed(a, b);
}

function computeLcsHashed(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length for a[0..i] vs b[0..j]
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Uint32Array(m + 1));
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  // Backtrack to recover the matching pairs
  const out: [number, number][] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return out.reverse();
}
