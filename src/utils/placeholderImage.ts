/**
 * Fallback cover image for personal-blog articles that have no thumb/large
 * image in their frontmatter.
 */
import { PLACEHOLDER_IMAGE } from '../lib/images';

export function getPlaceholderImage(): string {
    return PLACEHOLDER_IMAGE;
}
