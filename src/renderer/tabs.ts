/** Клавиатурное управление вкладками: роли ARIA, перебор стрелками, активация Enter и пробелом. */

/** Какая вкладка получает фокус по клавише; null - клавиша не для перебора. */
export function tabTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Выбранная вкладка одна в порядке табуляции (roving tabindex): Tab входит в список и выходит из него одним шагом. */
export function selectTab(tab: HTMLElement, selected: boolean): void {
  tab.classList.toggle('active', selected);
  tab.setAttribute('aria-selected', String(selected));
  tab.tabIndex = selected ? 0 : -1;
}

/** Вкладка вне порядка табуляции, пока её не выбрали. */
export function markTab(tab: HTMLElement): HTMLElement {
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.tabIndex = -1;
  return tab;
}

/**
 * Список вкладок: стрелки, Home и End переводят фокус на соседнюю видимую вкладку, Enter и пробел на вкладке-не-кнопке
 * нажимают её. Работает на контейнере, поэтому вкладки, появившиеся позже, управляются так же.
 */
export function bindTablist(list: HTMLElement, label: string): void {
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', label);
  list.addEventListener('keydown', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (!tab || !list.contains(tab) || event.altKey || event.ctrlKey || event.metaKey) return;
    if ((event.key === 'Enter' || event.key === ' ') && event.target === tab && tab.tagName !== 'BUTTON') {
      event.preventDefault();
      tab.click();
      return;
    }
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter((t) => !t.hidden);
    const next = tabTarget(event.key, tabs.indexOf(tab), tabs.length);
    if (next === null || event.target !== tab) return;
    event.preventDefault();
    tabs[next].focus();
  });
}
