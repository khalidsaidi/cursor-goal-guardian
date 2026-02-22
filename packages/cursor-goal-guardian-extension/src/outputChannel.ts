import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export class AuditOutputChannel {
  private _outputChannel: vscode.OutputChannel;
  private _lastLineCount = 0;
  private _refreshInterval?: NodeJS.Timeout;
  private _disposed = false;

  constructor() {
    this._outputChannel = vscode.window.createOutputChannel("Goal Guardian Audit");
  }

  public show() {
    this._outputChannel.show(true);
    this._refresh();

    // Start auto-refresh when shown
    if (!this._refreshInterval) {
      this._refreshInterval = setInterval(() => {
        if (!this._disposed) {
          this._refreshTail();
        }
      }, 2000);
    }
  }

  public dispose() {
    this._disposed = true;
    if (this._refreshInterval) {
      clearInterval(this._refreshInterval);
    }
    this._outputChannel.dispose();
  }

  public async refresh() {
    this._refresh();
  }

  private async _refresh() {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) {
      this._outputChannel.clear();
      this._outputChannel.appendLine("No workspace open.");
      return;
    }

    const auditPath = path.join(workspaceRoot, ".ai", "goal-guardian", "audit.log");

    try {
      const content = await fs.readFile(auditPath, "utf8");
      const lines = content.trim().split("\n");
      this._lastLineCount = lines.length;

      this._outputChannel.clear();
      this._outputChannel.appendLine("=== Goal Guardian Audit Log ===");
      this._outputChannel.appendLine(`File: ${auditPath}`);
      this._outputChannel.appendLine(`Total entries: ${lines.length}`);
      this._outputChannel.appendLine("---");
      this._outputChannel.appendLine("");

      // Show last 100 entries, most recent first
      const recentLines = lines.slice(-100).reverse();

      for (const line of recentLines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          this._outputChannel.appendLine(this._formatEntry(entry));
        } catch {
          this._outputChannel.appendLine(line);
        }
      }
    } catch (err) {
      this._outputChannel.clear();
      this._outputChannel.appendLine("=== Goal Guardian Audit Log ===");
      this._outputChannel.appendLine("");
      this._outputChannel.appendLine("No audit log found.");
      this._outputChannel.appendLine("Audit entries will appear here after Goal Guardian processes actions.");
    }
  }

  private async _refreshTail() {
    const workspaceRoot = this._getWorkspaceRoot();
    if (!workspaceRoot) return;

    const auditPath = path.join(workspaceRoot, ".ai", "goal-guardian", "audit.log");

    try {
      const content = await fs.readFile(auditPath, "utf8");
      const lines = content.trim().split("\n");
      const newLineCount = lines.length;

      if (newLineCount > this._lastLineCount) {
        // Append only new lines
        const newLines = lines.slice(this._lastLineCount);
        this._lastLineCount = newLineCount;

        this._outputChannel.appendLine("");
        this._outputChannel.appendLine("--- New entries ---");

        for (const line of newLines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            this._outputChannel.appendLine(this._formatEntry(entry));
          } catch {
            this._outputChannel.appendLine(line);
          }
        }
      }
    } catch {
      // File may not exist yet
    }
  }

  private _formatEntry(entry: any): string {
    const ts = entry.ts ? new Date(entry.ts).toLocaleTimeString() : "??:??:??";
    const event = entry.event ?? "unknown";

    let details = "";

    switch (event) {
      case "shellHighRisk":
      case "shellBlocked":
      case "shellWarning":
      case "shellDenied":
      case "shellWarningLimit":
      case "shellPermitSuggested":
        details = `cmd="${entry.command ?? "?"}" severity=${entry.severity ?? "?"} reason="${entry.reason ?? ""}"`;
        if (entry.warningCount !== undefined) {
          details += ` warnings=${entry.warningCount}/${entry.maxWarnings ?? 3}`;
        }
        break;
      case "mcpHighRisk":
      case "mcpBlocked":
      case "mcpWarning":
      case "mcpDenied":
      case "mcpWarningLimit":
      case "mcpPermitSuggested":
        details = `mcp="${entry.mcpKey ?? "?"}" severity=${entry.severity ?? "?"}`;
        break;
      case "readHighRisk":
      case "readBlocked":
      case "readWarning":
      case "readDenied":
      case "readWarningLimit":
      case "readPermitSuggested":
        details = `file="${entry.filePath ?? "?"}" severity=${entry.severity ?? "?"}`;
        break;
      case "autoRevert":
        details = `file="${entry.file_path ?? "?"}" reverted=${entry.reverted ?? false}`;
        break;
      case "beforeShellExecution":
      case "beforeMCPExecution":
      case "beforeReadFile":
      case "afterFileEdit":
        details = `conv=${entry.conversation_id?.substring(0, 8) ?? "?"}`;
        break;
      default:
        details = JSON.stringify(entry).substring(0, 80);
    }

    const icon = this._getEventIcon(event);
    return `${ts} ${icon} [${event}] ${details}`;
  }

  private _getEventIcon(event: string): string {
    if (event.includes("HighRisk")) return "[!]";
    if (event.includes("Blocked")) return "[X]";
    if (event.includes("Warning")) return "[!]";
    if (event.includes("Denied")) return "[-]";
    if (event.includes("autoRevert")) return "[R]";
    return "[.]";
  }

  private _getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0]?.uri.fsPath ?? null;
  }
}
