import { useState } from 'react';
import './QuoteCard.css';
import type { FlatQuote } from '../types';

interface QuoteCardProps {
    quote: FlatQuote;
}

/**
 * BrainyQuote-style auto-sizing: short quotes get a big, poster-like
 * treatment; long ones shrink (and get more line-clamp room) so they still
 * read comfortably in the same card footprint instead of overflowing.
 */
function sizeTier(text: string): 'xl' | 'lg' | 'md' | 'sm' {
    const len = text.length;
    if (len <= 50) return 'xl';
    if (len <= 100) return 'lg';
    if (len <= 170) return 'md';
    return 'sm';
}

/** Renders one of two distinct card types: a book-sourced quote (cover + badge) or an author-only quote (large quote mark). */
export default function QuoteCard({ quote }: QuoteCardProps) {
    return quote.book ? <BookQuoteCard quote={quote} /> : <AuthorQuoteCard quote={quote} />;
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    return (
        <button
            type="button"
            className={`quote-copy-btn${copied ? ' quote-copy-btn--done' : ''}`}
            aria-label="نسخ نص الاقتباس"
            title="نسخ الاقتباس"
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                navigator.clipboard?.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                });
            }}
        >
            {copied ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256">
                    <path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z" />
                </svg>
            )}
        </button>
    );
}

function QuoteTags({ tags }: { tags?: string[] }) {
    if (!tags || tags.length === 0) return null;
    return (
        <div className="quote-topics" aria-label="مواضيع الاقتباس">
            {tags.slice(0, 2).map((tag) => (
                <span key={tag} className="quote-topic">{tag}</span>
            ))}
        </div>
    );
}

function AuthorQuoteCard({ quote }: QuoteCardProps) {
    const quoteUrl = `/quotes/${encodeURIComponent(quote.authorSlug)}/${encodeURIComponent(quote.id)}/`;
    const authorUrl = `/quotes/${encodeURIComponent(quote.authorSlug)}/`;
    const tier = sizeTier(quote.text);

    return (
        <li className="link-card quote-card quote-card--author">
            <CopyButton text={`"${quote.text}" — ${quote.author}`} />
            <a href={quoteUrl} className="quote-card-body" aria-label={`اقرأ اقتباس ${quote.author} كاملاً`}>
                <span className="quote-mark" aria-hidden="true">&rdquo;</span>
                <blockquote className={`quote-text quote-text-${tier}`}>{quote.text}</blockquote>
                <QuoteTags tags={quote.tags} />
            </a>
            <div className="quote-attribution">
                {quote.authorImage ? (
                    <img
                        src={quote.authorImage}
                        alt={quote.author}
                        className="quote-author-avatar"
                        loading="lazy"
                        width={36}
                        height={36}
                    />
                ) : (
                    <span className="quote-author-avatar quote-author-avatar-fallback" aria-hidden="true">
                        {quote.author.trim().charAt(0)}
                    </span>
                )}
                <div className="quote-attribution-text">
                    <a href={authorUrl} className="quote-author">{quote.author}</a>
                    <span className="quote-kind">اقتباس مباشر</span>
                </div>
            </div>
        </li>
    );
}

function BookQuoteCard({ quote }: QuoteCardProps) {
    const quoteUrl = `/quotes/${encodeURIComponent(quote.authorSlug)}/${encodeURIComponent(quote.id)}/`;
    const authorUrl = `/quotes/${encodeURIComponent(quote.authorSlug)}/`;
    const bookUrl = quote.bookSlug ? `/quotes/book/${encodeURIComponent(quote.bookSlug)}/` : authorUrl;
    const tier = sizeTier(quote.text);

    return (
        <li className="link-card quote-card quote-card--book">
            <CopyButton text={`"${quote.text}" — ${quote.author}، ${quote.book}`} />
            <a href={quoteUrl} className="quote-card-body" aria-label={`اقرأ اقتباساً من كتاب ${quote.book} كاملاً`}>
                <div className="quote-book-header">
                    {quote.bookCover ? (
                        <img
                            src={quote.bookCover}
                            alt={quote.book || ''}
                            className="quote-book-thumb"
                            loading="lazy"
                            width={40}
                            height={58}
                        />
                    ) : (
                        <span className="quote-book-thumb quote-book-thumb-fallback" aria-hidden="true">📖</span>
                    )}
                    <span className="quote-book-heading">
                        <span className="quote-book-badge">من كتاب</span>
                        <span className="quote-book-title">{quote.book}</span>
                    </span>
                </div>
                <blockquote className={`quote-text quote-text--book quote-text-${tier}`}>{quote.text}</blockquote>
                <QuoteTags tags={quote.tags} />
            </a>
            <div className="quote-attribution quote-attribution--book">
                {quote.authorImage ? (
                    <img
                        src={quote.authorImage}
                        alt={quote.author}
                        className="quote-author-avatar quote-author-avatar--sm"
                        loading="lazy"
                        width={26}
                        height={26}
                    />
                ) : (
                    <span className="quote-author-avatar quote-author-avatar-fallback quote-author-avatar--sm" aria-hidden="true">
                        {quote.author.trim().charAt(0)}
                    </span>
                )}
                <a href={authorUrl} className="quote-author quote-author--book">{quote.author}</a>
                <a href={bookUrl} className="quote-book-link">الكتاب ←</a>
            </div>
        </li>
    );
}
