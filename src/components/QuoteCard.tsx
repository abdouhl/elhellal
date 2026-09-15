import './QuoteCard.css';
import type { FlatQuote } from '../types';

interface QuoteCardProps {
    quote: FlatQuote;
}

export default function QuoteCard({ quote }: QuoteCardProps) {
    const quoteUrl = `/quotes/${encodeURIComponent(quote.authorSlug)}/${encodeURIComponent(quote.id)}/`;
    const authorUrl = `/quotes/${encodeURIComponent(quote.authorSlug)}/`;

    return (
        <li className="link-card quote-card">
            <a href={quoteUrl} className="quote-card-body" aria-label={`اقرأ اقتباس ${quote.author} كاملاً`}>
                <span className="quote-mark" aria-hidden="true">&rdquo;</span>
                <blockquote className="quote-text">{quote.text}</blockquote>
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
                    {quote.book && (
                        <a
                            href={quote.bookSlug ? `/quotes/book/${encodeURIComponent(quote.bookSlug)}/` : authorUrl}
                            className="quote-book"
                        >
                            {quote.book}
                        </a>
                    )}
                </div>
                {quote.bookCover && (
                    <img src={quote.bookCover} alt={quote.book || ''} className="quote-book-cover" loading="lazy" />
                )}
            </div>
        </li>
    );
}
