// Links in reader-written articles (src/content/community/) get
// rel="nofollow ugc noopener" and open in a new tab: they pass no ranking,
// which keeps link spammers' incentive low (and is what Google asks of UGC).
export default function rehypeUgcLinks() {
    return (tree, file) => {
        const path = String(file?.path ?? file?.history?.[0] ?? '');
        if (!/[\\/]content[\\/]community[\\/]/.test(path)) return;
        const walk = (node) => {
            if (node.type === 'element' && node.tagName === 'a') {
                const href = String(node.properties?.href ?? '');
                if (/^https?:/i.test(href) && !/^https?:\/\/(www\.)?elhellal\.com/i.test(href)) {
                    node.properties.rel = ['nofollow', 'ugc', 'noopener'];
                    node.properties.target = '_blank';
                }
            }
            for (const child of node.children ?? []) walk(child);
        };
        walk(tree);
    };
}
