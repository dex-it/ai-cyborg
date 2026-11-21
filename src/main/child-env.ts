// Единственное место, где собирается окружение дочернего процесса: унаследованное, поверх него управляемое (окно «Окружение»), поверх него собственные значения Cyborg.

export interface Overlay {
  set: ReadonlyMap<string, string>;
  unset: ReadonlySet<string>;
}

/** Собственные значения Cyborg для вызова: перебивают управляемые; одно имя в set и unset - побеждает set. */
export interface Own {
  set?: Readonly<Record<string, string | undefined>>;
  unset?: readonly string[];
}

/** Отметка окружения сессии при запуске: свёртки значений управляемых имён, сами значения не хранятся. */
export interface EnvStamp {
  digests: Map<string, string>;
  remote: boolean;
}

/** Управляемое окружение, как его видят запускающие код места. */
export interface EnvPort {
  overlay(): Overlay;
  ready(): Promise<void>;
  stamp(remote: boolean): EnvStamp;
  /** Имена, значение которых для процесса стало другим, чем при запуске сессии с этой отметкой. */
  stale(stamp: EnvStamp): string[];
}

export const NO_OVERLAY: Overlay = { set: new Map(), unset: new Set() };

export function composeEnv(base: NodeJS.ProcessEnv, overlay: Overlay, own: Own = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value;
  for (const name of overlay.unset) delete env[name];
  for (const [name, value] of overlay.set) env[name] = value;
  for (const name of own.unset ?? []) delete env[name];
  for (const [name, value] of Object.entries(own.set ?? {})) if (value !== undefined) env[name] = value;
  return env;
}

const EMPTY: EnvPort = { overlay: () => NO_OVERLAY, ready: () => Promise.resolve(), stamp: (remote) => ({ digests: new Map(), remote }), stale: () => [] };

let provider: EnvPort = EMPTY;

/** main.ts подключает управляемое окружение один раз; без подключения (демон на хосте, тесты) overlay пуст. */
export function useManagedEnv(next: EnvPort | null): void {
  provider = next ?? EMPTY;
}

export const envStampNow = (remote: boolean): EnvStamp => provider.stamp(remote);

export const staleNames = (stamp: EnvStamp): string[] => provider.stale(stamp);

export const envReady = (): Promise<void> => provider.ready();

export const currentOverlay = (): Overlay => provider.overlay();

/** Окружение процесса, который запускается сейчас; вызывающий уже дождался envReady(). process.env не меняется никогда. */
export function childEnvNow(own?: Own): Record<string, string> {
  return composeEnv(process.env, provider.overlay(), own);
}

/** Запуски ждут конца вычисления выражений при старте Cyborg. */
export async function childEnv(own?: Own): Promise<Record<string, string>> {
  await provider.ready();
  return childEnvNow(own);
}
