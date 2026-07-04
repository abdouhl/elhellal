import { getCollection } from 'astro:content';
import { personalBlogs } from '../data/personal-blogs';
import { getPlaceholderImage } from './placeholderImage';
import type { ArticleWithCategory } from '../types';

// Personal blog topics map onto existing (otherwise thin) articles.json categories
// so they surface in the feed under nav tabs that already exist — no new category needed.
const CATEGORY_BY_PERSON: Record<'omar' | 'layla' | 'youssef', string> = {
    omar: 'technology',
    layla: 'environment',
    youssef: 'economics',
};

export async function getPersonalBlogFeedArticles(): Promise<ArticleWithCategory[]> {
    const collections = ['omar', 'layla', 'youssef'] as const;

    const results = await Promise.all(
        collections.map(async (collection) => {
            const person = personalBlogs[collection];
            const posts = await getCollection(collection);

            return posts.map((post): ArticleWithCategory => ({
                id_str: post.slug,
                title: post.data.title,
                preview_text: post.data.description,
                original_img_url:
                    post.data.thumb || post.data.large || getPlaceholderImage(),
                screen_name: person.slug,
                created_at: post.data.pubDate.toISOString().slice(0, 10),
                slug: post.slug,
                authorName: person.nameAr,
                authorHref: `/authors/${collection}`,
                category: CATEGORY_BY_PERSON[collection],
            }));
        })
    );

    return results.flat();
}
