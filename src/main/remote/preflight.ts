export type PreflightResult = { home: string } | { missing: string[] };

/** Разбор вывода проверочного скрипта хоста (строки key=value): называет всё недостающее за один раз. */
export function parsePreflight(output: string): PreflightResult {
  const kv = new Map<string, string>();
  for (const line of output.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const missing: string[] = [];
  const major = Number(/^v?(\d+)/.exec(kv.get('node') ?? '')?.[1]);
  if (!major || major < 18) missing.push('node ≥ 18');
  if (!kv.get('git')) missing.push('git');
  if (!kv.get('claude')) missing.push('claude');
  if (!kv.get('script')) missing.push('script (util-linux)');
  const home = kv.get('home');
  if (!home) missing.push('домашний каталог');
  if (missing.length) return { missing: [`на хосте нет: ${missing.join(', ')}`] };
  let loggedIn = false;
  try {
    loggedIn = (JSON.parse(kv.get('auth') ?? '') as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    loggedIn = false;
  }
  if (!loggedIn) return { missing: ['claude на хосте не залогинен: выполните claude auth login'] };
  return { home: home as string };
}
