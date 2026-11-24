import { randomUUID } from 'node:crypto';
import type { SideAnswer } from '../shared/side-question.ts';

export interface SideAsk {
  id: string;
  prompt: string;
}

/** Мод держит запрос открытым столько, пока ждёт вопроса; потом спрашивает снова. */
export const SIDE_HOLD_MS = 15_000;
/** Мод считается живым, пока его запрос открыт или с последнего прошло меньше этого. */
export const SIDE_ALIVE_MS = 40_000;
/** На остывшем кэше форк записывает весь контекст заново: это долго. */
export const SIDE_ANSWER_MS = 180_000;

interface Pending {
  caller: number;
  resolve: (answer: SideAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Вопросы к модам cyborg-ask: мод забирает их долгим опросом, задаёт форку своей сессии и присылает ответ. */
export class SideQuestions {
  private readonly queues = new Map<number, SideAsk[]>();
  private readonly waiters = new Map<number, (ask: SideAsk | null) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<number, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly holdMs = SIDE_HOLD_MS,
    private readonly answerMs = SIDE_ANSWER_MS,
  ) {}

  /** Мод сессии на связи: ждёт вопроса или спрашивал недавно. */
  ready(caller: number): boolean {
    const at = this.seen.get(caller);
    return this.waiters.has(caller) || (at !== undefined && this.now() - at < SIDE_ALIVE_MS);
  }

  ask(caller: number, prompt: string): Promise<SideAnswer> {
    if (!this.ready(caller)) return Promise.resolve({ ok: false, reason: 'no-mod' });
    const ask: SideAsk = { id: randomUUID(), prompt };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(ask.id, { ok: false, reason: 'timeout' }), this.answerMs);
      this.pending.set(ask.id, { caller, resolve, timer });
      this.hand(caller, ask);
    });
  }

  /** Долгий опрос мода: вопрос, как только он есть, либо null по истечении ожидания или по signal. */
  next(caller: number, signal?: AbortSignal): Promise<SideAsk | null> {
    this.seen.set(caller, this.now());
    const queued = this.queues.get(caller)?.shift();
    if (queued) return Promise.resolve(queued);
    this.waiters.get(caller)?.(null);
    return new Promise((resolve) => {
      const done = (ask: SideAsk | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (this.waiters.get(caller) === done) this.waiters.delete(caller);
        this.seen.set(caller, this.now());
        resolve(ask);
      };
      const abort = (): void => done(null);
      const timer = setTimeout(abort, this.holdMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.set(caller, done);
    });
  }

  /** Вопрос не дошёл до мода (соединение оборвалось): вернуть его в начало очереди. */
  requeue(caller: number, ask: SideAsk): void {
    if (!this.pending.has(ask.id)) return;
    this.queues.set(caller, [ask, ...(this.queues.get(caller) ?? [])]);
  }

  /** Ответ мода; чужой или уже закрытый вопрос не принимается. */
  answer(caller: number, id: string, answer: SideAnswer): boolean {
    const p = this.pending.get(id);
    if (!p || p.caller !== caller) return false;
    this.settle(id, answer);
    return true;
  }

  /** Сессия завершилась: её вопросы закрываются, мод забывается. */
  drop(caller: number): void {
    this.waiters.get(caller)?.(null);
    this.queues.delete(caller);
    this.seen.delete(caller);
    for (const [id, p] of this.pending) if (p.caller === caller) this.settle(id, { ok: false, reason: 'session-ended' });
  }

  private hand(caller: number, ask: SideAsk): void {
    const waiter = this.waiters.get(caller);
    if (waiter) waiter(ask);
    else this.queues.set(caller, [...(this.queues.get(caller) ?? []), ask]);
  }

  private settle(id: string, answer: SideAnswer): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const queue = this.queues.get(p.caller);
    if (queue) this.queues.set(p.caller, queue.filter((a) => a.id !== id));
    p.resolve(answer);
  }
}

/** Тело ответа мода в SideAnswer: только известные поля нужных типов. */
export function parseSideAnswer(body: unknown): { id: string; answer: SideAnswer } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== 'string') return null;
  const usage = typeof b.usage === 'object' && b.usage !== null ? (b.usage as Record<string, unknown>) : undefined;
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const answer: SideAnswer = { ok: b.isAnswered === true && typeof b.text === 'string' };
  if (typeof b.text === 'string') answer.text = b.text;
  if (typeof b.reason === 'string') answer.reason = b.reason;
  if (num(b.status) !== undefined) answer.status = num(b.status);
  if (num(b.ms) !== undefined) answer.ms = num(b.ms);
  if (usage) {
    answer.usage = {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_read_input_tokens: num(usage.cache_read_input_tokens),
      cache_creation_input_tokens: num(usage.cache_creation_input_tokens),
    };
  }
  return { id: b.id, answer };
}
