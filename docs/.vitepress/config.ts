import { defineConfig } from 'vitepress';

const DEMO = 'https://kherrala.fi/kerros';

export default defineConfig({
  title: 'Kerros',
  description: 'Open-source React + MapLibre + Three.js toolkit for indoor mapping — model and visualize multi-floor premises in 2D and 3D.',
  base: '/kerros/',
  cleanUrls: false, // Support static hosts without extensionless-URL rewrites.
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#0e7c7b' }],
    ['meta', { property: 'og:title', content: 'Kerros — indoor mapping toolkit' }],
    ['meta', { property: 'og:description', content: 'Model and visualize multi-floor premises on real map geometry, in 2D and 3D.' }],
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
            { text: 'Spaces, zones & portals', link: '/guide/ontology' },
            { text: 'Glossary', link: '/guide/glossary' },
            { text: 'The editor', link: '/guide/editor' },
            { text: 'The viewer', link: '/guide/viewer' },
            { text: 'Theming', link: '/guide/theming' },
            { text: 'Extending', link: '/guide/extending' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'API reference',
          items: [
            { text: '@kerros/schema', link: '/reference/schema' },
            { text: '@kerros/viewer', link: '/reference/viewer' },
            { text: '@kerros/import', link: '/reference/import' },
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
