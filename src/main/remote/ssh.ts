/** Аргументы системного ssh: без оболочки и без запросов (BatchMode), алиас после «--», токена и промпта здесь нет. */
export function sshArgs(alias: string, remoteCommand: string, extra: string[] = []): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    ...extra,
    '--', alias, remoteCommand,
  ];
}

/** Причина отказа ssh по stderr: человек получает совет, а не зависший запуск. */
export function classifySshError(stderr: string): string {
  if (/Permission denied/i.test(stderr)) return 'хост требует пароль либо ключ не принят или зашифрован без ssh-agent: настройте вход по ключу через ssh-agent';
  if (/Host key verification failed/i.test(stderr)) return 'ключ хоста не подтверждён: один раз выполните ssh <алиас> в терминале';
  if (/Could not resolve hostname/i.test(stderr)) return 'алиас не найден в ~/.ssh/config и DNS';
  if (/timed out/i.test(stderr)) return 'хост не ответил за 15 с';
  if (/remote port forwarding failed/i.test(stderr)) return 'sshd хоста запретил переадресацию unix-сокета (AllowStreamLocalForwarding)';
  const last = stderr.trim().split('\n').pop() ?? '';
  return last.slice(0, 300) || 'ssh завершился без пояснения';
}
