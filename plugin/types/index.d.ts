export type LimitsWindow = { kind: string; percent: number; resetsAt?: string }
export type LimitsReading = { windows: LimitsWindow[]; context?: number }

declare module 'claude-code' {
  interface PluginState {
    cyborg: { limitsReading: LimitsReading | null; limitsNow: number }
  }
}
