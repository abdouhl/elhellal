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
    filter: (page) => !page.includes('/saved') && !page.includes('/404'),
  })],
  redirects: {
    '/layla': '/authors/layla',
    '/omar': '/authors/omar',
    '/youssef': '/authors/youssef',
    '/layla/[slug]': '/articles/[slug]',
    '/omar/[slug]': '/articles/[slug]',
    '/youssef/[slug]': '/articles/[slug]',
  },
  //output: "server",
  adapter: cloudflare()
});