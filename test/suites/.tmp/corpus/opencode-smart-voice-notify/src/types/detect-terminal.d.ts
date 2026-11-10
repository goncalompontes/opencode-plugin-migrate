declare module 'detect-terminal' {
  export interface DetectTerminalOptions {
    preferOuter?: boolean;
  }

  export default function detectTerminal(options?: DetectTerminalOptions): string | null;
}
