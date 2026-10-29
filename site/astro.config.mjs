import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { satteri } from '@astrojs/markdown-satteri';
import { defineMdastPlugin } from 'satteri';
import { fileURLToPath } from 'node:url';

import { ORIGIN as SITE, BASE, REPO, BRAND, DESCRIPTION, TAGLINE } from './site.config.mjs';

const siteRoot = fileURLToPath(new URL('./', import.meta.url));
const siteSrc = fileURLToPath(new URL('./src/', import.meta.url));
const guideRoot = fileURLToPath(new URL('../docs/guide/', import.meta.url));

// Страницы docs/guide лежат вне проекта, и Node-разрешение от них идёт вверх по
// репозиторию, а не в site/node_modules. Голые импорты из них (компоненты Starlight
// в .mdx) разрешаем так, будто файл лежит в site/.
const resolveFromSite = {
  name: 'guide-bare-imports',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !importer.startsWith(guideRoot)) return null;
    if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null;
    return this.resolve(source, `${siteRoot}package.json`, { ...options, skipSelf: true });
  },
};

// Astro не добавляет base к корневым ссылкам в Markdown. Авторы пишут `/start/install/`,
// плагин дописывает базовый путь ко всем таким ссылкам и картинкам.
const withBase = (url) =>
  typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && url !== BASE && !url.startsWith(`${BASE}/`)
    ? `${BASE}${url}`
    : url;
const baseLinks = defineMdastPlugin({
  name: 'base-links',
  link(node, ctx) {
    ctx.setProperty(node, 'url', withBase(node.url));
  },
  image(node, ctx) {
    ctx.setProperty(node, 'url', withBase(node.url));
  },
});

const ogImage = `${SITE}${BASE}/og.png`;

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  markdown: { processor: satteri({ mdastPlugins: [baseLinks] }) },
  vite: { plugins: [resolveFromSite], resolve: { alias: { '@site': siteSrc } } },
  integrations: [
    starlight({
      title: BRAND,
      description: DESCRIPTION,
      defaultLocale: 'root',
      locales: { root: { label: 'Русский', lang: 'ru' } },
      logo: { src: './src/generated/brand/icon.svg', alt: BRAND },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/master/site/` },
      customCss: ['./src/styles/theme.css'],
      lastUpdated: false,
      // Страницы лежат вне src/content/docs: без этого Starlight не обработает в них
      // врезки (:::tip) и ссылки у заголовков.
      markdown: { processedDirs: ['../docs/guide'] },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: ogImage } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: `${BRAND}: ${TAGLINE}` } },
        { tag: 'meta', attrs: { property: 'og:locale', content: 'ru_RU' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: ogImage } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#151a24' } },
      ],
      sidebar: [
        { label: 'Начать', items: ['start', 'start/requirements', 'start/install', 'start/first-run'] },
        {
          label: 'Возможности',
          items: [
            { slug: 'features', label: 'Обзор' },
            'features/sessions',
            'features/tree',
            'features/search',
            'features/tasks-mrs',
            'features/status',
            'features/commands',
            'features/path-drop',
            'features/isolation',
          ],
        },
        { label: 'Как это устроено', items: [{ slug: 'concepts', label: 'Обзор' }, 'concepts/hooks', 'concepts/git-safety', 'concepts/data'] },
        { label: 'Справка', items: ['reference/hotkeys', 'reference/platforms'] },
        { label: 'Участие', items: ['contributing', 'contributing/tests-ci', 'contributing/docs-site'] },
        { label: 'Вопросы', items: ['faq'] },
      ],
    }),
  ],
});
