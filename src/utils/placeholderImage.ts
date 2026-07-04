/**
 * Generates a branded SVG placeholder (as a data URI) for personal-blog articles
 * that have no thumb/large image in their frontmatter. Reuses the site's crescent
 * moon logo motif tinted with the author's accent color.
 */
export function getPlaceholderImage(nameAr: string, accent: string): string {
    const darker = shadeColor(accent, -55);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="640" y2="360" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${darker}"/>
    </linearGradient>
    <mask id="crescent">
      <rect x="480" y="20" width="150" height="150" fill="white"/>
      <circle cx="600" cy="65" r="48" fill="black"/>
    </mask>
  </defs>
  <rect width="640" height="360" fill="url(#bg)"/>
  <circle cx="565" cy="85" r="55" fill="rgba(255,255,255,0.92)" mask="url(#crescent)"/>
  <text x="600" y="300" text-anchor="end" direction="rtl" font-family="Tahoma, Arial, sans-serif" font-size="34" font-weight="700" fill="rgba(255,255,255,0.95)">${escapeXml(nameAr)}</text>
</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function shadeColor(hex: string, percent: number): string {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const r = Math.min(255, Math.max(0, (num >> 16) + amt));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amt));
    const b = Math.min(255, Math.max(0, (num & 0xff) + amt));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
