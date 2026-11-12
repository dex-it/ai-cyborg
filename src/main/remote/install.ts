import { createHash, randomBytes } from 'node:crypto';
import { LOGIN_PATH } from './preflight';

export interface AgentdBundle {
  /** Первые 16 hex sha256 файла: изменился файл - на хосте новый каталог. */
  version: string;
  source: string;
  sha256: string;
}

export function bundleOf(text: string): AgentdBundle {
  const source = text.replace(/\n+$/, '');
  const sha256 = createHash('sha256').update(source + '\n').digest('hex');
  return { version: sha256.slice(0, 16), source, sha256 };
}

/** connect.sh: PATH логин-оболочки, затем мост stdio - сокет демона; демон поднимается из моста. */
export const CONNECT_SH = `#!/bin/sh
d=$(dirname "$0")
${LOGIN_PATH}exec node "$d/agentd.js" connect
`;

const delimiterFor = (...texts: string[]): string => {
  for (;;) {
    const delimiter = `CYBORG_${randomBytes(8).toString('hex').toUpperCase()}`;
    if (!texts.some((t) => t.includes(delimiter))) return delimiter;
  }
};

/** Скрипт установки для `sh -s`: версия собирается в скрытом каталоге, проверяется sha256 через node и встаёт на место одним mv каталога - сорванная установка видимой версии не оставляет. */
export function installScript(bundle: AgentdBundle): string {
  const d1 = delimiterFor(bundle.source, CONNECT_SH);
  const dir = `"$HOME/.cyborg/agentd/${bundle.version}"`;
  const stage = `"$HOME/.cyborg/agentd/.${bundle.version}.tmp"`;
  return `set -e
${LOGIN_PATH}umask 077
mkdir -p "$HOME/.cyborg/run" "$HOME/.cyborg/sessions" "$HOME/.cyborg/work" "$HOME/.cyborg/agentd"
chmod 700 "$HOME/.cyborg" "$HOME/.cyborg/run" "$HOME/.cyborg/sessions" "$HOME/.cyborg/work" "$HOME/.cyborg/agentd"
rm -rf ${stage}
trap 'rm -rf ${stage}' EXIT
mkdir ${stage}
cat > ${stage}/agentd.js <<'${d1}'
${bundle.source}
${d1}
sum=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' ${stage}/agentd.js </dev/null)
if [ "$sum" != "${bundle.sha256}" ]; then
  echo "контрольная сумма агента не сошлась" >&2
  exit 1
fi
cat > ${stage}/connect.sh <<'${d1}'
${CONNECT_SH}
${d1}
chmod 700 ${stage}/connect.sh
rm -rf ${dir}
mv ${stage} ${dir}
echo installed
`;
}
