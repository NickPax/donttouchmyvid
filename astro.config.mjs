import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://donttouchmyvid.com',
  output: 'static',
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      // Empty entries stops esbuild from trying to scan .astro files itself.
      entries: [],
      include: ['mp4box', 'mp4-muxer'],
    },
    worker: {
      // ES-format workers so we can `import` mp4box / share helpers between
      // main thread and the encoder worker.
      format: 'es',
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'mp4box': ['mp4box'],
            'mp4-muxer': ['mp4-muxer'],
          },
        },
      },
    },
  },
  build: {
    inlineStylesheets: 'auto',
  },
  compressHTML: true,
});
