import { getCollection, type CollectionEntry } from 'astro:content';
import { HOUSE_COLLECTION, type PersonalBlogPerson } from '../data/personal-blogs';
import type { Origin } from '../lib/native';

/** Fields every persona post has, whichever collection it lives in. */
export type PersonPost = CollectionEntry<'omar'>;

let house: CollectionEntry<'house'>[] | undefined;

/** A persona's posts: its own collection, or its share of src/content/house/. */
export async function getPersonPosts(person: PersonalBlogPerson): Promise<PersonPost[]> {
    if (person.collection === HOUSE_COLLECTION) {
        house ??= await getCollection('house');
        return house.filter((p) => p.data.persona === person.slug) as unknown as PersonPost[];
    }
    return getCollection(person.collection as 'omar');
}

export function personOrigin(person: PersonalBlogPerson): Origin {
    return person.collection === HOUSE_COLLECTION ? 'persona' : 'personal';
}
