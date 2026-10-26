import { readPref, writePref } from './prefs';

export interface NotifyPort {
  notify(id: number, title: string, body: string): void;
  unnotify(id: number): void;
  notificationsState(enabled: boolean): void;
}

const NOTIFICATIONS_KEY = 'cyborg.notifications';

/** Уведомления рабочего стола о ждущих сессиях: когда показать и когда погасить. Выключатель хранится в окне, меню только отражает его. */
export class WaitNotifier {
  private enabled: boolean;
  private readonly shown = new Set<number>();

  constructor(private readonly port: NotifyPort) {
    this.enabled = readPref(NOTIFICATIONS_KEY) !== 'off';
    port.notificationsState(this.enabled);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    writePref(NOTIFICATIONS_KEY, enabled ? 'on' : 'off');
    // Показанные гасит главный процесс, получив новое состояние.
    if (!enabled) this.shown.clear();
    this.port.notificationsState(enabled);
  }

  /** seen - человек уже смотрит на сессию: она активна, и окно в фокусе. */
  waiting(id: number, title: string, reason: string, seen: boolean): void {
    if (!this.enabled || seen) return;
    this.shown.add(id);
    this.port.notify(id, title, reason);
  }

  /** Сессию увидели, ей ответили, либо её больше нет. */
  dismiss(id: number): void {
    if (this.shown.delete(id)) this.port.unnotify(id);
  }
}
