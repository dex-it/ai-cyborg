// Кнопки запуска сессий: свои кнопки из prompts.json рядом со встроенными и подсказки с действующим промптом.

import { launchTitle, parseLaunchButtons, type LaunchButton, type LaunchPlace } from '../main/prompts';

let raw: unknown;

/** Перечитывает prompts.json: после правки в окне «Кнопки» и при возврате фокуса. */
export async function reloadLaunchButtons(): Promise<void> {
  raw = (await window.cyborg.loadPrompts()).raw;
}

/** Включённые свои кнопки места; негодные в разбор не попадают, причина видна в окне «Кнопки». */
export const ownLaunchButtons = (place: LaunchPlace): LaunchButton[] => parseLaunchButtons(raw).buttons.filter((b) => b.place === place && !b.disabled);

/** Подсказка кнопки: описание и промпт; у негодной - причина. key - id встроенного промпта или подпись своей кнопки. */
export const launchHint = (place: LaunchPlace, key: string): string => launchTitle(place, key, raw);
