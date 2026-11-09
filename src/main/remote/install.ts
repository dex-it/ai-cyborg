import { createHash, randomBytes } from 'node:crypto';

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
P=$("\${SHELL:-/bin/sh}" -lc env </dev/null 2>/dev/null | sed -n 's/^PATH=//p')
[ -n "$P" ] && PATH=$P
export PATH
exec node "$d/agentd.js" connect
`;

const delimiterFor = (...texts: string[]): string => {
  for (;;) {
    const delimiter = `CYBORG_${randomBytes(8).toString('hex').toUpperCase()}`;
    if (!texts.some((t) => t.includes(delimiter))) return delimiter;
  }
};

/** Скрипт установки для `sh -s`: файл во временное имя, проверка sha256 через node, затем mv - обрыв посреди переноса версию не создаёт. */
export function installScript(bundle: AgentdBundle): string {
  const d1 = delimiterFor(bundle.source, CONNECT_SH);
  const dir = `"$HOME/.cyborg/agentd/${bundle.version}"`;
  return `set -e
P=$("\${SHELL:-/bin/sh}" -lc env </dev/null 2>/dev/null | sed -n 's/^PATH=//p')
[ -n "$P" ] && PATH=$P
export PATH
umask 077
mkdir -p "$HOME/.cyborg/run" "$HOME/.cyborg/sessions" "$HOME/.cyborg/work" ${dir}
chmod 700 "$HOME/.cyborg" "$HOME/.cyborg/run" "$HOME/.cyborg/sessions" "$HOME/.cyborg/work" "$HOME/.cyborg/agentd" ${dir}
cat > ${dir}/agentd.js.tmp <<'${d1}'
${bundle.source}
${d1}
sum=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' ${dir}/agentd.js.tmp </dev/null)
if [ "$sum" != "${bundle.sha256}" ]; then
  rm -f ${dir}/agentd.js.tmp
  echo "контрольная сумма агента не сошлась" >&2
  exit 1
fi
cat > ${dir}/connect.sh.tmp <<'${d1}'
${CONNECT_SH}
${d1}
chmod 700 ${dir}/connect.sh.tmp
mv ${dir}/connect.sh.tmp ${dir}/connect.sh
mv ${dir}/agentd.js.tmp ${dir}/agentd.js
echo installed
`;
}
