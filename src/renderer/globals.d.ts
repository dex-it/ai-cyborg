import type * as Monaco from 'monaco-editor';
import type { CyborgApi } from '../main/preload';

declare global {
  interface Window {
    cyborg: CyborgApi;
    monaco?: typeof Monaco;
    require: { config(options: unknown): void; (deps: string[], onLoad: () => void, onError?: (e: unknown) => void): void };
  }
}
