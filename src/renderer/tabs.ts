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

// Свой тип данных: вкладка не принимается зонами броска пути (acceptsDrop), и терминал её не вставит.
const TAB_DRAG_MIME = 'application/x-cyborg-tab';
let dragged: HTMLElement | null = null;

/** Перестановка вкладок с draggable мышью внутри списка; порядок в данных и в DOM меняет onMove(перетащенная, цель). */
export function bindTabDrag(list: HTMLElement, onMove: (from: HTMLElement, to: HTMLElement) => void): void {
  let over: HTMLElement | null = null;
  const mark = (tab: HTMLElement | null): void => {
    if (over === tab) return;
    over?.classList.remove('drop-target');
    over = tab;
    over?.classList.add('drop-target');
  };
  const tabOf = (event: Event): HTMLElement | null => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    return tab && tab.draggable && list.contains(tab) ? tab : null;
  };
  const dropTarget = (event: Event): HTMLElement | null => {
    const tab = tabOf(event);
    return tab && dragged && tab !== dragged && list.contains(dragged) ? tab : null;
  };
  list.addEventListener('dragstart', (event) => {
    const tab = tabOf(event);
    if (!tab || !event.dataTransfer) return;
    dragged = tab;
    event.dataTransfer.setData(TAB_DRAG_MIME, '');
    event.dataTransfer.effectAllowed = 'move';
    tab.classList.add('dragging');
  });
  list.addEventListener('dragover', (event) => {
    const tab = dropTarget(event);
    if (!tab || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    mark(tab);
  });
  list.addEventListener('dragleave', (event) => {
    if (over && !over.contains(event.relatedTarget as Node | null)) mark(null);
  });
  list.addEventListener('drop', (event) => {
    const tab = dropTarget(event);
    mark(null);
    if (!tab || !dragged) return;
    event.preventDefault();
    onMove(dragged, tab);
  });
  list.addEventListener('dragend', () => {
    mark(null);
    dragged?.classList.remove('dragging');
    dragged = null;
  });
}
