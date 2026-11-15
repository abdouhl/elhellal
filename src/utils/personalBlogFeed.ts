import { getCollection } from 'astro:content';
import { PERSONAS } from '../data/personal-blogs';
import { getPlaceholderImage } from './placeholderImage';
import { getPersonPosts, personOrigin } from './personPosts';
import type { ArticleWithCategory } from '../types';

// Persona posts sit in the persona's catalog category (src/data/personas.json), usually a
// thin one, so they surface in the feed under nav tabs that already exist.
export async function getPersonalBlogFeedArticles(): Promise<ArticleWithCategory[]> {
    const results = await Promise.all(
        PERSONAS.map(async (person) => {
            const posts = await getPersonPosts(person);

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
                authorHref: `/authors/${person.slug}/`,
                category: person.category,
                origin: personOrigin(person),
            }));
        })
    );

    // Reader-written articles sit in the category the writer picked.
    const community = (await getCollection('community')).map((post): ArticleWithCategory => ({
        id_str: post.slug,
        title: post.data.title,
        preview_text: post.data.description,
        original_img_url: post.data.thumb || post.data.large || getPlaceholderImage(),
        screen_name: 'community',
        created_at: post.data.pubDate.toISOString().slice(0, 10),
        slug: post.slug,
        authorName: post.data.author,
        // No author pages for readers yet: the name opens the article.
        authorHref: `/articles/${encodeURIComponent(post.slug)}/`,
        category: post.data.category,
        origin: 'write',
    }));

    return [...results.flat(), ...community];
}
