// Markdown <-> contenteditable HTML for the article editors (/write/ and
// /editor/). The editors hold rich HTML; markdown is what gets submitted,
// imported and exported. Only the subset the editors produce is handled:
// ## / ### headings, paragraphs, > quotes, - and 1. lists, ---, images,
// **bold**, *italic*, ~~strike~~ and links.


export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function inlineMd(s: string): string {
    return s
        .replace(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1">')
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/** Markdown (as the editor writes it, or as pasted/old drafts have it) → editor HTML. */
export function mdToHtml(md: string): string {
    return escapeHtml(md.replace(/\r\n?/g, "\n"))
        .split(/\n{2,}/)
        .map((block) => {
            const b = block.trim();
            if (!b) return "";
            const img = b.match(/^!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)$/);
            if (img) return `<figure contenteditable="false"><img src="${img[2]}" alt="${img[1]}"></figure>`;
            if (/^(-{3,}|\*{3,})$/.test(b)) return "<hr>";
            if (/^###\s/.test(b)) return `<h3>${inlineMd(b.slice(4))}</h3>`;
            if (/^#{1,2}\s/.test(b)) return `<h2>${inlineMd(b.replace(/^#{1,2}\s/, ""))}</h2>`;
            if (/^&gt;\s?/.test(b))
                return `<blockquote>${b.replace(/^&gt;\s?/gm, "").split("\n").map((l) => `<p>${inlineMd(l) || "<br>"}</p>`).join("")}</blockquote>`;
            if (/^[-*]\s/.test(b)) return `<ul>${b.split("\n").map((l) => `<li>${inlineMd(l.replace(/^[-*]\s/, ""))}</li>`).join("")}</ul>`;
            if (/^\d+[.)]\s/.test(b)) return `<ol>${b.split("\n").map((l) => `<li>${inlineMd(l.replace(/^\d+[.)]\s/, ""))}</li>`).join("")}</ol>`;
            return `<p>${inlineMd(b).replace(/\n/g, "<br>")}</p>`;
        })
        .join("");
}

/** Images the markdown keeps: https only, unless an export asks for local (data:) ones too. */
let imgOk = (src: string) => /^https:\/\//.test(src);

export const BLOCK = /^(P|DIV|H[1-6]|BLOCKQUOTE|UL|OL|LI|HR|FIGURE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|PRE|TABLE)$/;

/** "**" around " x " has to become " **x** " or markdown ignores it. */
function mark(m: string, s: string): string {
    const [, lead, core, trail] = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return core ? `${lead}${m}${core}${m}${trail}` : s;
}

function inlineOf(node: Node): string {
    let out = "";
    node.childNodes.forEach((n) => {
        if (n.nodeType === Node.TEXT_NODE) {
            out += (n.textContent ?? "").replace(/ /g, " ").replace(/\s*\n\s*/g, " ");
            return;
        }
        if (!(n instanceof HTMLElement)) return;
        const tag = n.tagName;
        const style = n.getAttribute("style") ?? "";
        if (tag === "BR") out += "\n";
        else if (tag === "IMG") {
            const src = (n as HTMLImageElement).getAttribute("src") ?? "";
            if (imgOk(src)) out += `![${(n as HTMLImageElement).alt}](${src})`;
        } else if (tag === "A") {
            const href = n.getAttribute("href") ?? "";
            const text = inlineOf(n);
            out += /^https?:\/\//.test(href) && text.trim() ? `[${text.trim()}](${href})` : text;
        } else if (tag === "B" || tag === "STRONG" || /font-weight:\s*(bold|[6-9]00)/.test(style)) out += mark("**", inlineOf(n));
        else if (tag === "I" || tag === "EM" || /font-style:\s*italic/.test(style)) out += mark("*", inlineOf(n));
        else if (tag === "S" || tag === "STRIKE" || tag === "DEL" || /line-through/.test(style)) out += mark("~~", inlineOf(n));
        else if (BLOCK.test(tag)) out += "\n" + inlineOf(n) + "\n";
        else out += inlineOf(n);
    });
    return out;
}

const clean = (s: string) => s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();

function blocksOf(root: Node): string[] {
    const out: string[] = [];
    let loose = "";
    const flush = () => {
        const t = clean(loose);
        if (t) out.push(t);
        loose = "";
    };
    root.childNodes.forEach((n) => {
        if (!(n instanceof HTMLElement) || !BLOCK.test(n.tagName)) {
            loose += n instanceof HTMLElement ? inlineOf({ childNodes: [n] } as unknown as Node) : (n.textContent ?? "").replace(/\s+/g, " ");
            return;
        }
        flush();
        const tag = n.tagName;
        if (tag === "HR") out.push("---");
        else if (tag === "FIGURE") {
            const img = n.querySelector("img");
            if (img && imgOk(img.getAttribute("src") ?? "")) out.push(`![${img.alt}](${img.getAttribute("src")})`);
        } else if (tag === "H1" || tag === "H2") {
            const t = clean(inlineOf(n)).replace(/\n/g, " ");
            if (t) out.push(`## ${t}`);
        } else if (/^H[3-6]$/.test(tag)) {
            const t = clean(inlineOf(n)).replace(/\n/g, " ");
            if (t) out.push(`### ${t}`);
        } else if (tag === "BLOCKQUOTE") {
            const inner = blocksOf(n).join("\n\n").replace(/^(#+|>)\s*/gm, "");
            if (inner) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        } else if (tag === "UL" || tag === "OL") {
            const items = [...n.children].filter((li) => li.tagName === "LI").map((li) => clean(inlineOf(li)).replace(/\n+/g, " ")).filter(Boolean);
            if (items.length) out.push(items.map((t, i) => (tag === "OL" ? `${i + 1}. ${t}` : `- ${t}`)).join("\n"));
        } else if (tag === "LI") {
            const t = clean(inlineOf(n));
            if (t) out.push(`- ${t}`);
        } else if ([...n.children].some((c) => BLOCK.test(c.tagName))) out.push(...blocksOf(n));
        else {
            const t = clean(inlineOf(n));
            if (t) out.push(t);
        }
    });
    flush();
    return out;
}

export function htmlToMd(root: Node, opts: { dataImages?: boolean } = {}): string {
    const keep = imgOk;
    if (opts.dataImages) imgOk = (src) => /^(https:\/\/|data:image\/)/.test(src);
    try {
        return blocksOf(root).join("\n\n");
    } finally {
        imgOk = keep;
    }
}
