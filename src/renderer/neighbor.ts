/** Что выбрать после закрытия элемента списка: соседа справа, а если закрыт последний - слева; undefined - список опустел. */
export function neighborAfterClose<T>(list: readonly T[], closed: T): T | undefined {
  const index = list.indexOf(closed);
  if (index < 0) return list[0];
  return list[index + 1] ?? list[index - 1];
}
