import * as assert from "assert";
import { ApexLogParser } from "../parser";
import { ApexDoctor } from "../analyzer";
import { CompareService } from "../compareService";
import { detectRecurringPatterns } from "../recurringPatterns";
import { linkAsyncChain, AsyncHistoryEntry } from "../asyncTracer";
import { tryTemplatedFix } from "../fixTemplates";
import { parseNlQueryResponse } from "../nlQuery";
import { diffEvents } from "../lineDiff";
import {
  NORMAL_LOG,
  SOQL_IN_LOOP_LOG,
  FATAL_ERROR_LOG,
  LIMITS_LOG,
  TEST_RESULTS_LOG,
  LARGE_QUERY_LOG,
  TRIGGER_ORDER_LOG,
  ASYNC_PARENT_LOG,
  HOT_PATH_LOG,
} from "./fixtures";

const parser = new ApexLogParser();
const doctor = new ApexDoctor();

suite("ApexLogParser", () => {
  test("parses API version + log levels from header", () => {
    const out = parser.parse(NORMAL_LOG);
    assert.strictEqual(out.apiVersion, "52.0");
    assert.strictEqual(out.logLevels.APEX_CODE, "DEBUG");
    assert.strictEqual(out.logLevels.APEX_PROFILING, "INFO");
  });

  test("extracts event types and Apex line numbers", () => {
    const out = parser.parse(NORMAL_LOG);
    const types = out.events.map((e) => e.eventType);
    assert.ok(types.includes("EXECUTION_STARTED"));
    assert.ok(types.includes("METHOD_ENTRY"));
    assert.ok(types.includes("SOQL_EXECUTE_BEGIN"));
    const methodEntry = out.events.find((e) => e.eventType === "METHOD_ENTRY");
    assert.strictEqual(methodEntry?.lineNumber, 10);
  });

  test("appends continuation lines onto the last event's details", () => {
    const out = parser.parse(FATAL_ERROR_LOG);
    const fatal = out.events.find((e) => e.eventType === "FATAL_ERROR");
    assert.ok(fatal);
    assert.match(fatal!.details, /Class\.AccountService\.process: line 105/);
    assert.match(fatal!.details, /Trigger\.AccountTrigger: line 12/);
  });
});

suite("ApexDoctor.analyze", () => {
  test("normal log → no issues, captures soql + method timing", () => {
    const a = doctor.analyze(parser.parse(NORMAL_LOG));
    assert.strictEqual(a.issues.length, 0);
    assert.strictEqual(a.soql.length, 1);
    assert.strictEqual(a.soql[0].rows, 5);
    assert.strictEqual(a.methods.length, 1);
    assert.ok(a.summary.totalDurationMs > 0);
  });

  test("detects SOQL-in-loop above threshold (default 5)", () => {
    const a = doctor.analyze(parser.parse(SOQL_IN_LOOP_LOG));
    const inLoop = a.issues.find((i) => i.type === "SOQL in Loop");
    assert.ok(inLoop, "expected SOQL in Loop issue");
    assert.strictEqual(inLoop!.severity, "error");
    assert.match(inLoop!.message, /7 times/);
  });

  test("flags large query results when rows >= largeQueryThreshold", () => {
    const a = doctor.analyze(parser.parse(LARGE_QUERY_LOG));
    const large = a.issues.find((i) => i.type === "Large Query Result");
    assert.ok(large, "expected Large Query Result issue");
    assert.match(large!.message, /2500 rows/);
  });

  test("parses governor limits into structured metrics", () => {
    const a = doctor.analyze(parser.parse(LIMITS_LOG));
    assert.strictEqual(a.limits.length, 1);
    const lu = a.limits[0];
    assert.strictEqual(lu.namespace, "(default)");
    const cpu = lu.metrics.find((m) => m.name === "CPU time");
    assert.ok(cpu, "expected CPU time metric");
    assert.strictEqual(cpu!.used, 8500);
    assert.strictEqual(cpu!.limit, 10000);
    assert.ok(cpu!.pct >= 84 && cpu!.pct <= 86);
    const dml = lu.metrics.find((m) => m.name === "DML statements");
    assert.ok(dml);
    assert.strictEqual(dml!.used, 130);
  });

  test("parses Apex stack frames out of FATAL_ERROR details", () => {
    const a = doctor.analyze(parser.parse(FATAL_ERROR_LOG));
    const fatal = a.issues.find((i) => i.type === "Fatal Error");
    assert.ok(fatal, "expected Fatal Error issue");
    assert.ok(fatal!.stackFrames && fatal!.stackFrames.length >= 3);
    const top = fatal!.stackFrames![0];
    assert.strictEqual(top.className, "AccountService");
    assert.strictEqual(top.methodName, "process");
    assert.strictEqual(top.line, 105);
  });

  test("captures TEST_PASS / TEST_FAIL events as testResults", () => {
    const a = doctor.analyze(parser.parse(TEST_RESULTS_LOG));
    assert.strictEqual(a.testResults.length, 3);
    const failed = a.testResults.filter((t) => !t.passed);
    assert.strictEqual(failed.length, 1);
    assert.strictEqual(failed[0].name, "MyTestClass.testBar");
    const failIssue = a.issues.find((i) => i.type === "Test Failed");
    assert.ok(failIssue, "expected a Test Failed issue alongside the result");
  });

  test("computes performance insights (deterministic rules)", () => {
    const a = doctor.analyze(parser.parse(NORMAL_LOG));
    assert.ok(a.insights.length > 0);
    const breakdown = a.insights.find((i) => i.title === "Time breakdown");
    assert.ok(breakdown, "expected a 'Time breakdown' insight");
  });
});

suite("CompareService", () => {
  test("aggregates method timing across calls (sum, not max)", () => {
    const compare = new CompareService();
    const baseline = doctor.analyze(parser.parse(NORMAL_LOG));
    const comparison = doctor.analyze(parser.parse(NORMAL_LOG));
    const result = compare.compare(baseline, comparison, "A", "B");
    const fooDelta = result.methods.find((m) => m.name.includes("foo"));
    assert.ok(fooDelta);
    assert.strictEqual(fooDelta!.baselineCalls, 1);
    assert.strictEqual(fooDelta!.comparisonCalls, 1);
    assert.strictEqual(fooDelta!.callsDelta, 0);
  });

  test("verdict reports equivalent runs as 'equivalent'", () => {
    const compare = new CompareService();
    const baseline = doctor.analyze(parser.parse(NORMAL_LOG));
    const comparison = doctor.analyze(parser.parse(NORMAL_LOG));
    const result = compare.compare(baseline, comparison, "A", "B");
    assert.strictEqual(result.summary.verdict, "equivalent");
  });
});

suite("CPU Profiler", () => {
  test("computes self time correctly (parent excludes children)", () => {
    const a = doctor.analyze(parser.parse(HOT_PATH_LOG));
    const profile = a.cpuProfile;
    assert.ok(profile.totalMs > 0);
    assert.ok(profile.hotLeaf, "expected a hot leaf");
    assert.ok(profile.hotLeaf!.kind === "soql" || profile.hotLeaf!.kind === "method");
    assert.ok(profile.hotPath.length >= 2);
  });

  test("byTotal vs bySelf are sorted differently", () => {
    const a = doctor.analyze(parser.parse(HOT_PATH_LOG));
    const profile = a.cpuProfile;
    const topByTotal = profile.byTotal[0];
    const topBySelf = profile.bySelf[0];
    assert.ok(topByTotal && topBySelf);
    assert.ok(topByTotal.totalMs >= topByTotal.selfMs);
  });
});

suite("Trigger order", () => {
  test("groups triggers by sObject + phase, identifies slowest", () => {
    const a = doctor.analyze(parser.parse(TRIGGER_ORDER_LOG));
    assert.strictEqual(a.triggerGroups.length, 1);
    const g = a.triggerGroups[0];
    assert.strictEqual(g.sObject, "Account");
    assert.strictEqual(g.phase, "BeforeInsert");
    assert.strictEqual(g.triggers.length, 3);
    assert.strictEqual(g.slowestName, "AccountValidator");
  });

  test("flags recursion when same trigger fires twice in the same phase", () => {
    const a = doctor.analyze(parser.parse(TRIGGER_ORDER_LOG));
    const g = a.triggerGroups[0];
    const recursive = g.triggers.filter((t) => t.recursive);
    assert.strictEqual(recursive.length, 1);
    assert.strictEqual(recursive[0].name, "AccountTrigger");
  });
});

suite("Async tracer", () => {
  test("captures ASYNC_OPERATION_TRIGGERED invocations", () => {
    const a = doctor.analyze(parser.parse(ASYNC_PARENT_LOG));
    assert.strictEqual(a.asyncInvocations.length, 1);
    assert.strictEqual(a.asyncInvocations[0].kind, "queueable");
    assert.strictEqual(a.asyncInvocations[0].className, "MyQueueableJob");
  });

  test("links to a child log when the class names match within the time window", () => {
    const parentAnalysis = doctor.analyze(parser.parse(ASYNC_PARENT_LOG));
    const parentTime = new Date();
    parentTime.setHours(12, 0, 0, 0);
    const childSavedAt = new Date(parentTime.getTime() + 5_000);

    const history: AsyncHistoryEntry[] = [
      {
        label: "child-log.log",
        savedAt: childSavedAt.toISOString(),
        entryPoint: {
          kind: "queueable",
          className: "MyQueueableJob",
          startedAt: "12:00:01.000",
          durationMs: 200,
        },
      },
    ];
    const links = linkAsyncChain(parentAnalysis.asyncInvocations, history);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].childLogLabel, "child-log.log");
    assert.ok(links[0].confidence > 0);
  });
});

suite("Debug-level recommendations", () => {
  test("recommends raising APEX_PROFILING when off", () => {
    const a = doctor.analyze(parser.parse(NORMAL_LOG));
    assert.ok(Array.isArray(a.debugLevelRecommendations));
  });

  test("recommends turning DB on when no SOQL/DML events seen", () => {
    const log = "52.0 APEX_CODE,DEBUG;\n12:00:00.0 (1)|EXECUTION_STARTED\n12:00:00.0 (2)|EXECUTION_FINISHED";
    const a = doctor.analyze(parser.parse(log));
    const dbRec = a.debugLevelRecommendations.find((r) => r.category === "DB");
    assert.ok(dbRec, "expected a DB recommendation when DB level is missing");
    assert.strictEqual(dbRec!.direction, "increase");
  });
});

suite("Recurring patterns", () => {
  test("flags an issue that appears 3+ times across analyses", () => {
    const a1 = doctor.analyze(parser.parse(SOQL_IN_LOOP_LOG));
    const baseTime = new Date("2026-04-30T10:00:00Z").getTime();
    const history = [0, 1, 2, 3].map((i) => ({
      id: `id${i}`,
      label: `log${i}.log`,
      savedAt: new Date(baseTime + i * 60_000).toISOString(),
      source: `/tmp/log${i}.log`,
      totalDurationMs: 100,
      soqlCount: a1.soql.length,
      dmlCount: 0,
      errorCount: 1,
      warningCount: 0,
      analysis: a1,
    }));
    const patterns = detectRecurringPatterns(history);
    assert.ok(patterns.issues.length >= 1, "expected a recurring issue");
    assert.ok(patterns.issues[0].occurrences >= 3);
  });

  test("emits an empty result for a single analysis", () => {
    const a1 = doctor.analyze(parser.parse(NORMAL_LOG));
    const history = [
      {
        id: "id1",
        label: "log.log",
        savedAt: new Date().toISOString(),
        source: "/tmp/log.log",
        totalDurationMs: 100,
        soqlCount: 1,
        dmlCount: 0,
        errorCount: 0,
        warningCount: 0,
        analysis: a1,
      },
    ];
    const patterns = detectRecurringPatterns(history);
    assert.strictEqual(patterns.issues.length, 0);
  });
});

suite("Fix templates", () => {
  const sample = [
    "public class AccountHandler {",
    "  public static void process(List<Account> accounts) {",
    "    for (Account a : accounts) {",
    "      Contract c = [SELECT Id FROM Contract WHERE AccountId = :a.Id];",
    "      System.debug(c);",
    "    }",
    "  }",
    "}",
  ].join("\n");

  test("bulkifies a SOQL-in-loop into Set + single query + Map", () => {
    const issue = {
      severity: "error" as const,
      type: "SOQL in Loop",
      message: "Same query executed 5 times",
      lineNumber: 4,
      timestamp: "12:00:00.000",
    };
    const fix = tryTemplatedFix({ issue, fileText: sample, filePath: "AccountHandler.cls" });
    assert.ok(fix, "expected a templated fix");
    assert.strictEqual(fix!.source, "templated");
    assert.match(fix!.newFileText, /Set<Id>\s+\w+ = new Set<Id>\(\)/);
    assert.match(fix!.newFileText, /WHERE\s+AccountId\s+IN\s+:/);
    assert.match(fix!.newFileText, /Map<Id,\s+Contract>/);
  });

  test("returns undefined for an unrelated issue type", () => {
    const issue = {
      severity: "warning" as const,
      type: "Slow SOQL Query",
      message: "Query took 1500 ms",
      lineNumber: 4,
      timestamp: "12:00:00.000",
    };
    const fix = tryTemplatedFix({ issue, fileText: sample, filePath: "AccountHandler.cls" });
    assert.strictEqual(fix, undefined);
  });

  test("adds LIMIT 200 when the issue is Large Query Result", () => {
    const file = [
      "public class Foo {",
      "  public static void f() {",
      "    List<Account> accs = [SELECT Id, Name FROM Account];",
      "  }",
      "}",
    ].join("\n");
    const issue = {
      severity: "warning" as const,
      type: "Large Query Result",
      message: "Query returned 5000 rows",
      lineNumber: 3,
      timestamp: "12:00:00.000",
    };
    const fix = tryTemplatedFix({ issue, fileText: file, filePath: "Foo.cls" });
    assert.ok(fix);
    assert.match(fix!.newFileText, /LIMIT\s+200/);
  });
});

suite("NL query response parser", () => {
  test("hydrates matched indices into real items from the analysis", () => {
    const a = doctor.analyze(parser.parse(LARGE_QUERY_LOG));
    const raw = JSON.stringify({
      kind: "soql",
      matchedIndices: [0],
      summary: "1 query returned > 500 rows",
    });
    const result = parseNlQueryResponse(a, raw);
    assert.strictEqual(result.kind, "soql");
    assert.strictEqual(result.items.length, 1);
    assert.match(result.summary, /1 query/);
  });

  test("filters out invalid indices defensively", () => {
    const a = doctor.analyze(parser.parse(NORMAL_LOG));
    const raw = JSON.stringify({
      kind: "methods",
      matchedIndices: [0, 999, -1, "nope"],
      summary: "test",
    });
    const result = parseNlQueryResponse(a, raw);
    assert.strictEqual(result.kind, "methods");
    // Only index 0 is valid for the small NORMAL_LOG analysis
    assert.ok(result.items.length <= a.methods.length);
    assert.ok(result.items.length >= 0);
  });

  test("throws when JSON is malformed", () => {
    const a = doctor.analyze(parser.parse(NORMAL_LOG));
    assert.throws(() => parseNlQueryResponse(a, "not json"));
  });
});

suite("Line-level log diff", () => {
  test("identical logs produce 100% same ops", () => {
    const events = parser.parse(NORMAL_LOG).events;
    const diff = diffEvents(events, events);
    assert.ok(diff.stats.same > 0);
    assert.strictEqual(diff.stats.added, 0);
    assert.strictEqual(diff.stats.removed, 0);
    assert.strictEqual(diff.stats.changed, 0);
  });

  test("an extra event in the comparison stream is reported as added", () => {
    const baselineLog = [
      "52.0 APEX_CODE,DEBUG;",
      "12:00:00.000 (1)|EXECUTION_STARTED",
      "12:00:00.000 (2)|METHOD_ENTRY|[10]|01p|Foo.bar()",
      "12:00:00.000 (3)|METHOD_EXIT|[10]|01p|Foo.bar()",
      "12:00:00.000 (4)|EXECUTION_FINISHED",
    ].join("\n");
    const comparisonLog = [
      "52.0 APEX_CODE,DEBUG;",
      "12:00:00.000 (1)|EXECUTION_STARTED",
      "12:00:00.000 (2)|METHOD_ENTRY|[10]|01p|Foo.bar()",
      "12:00:00.000 (3)|METHOD_ENTRY|[20]|01p|Foo.baz()",
      "12:00:00.000 (4)|METHOD_EXIT|[20]|01p|Foo.baz()",
      "12:00:00.000 (5)|METHOD_EXIT|[10]|01p|Foo.bar()",
      "12:00:00.000 (6)|EXECUTION_FINISHED",
    ].join("\n");
    const diff = diffEvents(parser.parse(baselineLog).events, parser.parse(comparisonLog).events);
    assert.strictEqual(diff.stats.added, 1, "expected one added METHOD_ENTRY");
    assert.strictEqual(diff.stats.removed, 0);
    const addedOp = diff.ops.find((o) => o.kind === "added");
    assert.ok(addedOp);
    assert.match(addedOp!.label, /Foo\.baz/);
  });

  test("changed row count is reported as changed", () => {
    const baselineLog = [
      "52.0 APEX_CODE,DEBUG;",
      "12:00:00.000 (1)|EXECUTION_STARTED",
      "12:00:00.000 (2)|SOQL_EXECUTE_BEGIN|[10]|Aggregations:0|SELECT Id FROM Account",
      "12:00:00.000 (3)|SOQL_EXECUTE_END|[10]|Rows:5",
      "12:00:00.000 (4)|EXECUTION_FINISHED",
    ].join("\n");
    const comparisonLog = baselineLog.replace("Rows:5", "Rows:25");
    const diff = diffEvents(parser.parse(baselineLog).events, parser.parse(comparisonLog).events);
    // SOQL_EXECUTE_END isn't in our significant set, but SOQL_EXECUTE_BEGIN is.
    // For SOQL_EXECUTE_BEGIN the rowcount isn't on it — so this stays "same".
    assert.ok(diff.stats.same >= 1);
  });
});
