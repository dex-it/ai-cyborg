export interface MicApi {
  micStarted(stream: number, refusal: string | null): void;
  micData(stream: number, pcm: Uint8Array): void;
  micEnd(stream: number): void;
  on<T>(channel: string, listener: (payload: T) => void): () => void;
}

export interface MicHooks {
  /** Причина не писать для вкладки id; null - можно. */
  refuse(id: number): string | null;
  /** Идёт ли запись для вкладки: отметка на её ярлыке. */
  recording(id: number, on: boolean): void;
}

/** Частота, которую ждёт `arecord -r 16000` Claude Code. */
export const TARGET_RATE = 16_000;
/** 20 мс при 16 кГц. */
export const FRAME_SAMPLES = 320;

/** Понижение частоты усреднением окна: речи для распознавания хватает. Класс идёт в worklet текстом, поэтому без ссылок наружу. */
export class Downsampler {
  private readonly ratio: number;
  private acc = 0;
  private sum = 0;
  private count = 0;
  private frame: Int16Array;
  private fill = 0;

  constructor(
    rate: number,
    target: number,
    private readonly size: number,
  ) {
    this.ratio = rate / target;
    this.frame = new Int16Array(size);
  }

  /** Готовые кадры s16le из очередного блока float-отсчётов. */
  push(input: Float32Array): Int16Array[] {
    const out: Int16Array[] = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.acc++;
      if (this.acc < this.ratio) continue;
      this.acc -= this.ratio;
      const v = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.frame[this.fill++] = Math.round(v * 32767);
      if (this.fill === this.size) {
        out.push(this.frame);
        this.frame = new Int16Array(this.size);
        this.fill = 0;
      }
    }
    return out;
  }
}

/** Модуль AudioWorklet: worklet грузится по URL и импортов не знает. */
export const WORKLET = `const Downsampler = ${Downsampler.toString()};
registerProcessor('cyborg-pcm16k', class extends AudioWorkletProcessor {
  constructor() { super(); this.down = new Downsampler(sampleRate, ${TARGET_RATE}, ${FRAME_SAMPLES}); }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) for (const frame of this.down.push(input)) this.port.postMessage(frame, [frame.buffer]);
    return true;
  }
});
`;

interface Capture {
  id: number;
  stopped: boolean;
  media?: MediaStream;
  ctx?: AudioContext;
}

/** Захват микрофона по запросу подставного arecord удалённой сессии: только для вкладки в фокусе, отпускается с концом записи. */
export function initMic(api: MicApi, hooks: MicHooks): void {
  const captures = new Map<number, Capture>();

  const release = (stream: number): void => {
    const c = captures.get(stream);
    if (!c) return;
    captures.delete(stream);
    c.stopped = true;
    for (const track of c.media?.getTracks() ?? []) track.stop();
    void c.ctx?.close().catch(() => undefined);
    hooks.recording(c.id, false);
  };

  const start = async (stream: number, id: number): Promise<void> => {
    const refusal = hooks.refuse(id);
    if (refusal) return api.micStarted(stream, refusal);
    const c: Capture = { id, stopped: false };
    captures.set(stream, c);
    try {
      c.media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (c.stopped) return release(stream);
      c.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await c.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (c.stopped) return release(stream);
      const node = new AudioWorkletNode(c.ctx, 'cyborg-pcm16k');
      node.port.onmessage = (event: MessageEvent<Int16Array>) => {
        if (!c.stopped) api.micData(stream, new Uint8Array(event.data.buffer));
      };
      const mute = c.ctx.createGain();
      mute.gain.value = 0;
      c.ctx.createMediaStreamSource(c.media).connect(node);
      // Узел без пути к выходу контекст может не обрабатывать: тишина в destination держит его живым.
      node.connect(mute).connect(c.ctx.destination);
      hooks.recording(id, true);
      api.micStarted(stream, null);
    } catch (error) {
      release(stream);
      api.micStarted(stream, `микрофон этого компьютера недоступен: ${(error as Error).message}`);
    }
  };

  api.on<{ stream: number; id: number }>('mic:start', ({ stream, id }) => void start(stream, id));
  api.on<{ stream: number }>('mic:stop', ({ stream }) => release(stream));
  window.addEventListener('blur', () => {
    for (const stream of [...captures.keys()]) {
      release(stream);
      api.micEnd(stream);
    }
  });
}
