import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { loadArticles } from '../lib/articles-data';
import { getPersonalBlogFeedArticles } from '../utils/personalBlogFeed';

const MAX_ITEMS = 60;
/** Up to this many items are kept for articles written on elhellal. */
const NATIVE_RESERVE = 20;

export async function GET(context: APIContext) {
  const data = loadArticles();
  const categoryArticles = (data.articles as any[]).flatMap((category) =>
    category.content.map((article: any) => ({
      title: article.title,
      description: article.preview_text,
      pubDate: article.created_at,
      slug: article.slug,
      category: category.title,
    }))
  );

  const personalArticles = (await getPersonalBlogFeedArticles()).map((article) => ({
    title: article.title,
    description: article.preview_text,
    pubDate: article.created_at,
    slug: article.slug,
    category: article.authorName,
  }));

  const newest = (a: { pubDate: string }, b: { pubDate: string }) =>
    new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();
  const valid = (item: { slug?: string; pubDate: string }) => !!item.slug && !!item.pubDate;
  // Native posts (personal blogs + reader articles) get a reserved share of the
  // feed so a big import day doesn't push them out, then everything by date.
  const native = personalArticles.filter(valid).sort(newest).slice(0, NATIVE_RESERVE);
  const rest = categoryArticles.filter(valid).sort(newest).slice(0, MAX_ITEMS - native.length);
  const items = [...native, ...rest].sort(newest);

  return rss({
    title: 'الهلال — أفضل المقالات العربية',
    description: 'دليل منتقى لأفضل المقالات العربية على الإنترنت',
    site: context.site ?? 'https://elhellal.com',
    items: items.map((item) => ({
      title: item.title,
      description: item.description,
      pubDate: new Date(item.pubDate),
      link: `/articles/${encodeURIComponent(item.slug)}/`,
      categories: item.category ? [item.category] : undefined,
    })),
    customData: `<language>ar</language>`,
  });
}
