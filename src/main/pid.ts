/** Жив ли процесс: kill с сигналом 0 ничего не посылает; EPERM - процесс есть, но чужой. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
