/** Правый клик удалённой сессии: Claude вставляет из буфера хоста, где его нет, а по своему выделению (видно по его OSC 52) только снимает его. */
export class RemotePaste {
  private selected = false;

  copied(): void {
    this.selected = true;
  }

  reset(): void {
    this.selected = false;
  }

  /** true - окно вставляет буфер само; `mouseTracking` - мышь отдана программе, без этого правый клик Claude не видит. */
  rightClick(mouseTracking: boolean): boolean {
    const selected = this.selected;
    this.selected = false;
    return mouseTracking && !selected;
  }
}
