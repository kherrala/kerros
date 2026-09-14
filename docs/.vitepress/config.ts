import { defineConfig } from 'vitepress';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const academic = {
  text: 'Academic interest',
  items: [
    { text: 'Mathematical foundations', link: '/guide/geometry-mathematics' },
    { text: 'Graph theory', link: '/academic/graph-theory' },
    { text: 'Computational topology', link: '/academic/computational-topology' },
    { text: 'Geometric computation', link: '/academic/geometric-computation' },
    { text: 'Geometry & topology validation', link: '/academic/validation' },
    { text: 'Image analysis & calibration', link: '/academic/image-analysis' },
  ],
};

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
          { text: 'Reference editor', link: '/app.html', target: '_self' },
          { text: 'Reference viewer', link: '/viewer.html', target: '_self' },
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
            { text: 'Import features', link: '/guide/ai-import' },
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
            { text: 'Source analysis & calibration', link: '/guide/ai-import-analysis' },
          ],
        },
        academic,
      ],
      '/academic/': [academic],
      '/reference/': [
        {
          text: 'API reference',
          items: [
            { text: '@kerros/schema', link: '/reference/schema' },
            { text: 'Portable project format', link: '/reference/portable-format' },
            { text: '@kerros/viewer', link: '/reference/viewer' },
            { text: '@kerros/import', link: '/reference/import' },
            { text: '@kerros/server', link: '/reference/server' },
            { text: 'AI import engine & integration', link: '/reference/ai-import' },
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
