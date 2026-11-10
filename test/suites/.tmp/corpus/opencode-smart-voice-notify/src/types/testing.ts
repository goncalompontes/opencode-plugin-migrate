import type {
  AppClient,
  OpenCodeClient,
  PermissionClient,
  QuestionClient,
  Session,
  SessionClient,
  ShellExecution,
  ShellResult,
  TUIClient,
} from './opencode-sdk.js';

export interface ShellCallRecord {
  command: string;
  timestamp: number;
}

export interface MockShellResult extends Promise<ShellResult> {
  quiet(): this;
  nothrow(): this;
  timeout(milliseconds?: number): this;
}

export interface MockShellRunner {
  (strings: TemplateStringsArray, ...values: Array<unknown>): ShellExecution | MockShellResult;
  getCalls(): ShellCallRecord[];
  getLastCall(): ShellCallRecord | undefined;
  getCallCount(): number;
  reset(): void;
  wasCalledWith(pattern: string | RegExp): boolean;
}

export interface ToastBody {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
}

export interface ToastCall extends ToastBody {
  timestamp: number;
}

export interface MockSession extends Session {
  status?: string;
  parentID?: string | null;
}

export interface MockClient extends OpenCodeClient {
  tui: TUIClient & {
    getToastCalls(): ToastCall[];
    resetToastCalls(): void;
  };
  session: SessionClient & {
    setMockSession(id: string, data: Partial<MockSession>): void;
    clearMockSessions(): void;
  };
  app?: AppClient;
  permission?: PermissionClient;
  question?: QuestionClient;
}

export type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

export type ConsoleCaptureStore = Record<ConsoleMethod, unknown[][]>;

export interface ConsoleCapture {
  start(): void;
  stop(): void;
  get(): ConsoleCaptureStore;
  get(type: ConsoleMethod): unknown[][];
  clear(): void;
}
