import type { GitCred } from '../../agentd/protocol';
import { parseRemote, type CliRunner } from '../trackers';

const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** Переменные токена, которые gh и glab отдают для любого хоста: с ними токен оператора ушёл бы хосту origin или маркетплейса, где он не входил. */
export const HOST_AGNOSTIC_TOKEN_ENV = ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'] as const;

const tokenOf = async (run: CliRunner, cmd: 'gh' | 'glab', args: string[]): Promise<string> => {
  const res = await run(cmd, args);
  const token = res.code === 0 ? res.stdout.trim() : '';
  return TOKEN.test(token) ? token : '';
};

/** Токены хостингов origin проекта у gh и glab оператора, по запросу на каждый запуск; хост без токена пропускается - его клон идёт ключами хоста. */
export async function collectGitAuth(urls: string[], run: CliRunner): Promise<GitCred[]> {
  const hosts = [...new Set(urls.map((u) => parseRemote(u)?.host).filter((h): h is string => !!h))];
  const creds: GitCred[] = [];
  for (const host of hosts) {
    if (host === 'github.com') {
      const token = await tokenOf(run, 'gh', ['auth', 'token', '-h', host]);
      if (token) creds.push({ kind: 'github', host, token });
      continue;
    }
    const gitlab = await tokenOf(run, 'glab', ['config', 'get', 'token', '-h', host]);
    if (gitlab) {
      creds.push({ kind: 'gitlab', host, token: gitlab });
      continue;
    }
    const enterprise = await tokenOf(run, 'gh', ['auth', 'token', '-h', host]);
    if (enterprise) creds.push({ kind: 'github', host, token: enterprise });
  }
  return creds;
}
