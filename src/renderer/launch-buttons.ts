// Кнопки запуска сессий: свои кнопки из prompts.json рядом со встроенными и подсказки с действующим промптом.

import { launchTitle, parseLaunchButtons, type LaunchPlace } from '../main/prompts';

let raw: unknown;
let seen = '';
const listeners: (() => void)[] = [];

/** Карточки MR, задач и «Статуса» подписываются, чтобы показать новый набор, не дожидаясь своей перерисовки. */
export const onLaunchButtonsChanged = (listener: () => void): void => void listeners.push(listener);

/** Перечитывает prompts.json: после правки в окне «Кнопки», сессией и при возврате фокуса. */
export async function reloadLaunchButtons(): Promise<void> {
  raw = (await window.cyborg.loadPrompts()).raw;
  const now = JSON.stringify(raw ?? null);
  if (now === seen) return;
  seen = now;
  for (const listener of listeners) listener();
}

export interface OwnLaunchButton {
  label: string;
  /** Кнопка негодна: на карточке недоступна, причина - в подсказке. */
  bad?: true;
}

/** Включённые свои кнопки места, затем негодные: негодную нажать нельзя, но она видна, как негодный встроенный промпт. */
export function ownLaunchButtons(place: LaunchPlace): OwnLaunchButton[] {
  const parsed = parseLaunchButtons(raw);
  return [
    ...parsed.buttons.filter((b) => b.place === place && !b.disabled).map((b) => ({ label: b.label })),
    ...parsed.bad.filter((b) => b.place === place && b.label !== undefined).map((b) => ({ label: b.label as string, bad: true as const })),
  ];
}

/** Подсказка кнопки: описание и промпт; у негодной - причина. key - id встроенного промпта или подпись своей кнопки. */
export const launchHint = (place: LaunchPlace, key: string): string => launchTitle(place, key, raw);
