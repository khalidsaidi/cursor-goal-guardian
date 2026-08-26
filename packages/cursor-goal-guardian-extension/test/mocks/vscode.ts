/**
 * Minimal vscode API stub for plain-vitest extension tests. Records enough to
 * assert the activation surface and the inertness/quietness contracts.
 */
import path from "node:path";

export const recorded = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  executed: [] as string[],
  windowMessages: [] as Array<{ kind: string; message: string }>,
  watchers: [] as string[],
  reset(): void {
    this.commands.clear();
    this.executed.length = 0;
    this.windowMessages.length = 0;
    this.watchers.length = 0;
    workspace.workspaceFolders = undefined;
    responses.warning = undefined;
    responses.information = undefined;
    responses.inputBox = [];
    responses.quickPick = [];
  },
};

export const responses: {
  warning: string | undefined;
  information: string | undefined;
  inputBox: Array<string | undefined>;
  quickPick: Array<string | undefined>;
} = { warning: undefined, information: undefined, inputBox: [], quickPick: [] };

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return { dispose: () => void 0 };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class RelativePattern {
  constructor(
    public readonly base: string,
    public readonly pattern: string,
  ) {}
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => Uri.file(path.join(base.fsPath, ...parts)),
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

function watcherStub(pattern: RelativePattern) {
  recorded.watchers.push(pattern.pattern);
  return {
    onDidChange: () => ({ dispose: () => void 0 }),
    onDidCreate: () => ({ dispose: () => void 0 }),
    onDidDelete: () => ({ dispose: () => void 0 }),
    dispose: () => void 0,
  };
}

export const workspace: {
  workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  getConfiguration: (section?: string) => { get<T>(key: string, fallback: T): T };
  createFileSystemWatcher: typeof watcherStub;
  onDidSaveTextDocument: (listener: unknown) => { dispose(): void };
} = {
  workspaceFolders: undefined,
  getConfiguration: () => ({ get: <T,>(_key: string, fallback: T): T => fallback }),
  createFileSystemWatcher: watcherStub,
  onDidSaveTextDocument: () => ({ dispose: () => void 0 }),
};

export const window = {
  registerWebviewViewProvider: () => ({ dispose: () => void 0 }),
  createStatusBarItem: () => ({
    text: "",
    tooltip: "",
    command: undefined as unknown,
    backgroundColor: undefined as unknown,
    show: () => void 0,
    hide: () => void 0,
    dispose: () => void 0,
  }),
  showWarningMessage: (message: string): Promise<string | undefined> => {
    recorded.windowMessages.push({ kind: "warning", message });
    return Promise.resolve(responses.warning);
  },
  showInformationMessage: (message: string): Promise<string | undefined> => {
    recorded.windowMessages.push({ kind: "information", message });
    return Promise.resolve(responses.information);
  },
  showInputBox: (): Promise<string | undefined> => Promise.resolve(responses.inputBox.shift()),
  showQuickPick: (): Promise<string | undefined> => Promise.resolve(responses.quickPick.shift()),
  showTextDocument: () => Promise.resolve(),
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    recorded.commands.set(id, handler);
    return { dispose: () => void 0 };
  },
  executeCommand: (id: string, ...args: unknown[]): Promise<unknown> => {
    recorded.executed.push(id);
    const handler = recorded.commands.get(id);
    return Promise.resolve(handler ? handler(...args) : undefined);
  },
};

export function makeContext(extensionPath = "/tmp/gg-ext"): {
  subscriptions: Array<{ dispose(): void }>;
  workspaceState: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Promise<void> };
  extensionPath: string;
  extensionUri: { fsPath: string };
  extension: { packageJSON: { version: string } };
} {
  const store = new Map<string, unknown>();
  return {
    subscriptions: [],
    workspaceState: {
      get: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
      update: (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    extensionPath,
    extensionUri: { fsPath: extensionPath },
    extension: { packageJSON: { version: "1.0.0-rc.0" } },
  };
}

export const env = { remoteName: "wsl" };
