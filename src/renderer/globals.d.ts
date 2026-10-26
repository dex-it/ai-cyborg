import type * as Monaco from 'monaco-editor';
import type { CyborgApi } from '../main/preload';

declare global {
  const __APP_VERSION__: string;

  interface Window {
    cyborg: CyborgApi;
    monaco?: typeof Monaco;
    require: { config(options: unknown): void; (deps: string[], onLoad: () => void, onError?: (e: unknown) => void): void };
  }
}
