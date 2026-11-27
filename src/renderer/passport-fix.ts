export interface FixHost<P> {
  startFix(project: P, repo: string, capability: string): void;
  showSession(id: number): boolean;
}

// Живая вкладка настройки: перейти к ней; view мог устареть и вкладки уже нет - тогда открыть новую (D-57).
export function fixAction<P>(host: FixHost<P>, live: number | null, project: P, repo: string, capability: string): void {
  if (live !== null && host.showSession(live)) return;
  host.startFix(project, repo, capability);
}
