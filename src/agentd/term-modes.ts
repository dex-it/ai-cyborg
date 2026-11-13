const ALT_SCREEN = [1049, 1047, 47];
const MAX_MODES = 64;

/** Режимы DEC (`CSI ? Pm h|l`) вытесненного из кольца вывода: Claude включает их один раз, а reset у клиента их снимает. */
export class DecModes {
  private readonly modes = new Map<number, boolean>();
  private state: 'ground' | 'esc' | 'csi' | 'private' = 'ground';
  private params = '';

  feed(chunk: Uint8Array): void {
    for (const b of chunk) {
      switch (this.state) {
        case 'ground':
          if (b === 0x1b) this.state = 'esc';
          break;
        case 'esc':
          if (b === 0x63) this.modes.clear();
          this.state = b === 0x5b ? 'csi' : b === 0x1b ? 'esc' : 'ground';
          break;
        case 'csi':
          this.params = '';
          this.state = b === 0x3f ? 'private' : b === 0x1b ? 'esc' : 'ground';
          break;
        case 'private':
          if ((b >= 0x30 && b <= 0x39) || b === 0x3b) {
            if (this.params.length < 64) this.params += String.fromCharCode(b);
            break;
          }
          if (b === 0x68 || b === 0x6c) this.set(b === 0x68);
          this.state = b === 0x1b ? 'esc' : 'ground';
      }
    }
  }

  /** Альтернативный экран идёт первым: переключение на него чистит экран. */
  restore(): string {
    const alt = (n: number): number => (ALT_SCREEN.includes(n) ? 0 : 1);
    return [...this.modes]
      .sort(([a], [b]) => alt(a) - alt(b))
      .map(([n, on]) => `\x1b[?${n}${on ? 'h' : 'l'}`)
      .join('');
  }

  private set(on: boolean): void {
    for (const p of this.params.split(';')) {
      if (!p) continue;
      const n = Number(p);
      if (this.modes.has(n) || this.modes.size < MAX_MODES) this.modes.set(n, on);
    }
  }
}
