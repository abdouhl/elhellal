// Letters a Persian keyboard types that an Arabic one doesn't (ک ی پ چ ژ گ, Persian digits)
// vs. the Arabic forms Persian never uses (ك ي ة ى).
const PERSIAN_RE = /[کیپچژگ۰-۹]/g;
const ARABIC_ONLY_RE = /[كيةى]/g;

/** True when the text is Persian rather than Arabic (Persian-only letters outnumber Arabic-only ones). */
export function isPersian(text: string | null | undefined): boolean {
    if (!text) return false;
    const persian = text.match(PERSIAN_RE)?.length ?? 0;
    const arabic = text.match(ARABIC_ONLY_RE)?.length ?? 0;
    return persian >= 2 && persian > arabic;
}
