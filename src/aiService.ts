import * as vscode from "vscode";
import * as https from "https";
import { Analysis, Issue } from "./analyzer";

const API_VERSION_ANTHROPIC = "2023-06-01";
const SECRET_KEY = "apexDoctor.apiKey";

type Provider = "openrouter" | "anthropic" | "openai" | "gemini";

interface ProviderConfig {
  label: string;
  keyHint: string;
  validateKey: (key: string) => string | null;
  defaultModel: string;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  openrouter: {
    label: "OpenRouter",
    keyHint: "Starts with sk-or-. Get one FREE at openrouter.ai/keys",
    validateKey: (k) =>
      k.startsWith("sk-or-") ? null : "Must start with sk-or-",
    defaultModel: "openrouter/free",
  },
  anthropic: {
    label: "Anthropic (Claude)",
    keyHint: "Starts with sk-ant-. Get one at console.anthropic.com",
    validateKey: (k) =>
      k.startsWith("sk-ant-") ? null : "Must start with sk-ant-",
    defaultModel: "claude-sonnet-4-5",
  },
  openai: {
    label: "OpenAI (ChatGPT)",
    keyHint: "Starts with sk-. Get one at platform.openai.com/api-keys",
    validateKey: (k) => {
      if (!k.startsWith("sk-")) {
        return "Must start with sk-";
      }
      if (k.startsWith("sk-or-") || k.startsWith("sk-ant-")) {
        return "That looks like an OpenRouter or Anthropic key — change provider in settings first";
      }
      return null;
    },
    defaultModel: "gpt-4o-mini",
  },
  gemini: {
    label: "Google Gemini",
    keyHint: "Starts with AIza. Get one FREE at aistudio.google.com/apikey",
    validateKey: (k) => (k.startsWith("AIza") ? null : "Must start with AIza"),
    defaultModel: "gemini-2.0-flash",
  },
};

export class AiService {
  constructor(private secrets: vscode.SecretStorage) {}

  private getProvider(): Provider {
    const config = vscode.workspace.getConfiguration("apexDoctor");
    const p = (config.get<string>("provider") || "openrouter") as Provider;
    return PROVIDERS[p] ? p : "openrouter";
  }

  async setApiKey(): Promise<boolean> {
    const provider = this.getProvider();
    const cfg = PROVIDERS[provider];

    const key = await vscode.window.showInputBox({
      prompt: `Enter your ${cfg.label} API key. ${cfg.keyHint}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v ? cfg.validateKey(v) : "API key is required"),
    });
    if (!key) {
      return false;
    }
    await this.secrets.store(SECRET_KEY, key);
    vscode.window.showInformationMessage(
      `${cfg.label} API key saved securely.`,
    );
    return true;
  }

  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage("API key cleared.");
  }

  private async getApiKey(): Promise<string | undefined> {
    let key = await this.secrets.get(SECRET_KEY);
    if (!key) {
      const set = await this.setApiKey();
      if (set) {
        key = await this.secrets.get(SECRET_KEY);
      }
    }
    return key;
  }

  /**
   * Distilled, token-efficient context. We do NOT send the raw log.
   */
  buildContext(analysis: Analysis, focusIssue?: Issue): string {
    const lines: string[] = [];
    lines.push(`API Version: ${analysis.summary.apiVersion}`);
    lines.push(
      `Total runtime: ${analysis.summary.totalDurationMs.toFixed(2)} ms`,
    );
    lines.push(
      `SOQL count: ${analysis.soql.length}, DML count: ${analysis.dml.length}`,
    );
    if (analysis.userInfo) {
      lines.push(
        `Executed by: ${analysis.userInfo.Name} (${analysis.userInfo.ProfileName ?? "no profile"})`,
      );
    }
    lines.push("");

    if (focusIssue) {
      lines.push("## ISSUE TO EXPLAIN");
      lines.push(
        `[${focusIssue.severity.toUpperCase()}] ${focusIssue.type} @ line ${focusIssue.lineNumber ?? "?"}`,
      );
      lines.push(focusIssue.message);
      lines.push("");
    } else {
      lines.push("## ALL ISSUES DETECTED");
      for (const i of analysis.issues.slice(0, 10)) {
        lines.push(
          `[${i.severity.toUpperCase()}] ${i.type}${i.lineNumber ? " (line " + i.lineNumber + ")" : ""}: ${i.message.slice(0, 300)}`,
        );
      }
      lines.push("");
    }

    const relevantDebugs = analysis.debugs.slice(-15);
    if (relevantDebugs.length) {
      lines.push("## LAST DEBUG STATEMENTS BEFORE FAILURE");
      for (const d of relevantDebugs) {
        lines.push(
          `line ${d.lineNumber ?? "?"} [${d.level}]: ${d.message.slice(0, 200)}`,
        );
      }
      lines.push("");
    }

    if (analysis.methods.length) {
      lines.push("## TOP 10 SLOWEST METHODS");
      for (const m of analysis.methods.slice(0, 10)) {
        lines.push(
          `${m.name} — ${m.durationMs.toFixed(2)} ms (line ${m.lineNumber ?? "?"})`,
        );
      }
      lines.push("");
    }

    if (analysis.soql.length) {
      lines.push("## SOQL QUERIES (up to 15)");
      for (const q of analysis.soql.slice(0, 15)) {
        lines.push(
          `line ${q.lineNumber ?? "?"} (${q.rows ?? "?"} rows, ${(q.durationMs ?? 0).toFixed(2)} ms): ${q.query.slice(0, 250)}`,
        );
      }
      lines.push("");
    }

    if (analysis.dml.length) {
      lines.push("## DML OPERATIONS");
      for (const d of analysis.dml.slice(0, 10)) {
        lines.push(
          `${d.operation} line ${d.lineNumber ?? "?"}: ${d.rows ?? "?"} rows, ${(d.durationMs ?? 0).toFixed(2)} ms`,
        );
      }
      lines.push("");
    }

    if (analysis.limits.length) {
      lines.push("## GOVERNOR LIMITS (raw)");
      lines.push(analysis.limits[analysis.limits.length - 1].slice(0, 1500));
    }

    return lines.join("\n");
  }

  private buildPrompt(analysis: Analysis, focusIssue?: Issue): string {
    const context = this.buildContext(analysis, focusIssue);
    const task = focusIssue
      ? `Explain the root cause of the specific issue flagged above, and recommend a concrete fix.`
      : `Summarise the root cause of the failure(s) in this Apex log and recommend concrete fixes.`;

    return `You are a senior Salesforce Apex developer helping debug a failing transaction. You will be given structured excerpts from a Salesforce Apex debug log.

${task}

Respond in this exact markdown structure:

**Root Cause**
A 2-3 sentence plain-English explanation of what actually went wrong and why.

**Where it broke**
The class/method and line number, if identifiable.

**Likely Fix**
A concrete, actionable recommendation. If code changes are needed, show a short Apex snippet (5-15 lines max).

**Prevention**
One or two practices that would prevent this class of issue recurring.

Be direct. No filler, no restating what the user already sees.

---
LOG CONTEXT:

${context}`;
  }

  async streamExplanation(
    analysis: Analysis,
    focusIssue: Issue | undefined,
    onChunk: (text: string) => void,
    onDone: (fullText: string) => void,
    onError: (err: string) => void,
  ): Promise<void> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      onError("No API key provided.");
      return;
    }

    const config = vscode.workspace.getConfiguration("apexDoctor");
    const provider = this.getProvider();

    // Defensive: catch the case where the saved key doesn't match the current provider
    const validation = PROVIDERS[provider].validateKey(apiKey);
    if (validation) {
      onError(
        `Saved API key doesn't match provider "${provider}": ${validation}. Run "Apex Doctor: Clear LLM API Key" then "Set LLM API Key", or change the provider in settings.`,
      );
      return;
    }

    const model = config.get<string>("model") || PROVIDERS[provider].defaultModel;
    const maxTokens = config.get<number>("maxTokens") || 1500;
    const prompt = this.buildPrompt(analysis, focusIssue);

    switch (provider) {
      case "anthropic":
        return this.streamAnthropic(apiKey, model, maxTokens, prompt, onChunk, onDone, onError);
      case "openrouter":
        return this.streamOpenAICompat(
          {
            host: "openrouter.ai",
            path: "/api/v1/chat/completions",
            extraHeaders: {
              "HTTP-Referer": "https://github.com/amanparate/apex-doctor",
              "X-Title": "Apex Doctor",
            },
          },
          apiKey, model, maxTokens, prompt, onChunk, onDone, onError,
        );
      case "openai":
        return this.streamOpenAICompat(
          { host: "api.openai.com", path: "/v1/chat/completions" },
          apiKey, model, maxTokens, prompt, onChunk, onDone, onError,
        );
      case "gemini":
        return this.streamGemini(apiKey, model, maxTokens, prompt, onChunk, onDone, onError);
    }
  }

  private streamAnthropic(
    apiKey: string,
    model: string,
    maxTokens: number,
    prompt: string,
    onChunk: (t: string) => void,
    onDone: (t: string) => void,
    onError: (e: string) => void,
  ) {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    });
    const req = https.request(
      {
        host: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION_ANTHROPIC,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c) => (errBody += c.toString()));
          res.on("end", () => onError(`HTTP ${res.statusCode}: ${errBody}`));
          return;
        }
        let buffer = "";
        let fullText = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (!line.startsWith("data:")) {
                continue;
              }
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") {
                continue;
              }
              try {
                const evt = JSON.parse(payload);
                if (
                  evt.type === "content_block_delta" &&
                  evt.delta?.type === "text_delta" &&
                  typeof evt.delta.text === "string"
                ) {
                  fullText += evt.delta.text;
                  onChunk(evt.delta.text);
                }
              } catch {
                /* ignore */
              }
            }
          }
        });
        res.on("end", () => onDone(fullText));
      },
    );
    req.on("error", (e) => onError(e.message));
    req.write(body);
    req.end();
  }

  /** Shared OpenAI-compatible SSE handler — used for both OpenRouter and OpenAI */
  private streamOpenAICompat(
    target: { host: string; path: string; extraHeaders?: Record<string, string> },
    apiKey: string,
    model: string,
    maxTokens: number,
    prompt: string,
    onChunk: (t: string) => void,
    onDone: (t: string) => void,
    onError: (e: string) => void,
  ) {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    });
    const req = https.request(
      {
        host: target.host,
        path: target.path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
          ...(target.extraHeaders || {}),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c) => (errBody += c.toString()));
          res.on("end", () => onError(`HTTP ${res.statusCode}: ${errBody}`));
          return;
        }
        let buffer = "";
        let fullText = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (!line.startsWith("data:")) {
                continue;
              }
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") {
                continue;
              }
              try {
                const evt = JSON.parse(payload);
                const delta = evt.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  fullText += delta;
                  onChunk(delta);
                }
              } catch {
                /* ignore keepalives / malformed */
              }
            }
          }
        });
        res.on("end", () => onDone(fullText));
      },
    );
    req.on("error", (e) => onError(e.message));
    req.write(body);
    req.end();
  }

  private streamGemini(
    apiKey: string,
    model: string,
    maxTokens: number,
    prompt: string,
    onChunk: (t: string) => void,
    onDone: (t: string) => void,
    onError: (e: string) => void,
  ) {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    });
    const req = https.request(
      {
        host: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let errBody = "";
          res.on("data", (c) => (errBody += c.toString()));
          res.on("end", () => onError(`HTTP ${res.statusCode}: ${errBody}`));
          return;
        }
        let buffer = "";
        let fullText = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            for (const line of part.split("\n")) {
              if (!line.startsWith("data:")) {
                continue;
              }
              const payload = line.slice(5).trim();
              if (!payload) {
                continue;
              }
              try {
                const evt = JSON.parse(payload);
                const text = evt.candidates?.[0]?.content?.parts?.[0]?.text;
                if (typeof text === "string" && text.length > 0) {
                  fullText += text;
                  onChunk(text);
                }
              } catch {
                /* ignore */
              }
            }
          }
        });
        res.on("end", () => onDone(fullText));
      },
    );
    req.on("error", (e) => onError(e.message));
    req.write(body);
    req.end();
  }
}