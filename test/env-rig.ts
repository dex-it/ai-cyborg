import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Candidate, Choice } from '../src/shared/env-vars';
import { ManagedEnv, type ManagedEnvDeps } from '../src/main/managed-env';

export interface Def {
  name: string;
  candidates?: Candidate[];
  choice?: Choice;
}

export const ID = (n: number): string => n.toString(16).padStart(8, '0');
export const literal = (n: number, value: string): Candidate => ({ id: ID(n), kind: 'literal', value });
export const expr = (n: number, command: string): Candidate => ({ id: ID(n), kind: 'expr', command });
export const selected = (n: number): Choice => ({ kind: 'selected', candidate: ID(n) });

/** Менеджер на временном каталоге: файл определений записан до создания, как при втором запуске Cyborg. */
export function managed(t: { after: (fn: () => void) => void }, defs: Def[] = [], over: Partial<ManagedEnvDeps> = {}): { env: ManagedEnv; dir: string; file: string; changes: number[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'env-vars.json');
  if (defs.length) fs.writeFileSync(file, JSON.stringify({ version: 1, vars: defs.map((d) => ({ candidates: [], choice: { kind: 'untouched' }, ...d })) }));
  const changes: number[] = [];
  const env = new ManagedEnv({ file, home: dir, loginPath: async () => process.env.PATH ?? '', inherited: () => ({ ENVT_INHERITED: 'from-parent' }), onChange: () => void changes.push(changes.length), ...over });
  t.after(() => env.dispose());
  return { env, dir, file, changes };
}
