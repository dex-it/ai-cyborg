import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { arecord, micServer, readLine } from '../src/agentd/mic';
import { MicBridge } from '../src/main/remote/mic-bridge';
import { validateProjectsState } from '../src/main/trackers';
import { ProjectStore } from '../src/main/projects';
import { Downsampler, FRAME_SAMPLES, TARGET_RATE, WORKLET } from '../src/renderer/mic';

const tmp = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyb-mic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const listen = (server: net.Server, file: string): Promise<void> => new Promise((resolve) => server.listen(file, () => resolve()));

/** Весь ответ сокета после запроса: первая строка и сырой хвост. */
function ask(file: string, request: string): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file);
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.write(request + '\n'));
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(10);
      resolve({ line: all.subarray(0, nl).toString(), rest: all.subarray(nl + 1) });
    });
  });
}

describe('микрофон: понижение частоты', () => {
  it('48 кГц -> 16 кГц: секунда даёт 50 кадров по 20 мс, уровень сохраняется, выход ограничен', () => {
    const down = new Downsampler(48_000, TARGET_RATE, FRAME_SAMPLES);
    const frames = down.push(new Float32Array(48_000).fill(0.5));
    assert.equal(frames.length, 50);
    assert.ok(frames.every((f) => f.length === FRAME_SAMPLES && f.every((v) => v === 16384)));
    assert.equal(new Downsampler(16_000, TARGET_RATE, 4).push(new Float32Array([2, -2, 0, 1]))[0].join(), '32767,-32767,0,32767');
  });

  it('44.1 кГц: дробный шаг не теряет и не копит отсчёты', () => {
    const down = new Downsampler(44_100, TARGET_RATE, FRAME_SAMPLES);
    let samples = 0;
    for (let i = 0; i < 100; i++) samples += down.push(new Float32Array(441)).length * FRAME_SAMPLES;
    assert.ok(Math.abs(samples - 16_000) <= FRAME_SAMPLES, `${samples}`);
  });

  it('модуль worklet исполняется сам по себе и отдаёт те же кадры, что Downsampler', () => {
    const posted: Int16Array[] = [];
    let Proc: (new () => { process(inputs: Float32Array[][]): boolean }) | undefined;
    class AudioWorkletProcessor {
      port = { postMessage: (frame: Int16Array) => void posted.push(frame) };
    }
    vm.runInNewContext(WORKLET, { AudioWorkletProcessor, sampleRate: 48_000, Int16Array, Math, registerProcessor: (_n: string, c: typeof Proc) => (Proc = c) });
    assert.ok(Proc, 'процессор зарегистрирован');
    const proc = new Proc();
    const block = new Float32Array(128).map((_, i) => Math.sin(i / 7) * 0.8);
    for (let i = 0; i < 30; i++) assert.equal(proc.process([[block]]), true);
    const direct = new Downsampler(48_000, TARGET_RATE, FRAME_SAMPLES);
    const expected = Array.from({ length: 30 }, () => direct.push(block)).flat();
    assert.equal(posted.length, expected.length);
    assert.deepEqual(posted.map((f) => [...f]), expected.map((f) => [...f]));
  });
});

describe('микрофон: сокет демона и мост Cyborg', () => {
  function chain(t: { after: (fn: () => void) => void }, start: (stream: number, id: number) => Promise<string | null>) {
    const dir = tmp(t);
    const stops: number[] = [];
    const starts: [number, number][] = [];
    const bridge = new MicBridge(
      {
        lookup: (host, sid) => (host === 'dev1' && sid === 'sid-1' ? 7 : null),
        start: (stream, id) => (starts.push([stream, id]), start(stream, id)),
        stop: (stream) => void stops.push(stream),
      },
      dir,
    );
    t.after(() => bridge.close());
    let target: () => { forward: string; sid: string } | string = () => ({ forward: bridge.socketFor('dev1'), sid: 'sid-1' });
    const server = micServer(() => target());
    t.after(() => server.close());
    const sock = path.join(dir, 'mic.sock');
    return { bridge, server, sock, stops, starts, setTarget: (f: typeof target) => (target = f) };
  }

  it('record: заголовок с sid уходит в Cyborg, после ok - PCM от окна; конец записи отпускает окно', async (t) => {
    const c = chain(t, async () => null);
    await listen(c.server, c.sock);
    const socket = net.connect(c.sock);
    socket.write('record\n');
    const head = await readLine(socket);
    assert.equal(head.line, 'ok');
    assert.deepEqual(c.starts, [[1, 7]]);
    const pcm = Buffer.from([1, 2, 3, 4]);
    const got = new Promise<Buffer>((resolve) => socket.once('data', resolve));
    c.bridge.write(1, pcm);
    assert.deepEqual(await got, pcm);
    socket.destroy();
    for (let i = 0; i < 50 && !c.stops.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(c.stops, [1]);
  });

  it('отказ окна (вкладка не в фокусе) приходит строкой no с причиной, звука нет', async (t) => {
    const c = chain(t, async () => 'окно Cyborg не в фокусе');
    await listen(c.server, c.sock);
    const reply = await ask(c.sock, 'record');
    assert.equal(reply.line, 'no окно Cyborg не в фокусе');
    assert.equal(reply.rest.length, 0);
  });

  it('чужой sid: Cyborg отвечает отказом, окно не трогается', async (t) => {
    const c = chain(t, async () => null);
    c.setTarget(() => ({ forward: c.bridge.socketFor('dev1'), sid: 'другой' }));
    await listen(c.server, c.sock);
    assert.equal((await ask(c.sock, 'record')).line, 'no сессия не открыта в окне Cyborg');
    assert.deepEqual(c.starts, []);
  });

  it('probe отвечает демон, не будя Cyborg; без туннеля - причина отказа', async (t) => {
    const c = chain(t, async () => null);
    await listen(c.server, c.sock);
    assert.equal((await ask(c.sock, 'probe')).line, 'ok');
    assert.deepEqual(c.starts, []);
    c.setTarget(() => 'голосовой ввод выключен');
    assert.equal((await ask(c.sock, 'probe')).line, 'no голосовой ввод выключен');
    assert.equal((await ask(c.sock, 'record')).line, 'no голосовой ввод выключен');
  });

  it('новая запись вытесняет прежнюю: одна запись за раз', async (t) => {
    const c = chain(t, async () => null);
    await listen(c.server, c.sock);
    const first = net.connect(c.sock);
    first.write('record\n');
    await readLine(first);
    const closed = new Promise((resolve) => first.on('close', resolve));
    const second = net.connect(c.sock);
    second.write('record\n');
    assert.equal((await readLine(second)).line, 'ok');
    await closed;
    assert.deepEqual(c.stops, [1]);
    second.destroy();
  });

  it('сокеты моста лежат в каталоге 0700, свой на хост; close убирает каталог', (t) => {
    const dir = tmp(t);
    const bridge = new MicBridge({ lookup: () => null, start: async () => null, stop: () => undefined }, dir);
    const a = bridge.socketFor('dev1');
    assert.equal(bridge.socketFor('dev1'), a);
    assert.notEqual(bridge.socketFor('dev2'), a);
    assert.equal(fs.statSync(path.dirname(a)).mode & 0o777, 0o700);
    bridge.close();
    assert.equal(fs.existsSync(path.dirname(a)), false);
  });
});

describe('микрофон: подставной arecord', () => {
  it('--version успешен: так Claude Code решает, что arecord есть', async () => {
    const write = process.stdout.write;
    let out = '';
    process.stdout.write = ((s: string) => ((out += s), true)) as typeof process.stdout.write;
    try {
      assert.equal(await arecord(['--version'], {}, '/x'), 0);
    } finally {
      process.stdout.write = write;
    }
    assert.match(out, /Cyborg/);
  });

  it('проба в /dev/null и запись в файл идут через сокет; конец потока - выход 0', async (t) => {
    const dir = tmp(t);
    const sock = path.join(dir, 'mic.sock');
    const asked: string[] = [];
    const server = net.createServer((s) => {
      void readLine(s).then(({ line }) => {
        asked.push(line);
        s.end(line === 'probe' ? 'ok\n' : Buffer.concat([Buffer.from('ok\n'), Buffer.from('PCMDATA')]));
      });
    });
    t.after(() => server.close());
    await listen(server, sock);
    const env = { CYBORG_MIC: sock, PATH: '' };
    assert.equal(await arecord(['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '/dev/null'], env, dir), 0);
    const out = path.join(dir, 'out.raw');
    assert.equal(await arecord(['-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q', out], env, dir), 0);
    assert.deepEqual(asked, ['probe', 'record']);
    for (let i = 0; i < 50 && fs.readFileSync(out, 'utf8') !== 'PCMDATA'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(fs.readFileSync(out, 'utf8'), 'PCMDATA');
  });

  it('отказ без настоящего arecord - выход 1 с причиной; есть настоящий дальше по PATH - работает он', async (t) => {
    const dir = tmp(t);
    const sock = path.join(dir, 'mic.sock');
    const server = net.createServer((s) => void readLine(s).then(() => s.end('no голосовой ввод выключен\n')));
    t.after(() => server.close());
    await listen(server, sock);
    const own = path.join(dir, 'bin');
    const real = path.join(dir, 'real');
    fs.mkdirSync(own);
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(own, 'arecord'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const err = process.stderr.write;
    let said = '';
    process.stderr.write = ((s: string) => ((said += s), true)) as typeof process.stderr.write;
    try {
      assert.equal(await arecord(['/dev/null'], { CYBORG_MIC: sock, PATH: own }, own), 1);
    } finally {
      process.stderr.write = err;
    }
    assert.match(said, /голосовой ввод выключен/);
    const mark = path.join(dir, 'ran');
    fs.writeFileSync(path.join(real, 'arecord'), `#!/bin/sh\necho "$@" > ${mark}\nexit 3\n`, { mode: 0o755 });
    assert.equal(await arecord(['-q', '/dev/null'], { CYBORG_MIC: sock, PATH: `${own}:${real}` }, own), 3);
    assert.equal(fs.readFileSync(mark, 'utf8').trim(), '-q /dev/null');
  });
});

describe('микрофон: настройка хостов проекта', () => {
  const base = { id: 'p', name: 'n', description: '', repos: ['/r'], trackers: { github: false, gitlab: false } };

  it('voiceHosts при сохранении - только из hosts; форма алиаса та же, что у hosts', () => {
    const saved = validateProjectsState({ projects: [{ ...base, hosts: ['a', 'b'], voiceHosts: ['b', 'c'] }], lastProjectId: null });
    assert.deepEqual(saved?.projects[0].voiceHosts, ['b']);
    const none = validateProjectsState({ projects: [{ ...base, hosts: ['a'], voiceHosts: ['c'] }], lastProjectId: null });
    assert.equal('voiceHosts' in (none?.projects[0] ?? {}), false);
    assert.equal(validateProjectsState({ projects: [{ ...base, hosts: ['a'], voiceHosts: ['-oX'] }], lastProjectId: null }), null);
  });

  it('из файла voiceHosts вне hosts отбрасываются; поля нет - голосовой ввод выключен', (t) => {
    const dir = tmp(t);
    const file = path.join(dir, 'p.json');
    fs.writeFileSync(file, JSON.stringify({ projects: [{ ...base, hosts: ['a', 'b'], voiceHosts: ['b', 'z', 5] }, { ...base, id: 'q', hosts: ['a'] }], lastProjectId: null }));
    const [p, q] = new ProjectStore(file).load().projects;
    assert.deepEqual(p.voiceHosts, ['b']);
    assert.equal(q.voiceHosts, undefined);
  });
});
