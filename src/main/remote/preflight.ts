export type PreflightResult = { home: string; installed: string[] } | { missing: string[] };

/** PATH берётся у логин-оболочки: в неинтерактивном ssh нет ни nvm, ни ~/.local/bin; stdin закрыт, чтобы команды не читали сам скрипт. */
export const PREFLIGHT_SCRIPT = `P=$("\${SHELL:-/bin/sh}" -lc env </dev/null 2>/dev/null | sed -n 's/^PATH=//p')
[ -n "$P" ] && PATH=$P
export PATH
echo "home=$HOME"
echo "uname=$(uname -s)"
echo "node=$(node -v 2>/dev/null </dev/null)"
echo "git=$(command -v git)"
echo "claude=$(command -v claude)"
echo "script=$(command -v script)"
echo "auth=$(claude auth status --json 2>/dev/null </dev/null | tr -d '\\n')"
echo "agentd=$(ls "$HOME/.cyborg/agentd" 2>/dev/null | tr '\\n' ' ')"
`;

/** Разбор вывода проверочного скрипта хоста (строки key=value): называет всё недостающее за один раз. */
export function parsePreflight(output: string): PreflightResult {
  const kv = new Map<string, string>();
  for (const line of output.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  const uname = kv.get('uname');
  if (uname && uname !== 'Linux') return { missing: [`хост не Linux (${uname}): нужны script и stty из util-linux`] };
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
  return { home: home as string, installed: (kv.get('agentd') ?? '').split(/\s+/).filter(Boolean) };
}
