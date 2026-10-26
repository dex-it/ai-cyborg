/** Заголовок окна: «Проект - Cyborg v.версия»; без проекта - «Cyborg v.версия». */
export function windowTitle(version: string, projectName: string | null): string {
  const app = `Cyborg v.${version}`;
  return projectName ? `${projectName} - ${app}` : app;
}
