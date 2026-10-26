// Адрес сайта и бренд: единственное место, откуда их читают конфиг Astro и проверка сборки.
//
// Адрес GitHub Pages задаёт имя репозитория: https://<организация>.github.io/<репозиторий>/.
// Репозиторий переименуют - меняются REPO_NAME (и, при смене организации, OWNER) в этом файле,
// остальное (base, canonical, sitemap, ссылки, проверка dist) подтягивается отсюда.

export const OWNER = 'dex-it';
export const REPO_NAME = 'ai-cyborg';

export const ORIGIN = `https://${OWNER}.github.io`;
export const BASE = `/${REPO_NAME}`;
export const SITE_URL = `${ORIGIN}${BASE}/`;
export const REPO = `https://github.com/${OWNER}/${REPO_NAME}`;

export const BRAND = 'Cyborg';
export const TAGLINE = 'Одно окно для нескольких сессий Claude Code';
export const DESCRIPTION =
  'Cyborg собирает параллельные сессии Claude Code в одно окно: рядом с терминалом каждой сессии её дерево файлов, ветка и git-изменения, а задачи и MR из GitHub и GitLab лежат на соседней панели.';
