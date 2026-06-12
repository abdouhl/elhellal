import './Card.css';
import BookmarkButton from './BookmarkButton';
import { isRecentlyAdded } from '../utils/dates';

interface CardProps {
    href: string;
    title: string;
    body: string;
    screen_name?: string | undefined;
    dateAdded?: string | undefined;
    slug?: string | undefined;
    category?: string | undefined;
    image?: string | undefined;
    priority?: boolean;
}

const CF_IMAGE_BASE = 'https://img.xarticl.es/cdn-cgi/image';
const CF_R2_BASE = 'https://img.xarticl.es';

function cfImage(src: string, opts: Record<string, string | number>): string {
    const params = Object.entries(opts)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
    // src is a full R2 URL like https://img.xarticl.es/original_img_url/foo.jpg
    // strip the origin so we get just the path: /original_img_url/foo.jpg
    const path = src.startsWith(CF_R2_BASE)
        ? src.slice(CF_R2_BASE.length)
        : src;
    return `${CF_IMAGE_BASE}/${params}${path}`;
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
}: CardProps) {
    const linkUrl = slug ? `/articles/${slug}` : href;
    const isNew = isRecentlyAdded(dateAdded, 30);
    const rawImage = image || 'https://pbs.twimg.com/media/HBYKYqjbcAI9_Jp.jpg';

    const coverImage = cfImage(rawImage, {
        width: 640,
        height: 360,
        fit: 'cover',
        format: 'auto',
        quality: 80,
    });

    const coverImage2x = cfImage(rawImage, {
        width: 1280,
        height: 720,
        fit: 'cover',
        format: 'auto',
        quality: 75,
    });

    return (
        <li className="link-card">
            <div className="card-cover">
                <img
                    src={coverImage}
                    srcSet={`${coverImage} 1x, ${coverImage2x} 2x`}
                    alt={title}
                    loading={priority ? 'eager' : 'lazy'}
                    decoding={priority ? 'sync' : 'async'}
                    fetchPriority={priority ? 'high' : 'low'}
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
                    {screen_name && (
                        <span className="tag">@{screen_name}</span>
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
            {slug && (
                <div className="card-bookmark">
                    <BookmarkButton slug={slug} title={title} variant="small" />
                </div>
            )}
        </li>
    );
}