// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// mero-mcp documentation — Astro Starlight with the shared Calimero theme
// (Zinc + #a5ff11 lime), matching core, calimero-sdk-js and the other SDK sites.
export default defineConfig({
  site: 'https://calimero-network.github.io',
  // GitHub project Pages serve under /<repo>/. Change if a custom domain is used.
  base: '/mero-mcp',
  integrations: [
    starlight({
      title: 'mero-mcp',
      description:
        'The stdio MCP server for Calimero — exposes node administration as MCP tools and generates one tool per method in any installed application\'s ABI, so an AI agent can drive a real node.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: 'mero-mcp',
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/theme.css'],
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        styleOverrides: {
          borderRadius: '0.5rem',
          borderColor: 'var(--sl-color-gray-6)',
          codeBackground: 'var(--sl-color-gray-7)',
          codeFontFamily: 'var(--sl-font-mono)',
          frames: {
            editorTabBarBackground: 'var(--sl-color-gray-6)',
            terminalTitlebarBackground: 'var(--sl-color-gray-6)',
          },
        },
      },
      lastUpdated: true,
      editLink: {
        baseUrl: 'https://github.com/calimero-network/mero-mcp/edit/main/docs/',
      },
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#09090b' } },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/calimero-network/mero-mcp',
        },
      ],
      // Explicit, grouped navigation: Get Started → Guides → Understand → Reference.
      sidebar: [
        { label: 'Home', link: '/' },
        {
          label: 'Get Started',
          items: ['get-started/setup', 'get-started/first-session'],
        },
        {
          label: 'Guides',
          items: [
            'guides/working-with-apps',
            'guides/contexts-and-namespaces',
            'guides/troubleshooting',
          ],
        },
        {
          label: 'Understand',
          items: [
            'understand/architecture',
            'understand/node-discovery',
            'understand/authentication',
          ],
        },
        {
          label: 'Reference',
          items: ['reference/tools', 'reference/configuration', 'reference/abi-mapping'],
        },
        {
          label: 'Contribute',
          items: ['contribute/development'],
        },
      ],
    }),
  ],
});
