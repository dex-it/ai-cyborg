import fs from 'node:fs';

/** Шифрование ОС для токена: на Linux без связки ключей Electron шифрует постоянным ключом, такое хранение не в счёт. */
export interface TokenCrypt {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface ClaudeTokenStatus {
  set: boolean;
  /** disk - зашифрован шифрованием ОС; memory - до выхода Cyborg: шифрования нет. */
  stored: 'disk' | 'memory' | null;
}

const TOKEN = /^[\x21-\x7e]{20,4096}$/;

/** Токен claude setup-token для входа удалённых агентов: на диске машины - только зашифрованным. */
export class ClaudeTokenStore {
  private memory: string | null = null;
  private onDisk = false;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly crypt: TokenCrypt,
  ) {}

  // safeStorage Electron работает только после ready приложения: файл читается при первом обращении.
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!this.crypt.available()) return;
      const token = this.crypt.decrypt(fs.readFileSync(this.file));
      if (TOKEN.test(token)) {
        this.memory = token;
        this.onDisk = true;
      }
    } catch {
      // файла нет либо его не расшифровать: токен не задан
    }
  }

  get(): string | null {
    this.load();
    return this.memory;
  }

  status(): ClaudeTokenStatus {
    this.load();
    return { set: this.memory !== null, stored: this.memory === null ? null : this.onDisk ? 'disk' : 'memory' };
  }

  set(value: unknown): ClaudeTokenStatus {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!TOKEN.test(token)) throw new Error('Токен - строка из claude setup-token без пробелов');
    this.loaded = true;
    this.memory = token;
    this.onDisk = false;
    fs.rmSync(this.file, { force: true });
    if (this.crypt.available()) {
      fs.writeFileSync(this.file, this.crypt.encrypt(token), { mode: 0o600 });
      this.onDisk = true;
    }
    return this.status();
  }

  clear(): ClaudeTokenStatus {
    this.loaded = true;
    this.memory = null;
    this.onDisk = false;
    fs.rmSync(this.file, { force: true });
    return this.status();
  }
}
