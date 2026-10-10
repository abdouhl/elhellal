import { defineConfig } from 'astro/config';
import react from "@astrojs/react";
import cloudflare from "@astrojs/cloudflare";
import partytown from "@astrojs/partytown";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: 'https://elhellal.com',
  integrations: [react(), partytown(
    {
      config: {
        forward: ["dataLayer.push"],
      },
    }
  ), sitemap({
    // /articles/__shell__/ is the Worker's template, not a page; real article
    // URLs go in sitemap-articles-*.xml (scripts/build-worker-data.ts).
    filter: (page) => !page.includes('/saved') && !page.includes('/offline') && !page.includes('/notifications') && !page.includes('/404') && !page.includes('/__shell__'),
  })],
  redirects: {
    '/layla': '/authors/layla/',
    '/omar': '/authors/omar/',
    '/youssef': '/authors/youssef/',
    '/layla/[slug]': '/articles/[slug]',
    '/omar/[slug]': '/articles/[slug]',
    '/youssef/[slug]': '/articles/[slug]',
  },
  build: {
    // Inline every stylesheet (~66 KB raw / ~10 KB gzipped shared + small
    // per-page ones) so first paint doesn't wait on a CSS request. The shared
    // chunk is only called "_category_" because Vite names a shared chunk
    // after one of the pages that import it; it is Layout + feed/card styles.
    inlineStylesheets: 'always',
  },
  vite: {
    // Emit JSON imports as JSON.parse("…") instead of JS object literals — the
    // 40MB+ data files otherwise blow past Node's default heap when bundling.
    json: { stringify: true },
  },
  //output: "server",
  adapter: cloudflare()
});