/** Элемент с индекса from встаёт на индекс to; индекс вне списка - список без изменений. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Место новой дочерней вкладки: за родителем и стоящими следом его потомками, так дети идут слева направо в порядке открытия; родителя нет - в конец. */
export function childSlot<T>(list: readonly T[], parent: T, descends: (item: T) => boolean): number {
  const at = list.indexOf(parent);
  if (at < 0) return list.length;
  let slot = at + 1;
  while (slot < list.length && descends(list[slot])) slot++;
  return slot;
}
