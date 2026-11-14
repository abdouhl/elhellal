import { defineCollection, z } from 'astro:content';

const personalBlogSchema = z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    thumb: z.string().optional(),
    large: z.string().optional(),
});

// Articles readers write on /write/: queued in the push Worker's D1
// (submissions), approved in the admin panel, which writes them here.
const communitySchema = personalBlogSchema.extend({
    author: z.string(),
    authorUrl: z.string().url().optional(),
    category: z.string(),
});

export const collections = {
    omar: defineCollection({ type: 'content', schema: personalBlogSchema }),
    layla: defineCollection({ type: 'content', schema: personalBlogSchema }),
    youssef: defineCollection({ type: 'content', schema: personalBlogSchema }),
    yacine: defineCollection({ type: 'content', schema: personalBlogSchema }),
    community: defineCollection({ type: 'content', schema: communitySchema }),
};
