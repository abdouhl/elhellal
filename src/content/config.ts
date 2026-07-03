import { defineCollection, z } from 'astro:content';

const personalBlogSchema = z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    thumb: z.string().optional(),
    large: z.string().optional(),
});

export const collections = {
    omar: defineCollection({ type: 'content', schema: personalBlogSchema }),
    layla: defineCollection({ type: 'content', schema: personalBlogSchema }),
    youssef: defineCollection({ type: 'content', schema: personalBlogSchema }),
};
