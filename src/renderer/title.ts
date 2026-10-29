/** Заголовок окна: «Воркспейс - Проект - Cyborg v.версия»; без проекта - «Воркспейс - Cyborg v.версия»; без воркспейса - «Cyborg v.версия». */
export function windowTitle(version: string, projectName: string | null, workspaceName: string | null = null): string {
  const app = `Cyborg v.${version}`;
  return [workspaceName, projectName, app].filter(Boolean).join(' - ');
}
