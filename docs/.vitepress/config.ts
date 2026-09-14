import { defineConfig } from 'vitepress';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEMO = 'https://kherrala.fi/kerros';

export default defineConfig({
  title: 'Kerros',
  description: 'Open-source indoor mapping: draw connected floor plans, explore in 3D and POV, and navigate between floors.',
  base: '/kerros/',
  cleanUrls: false, // Support static hosts without extensionless-URL rewrites.
  // Docker's source-only context omits .git. There is no commit timestamp to read there.
  lastUpdated: existsSync(fileURLToPath(new URL('../../.git', import.meta.url))),
  markdown: { math: true },
  head: [
    ['meta', { name: 'theme-color', content: '#f7f7f2' }],
    ['meta', { property: 'og:title', content: 'Kerros — indoor mapping toolkit' }],
    ['meta', { property: 'og:description', content: 'Draw connected spaces on real maps. Explore buildings and navigate between floors.' }],
  ],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/schema' },
      {
        text: 'Demos',
        items: [
          { text: 'Reference editor', link: `${DEMO}/app.html` },
          { text: 'Reference viewer', link: `${DEMO}/viewer.html` },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Core concepts', link: '/guide/concepts' },
            { text: 'Space geometry & walls', link: '/guide/geometry' },
            { text: 'Spaces, zones & portals', link: '/guide/ontology' },
            { text: 'Glossary', link: '/guide/glossary' },
            { text: 'The editor', link: '/guide/editor' },
            { text: 'The viewer', link: '/guide/viewer' },
            { text: 'Theming', link: '/guide/theming' },
            { text: 'Extending', link: '/guide/extending' },
          ],
        },
        {
          text: 'Developer setup',
          items: [
            { text: 'Docker development stack', link: '/guide/development' },
            { text: 'MML vector maps', link: '/guide/mml-maps' },
            { text: 'AI import with Claude', link: '/guide/ai-import' },
            { text: 'Source analysis & calibration', link: '/guide/ai-import-analysis' },
          ],
        },
        {
          text: 'Academic interest',
          items: [{ text: 'Mathematical foundations', link: '/guide/geometry-mathematics' }],
        },
      ],
      '/reference/': [
        {
          text: 'API reference',
          items: [
            { text: '@kerros/schema', link: '/reference/schema' },
            { text: '@kerros/viewer', link: '/reference/viewer' },
            { text: '@kerros/import', link: '/reference/import' },
            { text: '@kerros/server', link: '/reference/server' },
            { text: '@kerros/editor', link: '/reference/editor' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/kherrala/kerros' }],
    search: { provider: 'local' },
    editLink: { pattern: 'https://github.com/kherrala/kerros/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the MIT License.', copyright: 'Kerros — open-source indoor mapping' },
  },
});
