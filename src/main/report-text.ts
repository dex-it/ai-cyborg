export const REPORTED_ERROR = 'итог этого круга работы уже отправлен: новый круг начнётся со следующего сообщения сессии';
export const REPORT_ACCEPTED = 'Итог принят. Сессия остаётся открытой: следующее сообщение начнёт новый круг работы, и report_done снова станет доступен.';

/** Тело уведомления об итоге, когда открывшей сессии нет. */
export const reportNote = (report: { status: string; summary: string }): string => `${report.status}: ${report.summary.slice(0, 200)}`;

/** Итог для открывшей сессии; host - только у удалённой. */
export function reportText(id: number | string, host: string | undefined, report: { status: string; summary: string; branch?: string; pr?: string }): string {
  const head = host ? `Итог удалённой сессии CC${id} (${host}): ${report.status}` : `Итог сессии CC${id}: ${report.status}`;
  return [head, report.branch ? `ветка: ${report.branch}` : '', report.pr ? `PR: ${report.pr}` : '', '', report.summary]
    .filter((line, i) => line || i === 3)
    .join('\n');
}

/** Открывшей сессии о конце дочерней: процесс вышел сам (вкладка открыта) либо вкладку закрыли - человек или другая сессия. */
export function childExitText(id: number, exit: { code: number; released: boolean; closedBy?: number }): string {
  if (!exit.released) return `Сессия CC${id} завершилась (код ${exit.code}): её вкладка открыта, закрыть - close_session.`;
  return exit.closedBy === undefined ? `Вкладку сессии CC${id} закрыл человек.` : `Вкладку сессии CC${id} закрыла сессия CC${exit.closedBy}.`;
}
