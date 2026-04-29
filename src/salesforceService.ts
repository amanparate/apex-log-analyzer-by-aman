import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const execAsync = promisify(exec);

export interface UserSummary {
  Id: string;
  Name: string;
  Username: string;
  Email: string;
  IsActive: boolean;
  Profile?: { Name: string };
}

export interface DebugLevel {
  Id: string;
  DeveloperName: string;
  ApexCode: string;
  ApexProfiling: string;
  Database: string;
  System: string;
  Validation: string;
  Visualforce: string;
  Workflow: string;
  Callout: string;
}
export interface TraceFlagInfo {
  Id: string;
  TracedEntityId: string;
  LogType: string;
  StartDate: string;
  ExpirationDate: string;
  DebugLevelId: string;
  // hydrated fields:
  userName?: string;
  userUsername?: string;
  debugLevelName?: string;
}

export interface UserInfo {
  Id: string;
  Name: string;
  Username: string;
  Email: string;
  Profile?: { Name: string };
}

export interface ApexLogRecord {
  Id: string;
  Application: string;
  DurationMilliseconds: number;
  Location: string;
  LogLength: number;
  LogUser: { Name: string };
  Operation: string;
  Request: string;
  StartTime: string;
  Status: string;
}

export class SalesforceService {
  async getDefaultOrg(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("sf config get target-org --json");
      const parsed = JSON.parse(stdout);
      return parsed?.result?.[0]?.value;
    } catch {
      return undefined;
    }
  }

  /** Recent Apex logs from the org — for the picker. */
  async listRecentLogs(
    limit = 20,
    targetOrg?: string,
  ): Promise<ApexLogRecord[]> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found. Run: sf org login web");
    }

    const soql = `SELECT Id, Application, DurationMilliseconds, Location, LogLength, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog ORDER BY StartTime DESC LIMIT ${limit}`;
    const { stdout } = await execAsync(
      `sf data query --query "${soql}" --use-tooling-api --target-org ${org} --json`,
    );
    const res = JSON.parse(stdout);
    return res?.result?.records ?? [];
  }

  async searchUsers(
    query: string,
    limit = 20,
    targetOrg?: string,
  ): Promise<UserSummary[]> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found.");
    }
    const safe = query.replace(/'/g, "\\'");
    const soql = `SELECT Id, Name, Username, Email, IsActive, Profile.Name FROM User WHERE IsActive = true AND (Name LIKE '%${safe}%' OR Email LIKE '%${safe}%' OR Username LIKE '%${safe}%') ORDER BY Name ASC LIMIT ${limit}`;
    const { stdout } = await execAsync(
      `sf data query --query "${soql}" --target-org ${org} --json`,
      { maxBuffer: 5 * 1024 * 1024 },
    );
    return JSON.parse(stdout)?.result?.records ?? [];
  }

  async listDebugLevels(targetOrg?: string): Promise<DebugLevel[]> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found.");
    }
    const soql = `SELECT Id, DeveloperName, ApexCode, ApexProfiling, Database, System, Validation, Visualforce, Workflow, Callout FROM DebugLevel ORDER BY DeveloperName`;
    const { stdout } = await execAsync(
      `sf data query --query "${soql}" --use-tooling-api --target-org ${org} --json`,
    );
    return JSON.parse(stdout)?.result?.records ?? [];
  }

  async listActiveTraceFlags(targetOrg?: string): Promise<TraceFlagInfo[]> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found.");
    }
    // Use a small backstep to avoid clock-skew making just-created flags look expired
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const soql = `SELECT Id, TracedEntityId, LogType, StartDate, ExpirationDate, DebugLevelId FROM TraceFlag WHERE ExpirationDate > ${cutoff} AND LogType = 'USER_DEBUG' ORDER BY ExpirationDate DESC`;
    const { stdout } = await execAsync(
      `sf data query --query "${soql}" --use-tooling-api --target-org ${org} --json`,
    );
    const flags: TraceFlagInfo[] = JSON.parse(stdout)?.result?.records ?? [];
    if (!flags.length) {
      return [];
    }

    // Hydrate user names + debug level names in parallel
    const userIds = [
      ...new Set(flags.map((f) => f.TracedEntityId).filter(Boolean)),
    ];
    const dbgIds = [
      ...new Set(flags.map((f) => f.DebugLevelId).filter(Boolean)),
    ];

    const [users, dbgLevels] = await Promise.all([
      this.queryUsersByIds(userIds, org),
      this.queryDebugLevelsByIds(dbgIds, org),
    ]);
    const userById = new Map(users.map((u) => [u.Id, u]));
    const dbgById = new Map(dbgLevels.map((d) => [d.Id, d]));

    for (const f of flags) {
      const u = userById.get(f.TracedEntityId);
      if (u) {
        f.userName = u.Name;
        f.userUsername = u.Username;
      }
      const d = dbgById.get(f.DebugLevelId);
      if (d) {
        f.debugLevelName = d.DeveloperName;
      }
    }
    return flags;
  }

  private async queryUsersByIds(
    ids: string[],
    org: string,
  ): Promise<UserSummary[]> {
    if (!ids.length) {
      return [];
    }
    const list = ids.map((id) => `'${id}'`).join(",");
    const soql = `SELECT Id, Name, Username, Email, IsActive FROM User WHERE Id IN (${list})`;
    const { stdout } = await execAsync(
      `sf data query --query "${soql}" --target-org ${org} --json`,
    );
    return JSON.parse(stdout)?.result?.records ?? [];
  }

  private async queryDebugLevelsByIds(
    ids: string[],
    org: string,
  ): Promise<DebugLevel[]> {
    if (!ids.length) {
      return [];
    }
    const list = ids.map((id) => `'${id}'`).join(",");
    const soql = `SELECT Id, DeveloperName FROM DebugLevel WHERE Id IN (${list})`;
    const { stdout } = await execAsync(
      `sf data query --query "${soql}" --use-tooling-api --target-org ${org} --json`,
    );
    return JSON.parse(stdout)?.result?.records ?? [];
  }

  async createTraceFlag(
    userId: string,
    debugLevelId: string,
    durationMinutes: number,
    targetOrg?: string,
  ): Promise<{ id: string }> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found.");
    }
    if (durationMinutes > 1440) {
      throw new Error("Max trace flag duration is 24 hours.");
    }
    const start = new Date(Date.now() - 60_000).toISOString(); // backdate slightly to avoid "future" rejection
    const end = new Date(Date.now() + durationMinutes * 60_000).toISOString();
    const values = `TracedEntityId=${userId} DebugLevelId=${debugLevelId} LogType=USER_DEBUG StartDate=${start} ExpirationDate=${end}`;
    const { stdout } = await execAsync(
      `sf data create record --sobject TraceFlag --values "${values}" --use-tooling-api --target-org ${org} --json`,
    );
    const res = JSON.parse(stdout);
    if (!res?.result?.id) {
      throw new Error(res?.message || "Trace flag creation failed.");
    }
    return { id: res.result.id };
  }

  async deleteTraceFlag(flagId: string, targetOrg?: string): Promise<void> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found.");
    }
    await execAsync(
      `sf data delete record --sobject TraceFlag --record-id ${flagId} --use-tooling-api --target-org ${org} --json`,
    );
  }

  async extendTraceFlag(
    flagId: string,
    currentExpirationIso: string,
    additionalMinutes: number,
    targetOrg?: string,
  ): Promise<{ newExpirationIso: string }> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found.");
    }
    const current = new Date(currentExpirationIso).getTime();
    const proposed = current + additionalMinutes * 60_000;
    const maxAllowed = Date.now() + 24 * 60 * 60_000;
    const cappedMs = Math.min(proposed, maxAllowed);
    const newIso = new Date(cappedMs).toISOString();
    const values = `ExpirationDate=${newIso}`;
    await execAsync(
      `sf data update record --sobject TraceFlag --record-id ${flagId} --values "${values}" --use-tooling-api --target-org ${org} --json`,
    );
    return { newExpirationIso: newIso };
  }

  /** Download a log's body to a temp file. Returns the file path. */
  async downloadLog(logId: string, targetOrg?: string): Promise<string> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found. Run: sf org login web");
    }

    // sf apex get log outputs the body to stdout
    const { stdout } = await execAsync(
      `sf apex get log --log-id ${logId} --target-org ${org}`,
      { maxBuffer: 50 * 1024 * 1024 }, // 50MB in case of huge logs
    );

    // Persist to an OS temp file named with the log ID so filename-extraction picks it up
    const tmpDir = path.join(os.tmpdir(), "apex-log-analyzer-by-aman");
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `${logId}.log`);
    fs.writeFileSync(filePath, stdout, "utf8");
    return filePath;
  }

  async fetchUserForLogId(
    logId: string,
    targetOrg?: string,
  ): Promise<UserInfo | undefined> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found. Run: sf org login web");
    }

    const logSoql = `SELECT LogUserId FROM ApexLog WHERE Id = '${logId}'`;
    const { stdout: logOut } = await execAsync(
      `sf data query --query "${logSoql}" --use-tooling-api --target-org ${org} --json`,
    );
    const logRes = JSON.parse(logOut);
    const userId = logRes?.result?.records?.[0]?.LogUserId;
    if (!userId) {
      return undefined;
    }

    const userSoql = `SELECT Id, Name, Username, Email, Profile.Name FROM User WHERE Id = '${userId}'`;
    const { stdout: userOut } = await execAsync(
      `sf data query --query "${userSoql}" --target-org ${org} --json`,
    );
    const userRes = JSON.parse(userOut);
    return userRes?.result?.records?.[0];
  }

  /** Look for a 07L... ID in the filename. (Body text almost never contains it.) */
  extractLogIdFromFilename(filename: string): string | undefined {
    const base = path.basename(filename);
    const match = /07L[a-zA-Z0-9]{12,15}/.exec(base);
    return match?.[0];
  }
  /** Retrieve an Apex class from the org into the local SFDX project. */
  async retrieveClass(className: string, targetOrg?: string): Promise<void> {
    const org = targetOrg || (await this.getDefaultOrg());
    if (!org) {
      throw new Error("No default Salesforce org found. Run: sf org login web");
    }

    // sf project retrieve start --metadata ApexClass:ClassName
    await execAsync(
      `sf project retrieve start --metadata ApexClass:${className} --target-org ${org} --json`,
      { maxBuffer: 10 * 1024 * 1024 },
    );
  }
}
