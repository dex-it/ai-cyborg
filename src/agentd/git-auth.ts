import type { Auth, GitCred } from './protocol.ts';

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/;
// Токен уходит строкой в ответ помощника учётных данных git: перевод строки дописал бы туда свои поля.
const TOKEN = /^[\x21-\x7e]{1,4096}$/;
const MAX_CREDS = 16;

/** Доступы из сообщения Cyborg: всё, что не прошло проверку, отбрасывается без отказа. */
export function readAuth(value: unknown): Auth {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const git: GitCred[] = [];
  for (const item of Array.isArray(v.git) ? v.git : []) {
    const c = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if ((c.kind !== 'github' && c.kind !== 'gitlab') || typeof c.host !== 'string' || !HOST.test(c.host)) continue;
    if (typeof c.token !== 'string' || !TOKEN.test(c.token) || git.some((g) => g.host === c.host)) continue;
    git.push({ kind: c.kind, host: c.host, token: c.token });
    if (git.length === MAX_CREDS) break;
  }
  const primary = typeof v.primary === 'string' && HOST.test(v.primary) ? v.primary : undefined;
  const claude = typeof v.claude === 'string' && TOKEN.test(v.claude) ? v.claude : undefined;
  return { git, ...(primary ? { primary } : {}), ...(claude ? { claude } : {}) };
}

/** Окружение git, gh и glab с токенами оператора: git@ и ssh:// хоста идут по https, пароль отдаёт помощник из переменной окружения. */
export function gitAuthEnv(auth: Auth): Record<string, string> {
  const env: Record<string, string> = {};
  const pairs: [string, string][] = [];
  auth.git.forEach((cred, i) => {
    const name = cred.host.replace(/:\d+$/, '');
    const base = `https://${cred.host}`;
    const user = cred.kind === 'github' ? 'x-access-token' : 'oauth2';
    pairs.push([`url.${base}/.insteadOf`, `git@${name}:`]);
    pairs.push([`url.${base}/.insteadOf`, `ssh://git@${name}/`]);
    // Пустое значение сбрасывает помощников из конфигурации хоста: иначе git спросил бы их первыми.
    pairs.push([`credential.${base}.helper`, '']);
    pairs.push([`credential.${base}.helper`, `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' ${user} "$CYBORG_GIT_TOKEN_${i}"; }; f`]);
    env[`CYBORG_GIT_TOKEN_${i}`] = cred.token;
  });
  if (!pairs.length) return env;
  env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  const github = auth.git.find((c) => c.kind === 'github' && c.host === 'github.com');
  if (github) env.GH_TOKEN = github.token;
  const enterprise = auth.git.find((c) => c.kind === 'github' && c.host !== 'github.com' && c.host === auth.primary) ?? auth.git.find((c) => c.kind === 'github' && c.host !== 'github.com');
  if (enterprise) {
    env.GH_ENTERPRISE_TOKEN = enterprise.token;
    // Внутри клона gh берёт хост из origin, но вне клона без GH_HOST пошёл бы на github.com.
    if (enterprise.host === auth.primary) env.GH_HOST = enterprise.host;
  }
  const gitlab = auth.git.find((c) => c.kind === 'gitlab' && c.host === auth.primary) ?? auth.git.find((c) => c.kind === 'gitlab');
  if (gitlab) {
    env.GITLAB_TOKEN = gitlab.token;
    env.GITLAB_HOST = `https://${gitlab.host}`;
  }
  return env;
}

/** Окружение агента: git-доступы и вход Claude по токену. */
export function agentAuthEnv(auth: Auth): Record<string, string> {
  return { ...gitAuthEnv(auth), ...(auth.claude ? { CLAUDE_CODE_OAUTH_TOKEN: auth.claude } : {}) };
}
