import { useEffect } from 'react';

declare global {
    interface Window {
        __elhellalLoadAds?: () => void;
        adsbygoogle?: unknown[];
    }
}

export default function AdCard() {
    useEffect(() => {
        // Layout.astro's global scanner fills any waiting <ins>; call it directly
        // here since infinite-scroll cards mount outside the astro:page-load cycle.
        if (typeof window !== 'undefined' && window.__elhellalLoadAds) {
            window.__elhellalLoadAds();
        }
    }, []);

    return (
        <li className="link-card ad-card" aria-label="إعلان">
            <span className="ad-card-label">إعلان</span>
            <ins
                className="adsbygoogle"
                style={{ display: 'block' }}
                data-ad-client="ca-pub-3610150616518651"
                data-ad-slot="5264595655"
                data-ad-format="fluid"
                data-ad-layout-key="-6s+d0-1b+7l+2b"
            ></ins>
        </li>
    );
}
