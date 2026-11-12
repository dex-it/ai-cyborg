/** gh и glab на хосте: без них агент не откроет PR и MR, но работать может. */
export interface HostTools {
  gh: boolean;
  glab: boolean;
}

export type PreflightResult = { home: string; installed: string[]; tools: HostTools } | { missing: string[] };

/** PATH логин-оболочки: в неинтерактивном ssh нет ни nvm, ни ~/.local/bin; команда идёт в stdin, потому что tcsh не принимает -l вместе с -c, а последняя строка с / отсекает шум профиля. */
export const LOGIN_PATH = `P=$(printf 'printenv PATH\\n' | "\${SHELL:-/bin/sh}" -l 2>/dev/null | grep '^/' | tail -n 1)
[ -n "$P" ] && PATH=$P
export PATH
`;

export const PREFLIGHT_SCRIPT = `${LOGIN_PATH}echo "home=$HOME"
echo "uname=$(uname -s)"
echo "node=$(node -v 2>/dev/null </dev/null)"
echo "git=$(command -v git)"
echo "claude=$(command -v claude)"
echo "script=$(command -v script)"
echo "gh=$(command -v gh)"
echo "glab=$(command -v glab)"
echo "auth=$(claude auth status --json 2>/dev/null </dev/null | tr -d '\\n')"
echo "agentd=$(ls "$HOME/.cyborg/agentd" 2>/dev/null | tr '\\n' ' ')"
`;

/** Разбор вывода проверочного скрипта хоста (строки key=value): называет всё недостающее за один раз; с токеном Claude вход на хосте не нужен. */
export function parsePreflight(output: string, claudeToken = false): PreflightResult {
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
  if (!loggedIn && !claudeToken) return { missing: ['claude на хосте не залогинен: выполните на хосте claude auth login либо задайте токен в «Воркспейс → Вход Claude на хостах…»'] };
  return { home: home as string, installed: (kv.get('agentd') ?? '').split(/\s+/).filter(Boolean), tools: { gh: !!kv.get('gh'), glab: !!kv.get('glab') } };
}
