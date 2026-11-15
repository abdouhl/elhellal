// House writers ("personas"): the editorial characters whose articles are written on
// elhellal with AI help. Defined in personas.json, which the admin panel's Personas tab
// edits — add a persona there, not here.
//
// The first four have a content collection each (src/content/<slug>/); every persona
// added since shares src/content/house/, where each post names its writer in
// `persona:` frontmatter.
import data from './personas.json';

export interface PersonalBlogPerson {
    slug: string;
    /** Content collection holding the posts: the slug for the first four, else HOUSE_COLLECTION. */
    collection: string;
    nameAr: string;
    nameLatin: string;
    tagline: string;
    bio: string;
    accent: string;
    /** Catalog category the posts appear under in feeds. */
    category: string;
    /** Writing-voice notes for the generator (not shown on the site). */
    voice?: string;
    topics?: string[];
    /** Inactive personas keep their pages but get no new drafts. */
    active?: boolean;
}

export const HOUSE_COLLECTION = 'house';

/** The original personas' own collections (src/content/config.ts defines each). */
export const PERSONAL_COLLECTIONS = ['omar', 'layla', 'youssef', 'yacine'] as const;

export const PERSONAS: PersonalBlogPerson[] = data.personas;

export const personalBlogs: Record<string, PersonalBlogPerson> = Object.fromEntries(PERSONAS.map((p) => [p.slug, p]));
