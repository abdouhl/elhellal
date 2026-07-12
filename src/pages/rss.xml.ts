import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import data from '../data/articles.json';
import { getPersonalBlogFeedArticles } from '../utils/personalBlogFeed';

const MAX_ITEMS = 60;

export async function GET(context: APIContext) {
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

  const items = [...categoryArticles, ...personalArticles]
    .filter((item) => item.slug && item.pubDate)
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime())
    .slice(0, MAX_ITEMS);

  return rss({
    title: 'الهلال — أفضل المقالات العربية',
    description: 'دليل منتقى لأفضل المقالات العربية على الإنترنت',
    site: context.site ?? 'https://elhellal.com',
    items: items.map((item) => ({
      title: item.title,
      description: item.description,
      pubDate: new Date(item.pubDate),
      link: `/articles/${item.slug}/`,
      categories: item.category ? [item.category] : undefined,
    })),
    customData: `<language>ar</language>`,
  });
}
