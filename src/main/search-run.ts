/** Поиск одного вида идёт один: новый запрос отменяет прежний, и отменённый отвечает `cancelled`, а не ошибкой. */
export class SearchRunner {
  private readonly current = new Map<string, AbortController>();

  async run<T extends { cancelled?: true }>(kind: string, work: (signal: AbortSignal) => Promise<T>, empty: T): Promise<T> {
    this.current.get(kind)?.abort();
    const controller = new AbortController();
    this.current.set(kind, controller);
    try {
      const reply = await work(controller.signal);
      return controller.signal.aborted ? { ...empty, cancelled: true } : reply;
    } catch (error) {
      if (controller.signal.aborted) return { ...empty, cancelled: true };
      throw error;
    } finally {
      if (this.current.get(kind) === controller) this.current.delete(kind);
    }
  }
}
