// Проверка согласованности корпуса docs/: node scripts/check-corpus.ts [--write-matrix].
// Без аргументов проверяет корпус и актуальность матрицы верификации; код выхода 1 - есть находки. --write-matrix пересобирает
// docs/04-verification/verification-matrix.md (npm run corpus:matrix). Правила и матрица - scripts/corpus-lib.ts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCorpus, MATRIX_FILE, requirements, writeMatrix } from './corpus-lib.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--write-matrix')) {
  writeMatrix(root);
  console.log(`check-corpus: ${MATRIX_FILE} пересобрана`);
} else {
  const findings = checkCorpus(root);
  for (const f of findings) console.error(`${f.file}: [${f.rule}] ${f.message}`);
  if (findings.length) {
    console.error(`check-corpus: находок ${findings.length}`);
    process.exitCode = 1;
  } else {
    console.log(`check-corpus: ${requirements(root).length} требований, корпус согласован`);
  }
}
