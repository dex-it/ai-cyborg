import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readLine } from '../../agentd/mic';

export interface MicBridgeDeps {
  /** Вкладка сессии хоста по её идентификатору там; null - сессия не открыта в этом окне. */
  lookup(host: string, sid: string): number | null;
  /** Захват в окне для вкладки: null - начат, строка - отказ для человека. */
  start(stream: number, id: number): Promise<string | null>;
  /** Запись закончилась на стороне хоста: окно отпускает микрофон. */
  stop(stream: number): void;
}

interface Stream {
  socket: net.Socket;
  ready: boolean;
}

const HEAD_TIMEOUT_MS = 5_000;

/** Микрофон окна для подставного arecord удалённых сессий: свой сокет на хост, туннель ssh -R ведёт к нему; одна запись за раз. */
export class MicBridge {
  private dir: string | null = null;
  private readonly servers = new Map<string, { path: string; server: net.Server }>();
  private readonly streams = new Map<number, Stream>();
  private next = 1;

  constructor(
    private readonly deps: MicBridgeDeps,
    private readonly base = os.tmpdir(),
  ) {}

  /** Путь локального сокета хоста; сокет поднимается при первом обращении. */
  socketFor(host: string): string {
    const known = this.servers.get(host);
    if (known) return known.path;
    this.dir ??= fs.mkdtempSync(path.join(this.base, 'cyborg-mic-'));
    fs.chmodSync(this.dir, 0o700);
    const file = path.join(this.dir, `${createHash('sha256').update(host).digest('hex').slice(0, 16)}.sock`);
    fs.rmSync(file, { force: true });
    const server = net.createServer((socket) => this.accept(host, socket));
    server.on('error', () => undefined);
    server.listen(file);
    this.servers.set(host, { path: file, server });
    return file;
  }

  private accept(host: string, socket: net.Socket): void {
    socket.on('error', () => socket.destroy());
    readLine(socket, HEAD_TIMEOUT_MS).then(
      ({ line }) => {
        let sid: unknown;
        try {
          sid = (JSON.parse(line) as { sid?: unknown }).sid;
        } catch {
          sid = undefined;
        }
        const id = typeof sid === 'string' ? this.deps.lookup(host, sid) : null;
        if (id === null) return void socket.end('no сессия не открыта в окне Cyborg\n');
        for (const n of [...this.streams.keys()]) this.end(n);
        const n = this.next++;
        const stream: Stream = { socket, ready: false };
        this.streams.set(n, stream);
        socket.on('close', () => {
          if (this.streams.get(n) !== stream) return;
          this.streams.delete(n);
          this.deps.stop(n);
        });
        this.deps.start(n, id).then(
          (refusal) => this.started(n, stream, refusal),
          (error: Error) => this.started(n, stream, error.message),
        );
      },
      () => socket.destroy(),
    );
  }

  private started(n: number, stream: Stream, refusal: string | null): void {
    if (this.streams.get(n) !== stream) return;
    if (refusal) {
      this.streams.delete(n);
      stream.socket.end(`no ${refusal.replace(/\s+/g, ' ')}\n`);
      return;
    }
    stream.ready = true;
    stream.socket.write('ok\n');
  }

  /** PCM 16 кГц моно s16le от окна. */
  write(n: number, chunk: Buffer): void {
    const stream = this.streams.get(n);
    if (stream?.ready && !stream.socket.destroyed) stream.socket.write(chunk);
  }

  /** Окно закончило захват (ошибка устройства, закрытие): arecord на хосте получает конец потока. */
  end(n: number): void {
    const stream = this.streams.get(n);
    if (!stream) return;
    this.streams.delete(n);
    this.deps.stop(n);
    stream.socket.end();
  }

  close(): void {
    for (const n of [...this.streams.keys()]) this.end(n);
    for (const { server } of this.servers.values()) server.close();
    this.servers.clear();
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
  }
}
