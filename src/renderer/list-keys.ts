/** Клавиатурное управление списками пунктов: меню выбора репозитория и ветки, список прошлых сессий. */

/** Какой пункт получает фокус по клавише (по кругу); null - клавиша не для перебора. */
export function listTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : (index + 1) % count;
    case 'ArrowUp':
      return index < 0 ? count - 1 : (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Один пункт списка в порядке табуляции (текущий либо первый): `Tab` проходит список одним шагом. */
export function rove(container: HTMLElement, selector: string, current: HTMLElement | null = null): void {
  container.querySelectorAll<HTMLElement>(selector).forEach((item, index) => {
    item.tabIndex = (current ? item === current : index === 0) ? 0 : -1;
  });
}

/** Пункт как нажимаемый элемент для клавиатуры и программ чтения с экрана. */
export function asMenuItem(item: HTMLElement, role = 'menuitem'): HTMLElement {
  item.setAttribute('role', role);
  item.tabIndex = -1;
  return item;
}

/**
 * Список пунктов: стрелки, Home и End переводят фокус по пунктам, Enter и пробел нажимают пункт. Из поля ввода внутри
 * контейнера (поиск ветки) `ArrowDown` уходит на первый пункт. Работает на контейнере, пункты можно пересобирать.
 */
export function bindList(container: HTMLElement, selector: string): void {
  container.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const items = [...container.querySelectorAll<HTMLElement>(selector)];
    const item = target.closest<HTMLElement>(selector);
    if (item && target === item && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      item.click();
      return;
    }
    if (!item && target.tagName !== 'INPUT') return;
    if (!item && event.key !== 'ArrowDown') return;
    if (item && target !== item) return;
    const next = listTarget(event.key, item ? items.indexOf(item) : -1, items.length);
    if (next === null) return;
    event.preventDefault();
    rove(container, selector, items[next]);
    items[next].focus();
  });
}
