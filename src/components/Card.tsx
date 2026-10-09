import './Card.css';
import BookmarkButton from './BookmarkButton';
import { isRecentlyAdded } from '../utils/dates';
import { getPlaceholderImage } from '../utils/placeholderImage';
import authorNames from '../data/author-names.json';
import { CARD_SIZES, CARD_WIDTHS, isImageUrl, responsiveImage } from '../lib/images';

interface CardProps {
    href: string;
    title: string;
    body: string;
    screen_name?: string | undefined;
    dateAdded?: string | undefined;
    slug?: string | undefined;
    category?: string | undefined;
    image?: string | undefined;
    /** The page's likely LCP image: loads first, at high priority */
    priority?: boolean;
    /** Above the fold on wide screens: skips lazy-loading, at normal priority */
    eager?: boolean;
    /** Shows a numbered rank badge (used by the "الأكثر قراءة" section) */
    rank?: number;
    /** Overrides the default /authors/{screen_name} link (used by personal-blog cards) */
    authorHref?: string | undefined;
    /** Overrides the default @{screen_name} label (used by personal-blog cards) */
    authorLabel?: string | undefined;
    /** Overrides the default href/slug-derived link */
    internalHref?: string | undefined;
}

export default function Card({
    href,
    title,
    body,
    screen_name,
    dateAdded,
    slug,
    category,
    image,
    priority = false,
    eager = false,
    rank,
    authorHref,
    authorLabel,
    internalHref,
}: CardProps) {
    //const linkUrl = internalHref || (slug ? `/articles/${slug}` : href);
    const linkUrl = internalHref || (slug ? `/articles/${encodeURIComponent(slug)}/` : href);
    const isNew = isRecentlyAdded(dateAdded, 30);
    const cover = responsiveImage(isImageUrl(image) ? image : getPlaceholderImage(), CARD_WIDTHS);

    return (
        <li className="link-card">
            {typeof rank === 'number' && <span className="card-rank">{rank}</span>}
            <div className="card-cover">
                <img
                    src={cover.src}
                    srcSet={cover.srcset}
                    sizes={cover.srcset ? CARD_SIZES : undefined}
                    alt={title}
                    loading={priority || eager ? 'eager' : 'lazy'}
                    decoding="async"
                    fetchPriority={priority ? 'high' : eager ? 'auto' : 'low'}
                    width={640}
                    height={360}
                />
                <p className="distribution">
                    {isNew && (
                        <span className="tag tag-new" title="Recently added" aria-label="New item">
                            🔥
                        </span>
                    )}
                    {category && (
                        <span className="tag">{category}</span>
                    )}
                </p>
            </div>
            <a
                href={linkUrl}
                aria-label={`Read article: ${title}`}
                onClick={() => {
                    window.dispatchEvent(new CustomEvent('articles:save-state'));
                }}
            >
                <strong className="nu-c-helper-text nu-u-mt-1 nu-u-mb-1">{title}</strong>
            </a>
            {screen_name && (
                <a href={authorHref || `/authors/${encodeURIComponent(screen_name)}/`} className="card-author">
                    {authorLabel || (authorNames as Record<string, string>)[screen_name] || `@${screen_name}`}
                </a>
            )}
            {slug && (
                <div className="card-bookmark">
                    <BookmarkButton slug={slug} title={title} variant="small" />
                </div>
            )}
        </li>
    );
}