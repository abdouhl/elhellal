#!/usr/bin/env bun
/**
 * Content moderation for the catalog: has Claude classify every article
 * against the site's editorial policy (see POLICY below), then removes the
 * ones that violate it and blocklists them so the importers never re-add them.
 *
 * Usage:
 *   bun run moderate                     # classify every article without a verdict yet
 *   bun run moderate --limit 200         # classify a sample first, to check quality/cost
 *   bun run moderate --category politics # only one category
 *   bun run moderate --recheck           # re-classify articles that already have a verdict
 *   bun run moderate --model claude-haiku-5-5
 *   bun run moderate report              # summary + src/data/moderation/report.md
 *   bun run moderate apply               # remove "remove" verdicts + blocked authors' articles
 *
 * Classification goes through the Message Batches API (half price, usually
 * done within the hour). The batch ids are saved in
 * src/data/moderation/pending.json, so if the script is interrupted, running
 * it again resumes waiting for the same batches instead of paying twice.
 *
 * Nothing is removed until `apply`. Verdicts are one of:
 *   keep    — fine
 *   review  — borderline; listed in report.md for you to decide in overrides.json
 *   remove  — clearly violates the policy
 * src/data/moderation/overrides.json ({ "<id_str>": "keep" | "remove" }) always
 * wins over the model. Add a Substack username to blocklist.json's "authors"
 * to drop everything from that author.
 *
 * The model only sees the title, preview_text and tldr — not the full post.
 *
 * Requires ANTHROPIC_API_KEY (Bun loads it from .env).
 */

import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Article } from '../src/types/index.ts';
import { readArticles, writeArticles } from '../src/lib/articles-store.ts';
import {
    MODERATION_DIR,
    REASONS,
    type Decision,
    type Reason,
    type Verdict,
    loadBlocklist,
    loadOverrides,
    loadVerdicts,
    saveBlocklist,
    saveVerdicts,
} from './lib/moderation.ts';

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-opus-5-5';
const BATCH_SIZE = 10_000;
const POLL_MS = 60_000;
const PENDING_FILE = path.join(MODERATION_DIR, 'pending.json');
const REPORT_FILE = path.join(MODERATION_DIR, 'report.md');

const POLICY = `You review articles for elhellal, a directory of Arabic articles curated for a Muslim, Arabic-speaking readership. For each article you decide whether it belongs on the site.

Remove an article when its own content clearly does one of the following:

- israel_propaganda: advocates for Israel or Zionism; justifies, excuses or whitewashes the occupation, settlement, or Israeli military actions against Palestinians, Lebanese or others; promotes normalization with Israel; or relays the Israeli army's or government's messaging as fact (e.g. Avichay Adraee-style statements, "human shields" framing used to justify killing civilians).
- hate_speech: dehumanizes or incites hatred or violence against people for their religion, sect, ethnicity, race or nationality — including against Jews as a people, Christians, Shia or Sunni Muslims, Africans, migrants, or any other group. Takfir aimed at whole communities counts.
- anti_islam: mocks or insults God, the Prophet ﷺ, the Quran, the Companions or Islamic rituals, or exists mainly to attack Islam itself.
- sexual: explicit sexual content.
- vice_promotion: promotes or glamorizes alcohol, drugs or gambling/betting.

Keep, and don't flag, articles that only discuss these subjects:
- News, analysis and history of Israel, the occupation and the war — including critical analysis of Israeli politics, translations or quotations of Israeli sources presented in order to analyze or rebut them, and coverage of Israeli society.
- Criticism of governments, religious institutions, scholars or movements, theological debate, comparative religion, and academic discussion of religion — including disagreement with you or with mainstream views.
- Medical, scientific or social discussion of sexuality, addiction or gambling.
- Political opinions you disagree with that don't fall into the categories above.

Decide on what the text actually says, not on the author's name or the topic. You only see the title, an excerpt and a summary, not the full article:
- decision "remove": the excerpt clearly shows a violation.
- decision "review": a violation is plausible but the excerpt is ambiguous or too short to tell.
- decision "keep": everything else. Most articles are "keep".

"reasons" lists the categories that apply (empty for "keep"). "note" is one short English sentence explaining a "remove" or "review" decision, quoting the decisive phrase when there is one; empty for "keep".`;

const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        decision: { type: 'string', enum: ['keep', 'review', 'remove'] },
        reasons: { type: 'array', items: { type: 'string', enum: [...REASONS] } },
        note: { type: 'string' },
    },
    required: ['decision', 'reasons', 'note'],
    additionalProperties: false,
};

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'classify';
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : (args[i + 1] ?? '');
};
const model = flag('model') || DEFAULT_MODEL;
const limit = flag('limit') ? Number(flag('limit')) : Infinity;
const onlyCategory = flag('category');
const recheck = args.includes('--recheck');

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Pending {
    model: string;
    batchIds: string[];
    /** custom_id → id_str (custom_id only allows [a-zA-Z0-9_-]). */
    ids: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function allArticles(): { category: string; article: Article }[] {
    return readArticles().articles.flatMap((c) =>
        c.content.map((article) => ({ category: c.category, article })),
    );
}

function userPrompt(a: Article): string {
    return [
        `Title: ${a.title}`,
        `Author: @${a.screen_name}`,
        `Excerpt: ${a.preview_text || '(none)'}`,
        a.tldr ? `Summary: ${a.tldr}` : '',
    ]
        .filter(Boolean)
        .join('\n');
}

/** The decision that counts: your override, else the model's verdict. */
function finalDecision(
    id: string,
    verdicts: Record<string, Verdict>,
    overrides: Record<string, 'keep' | 'remove'>,
): Decision | undefined {
    return overrides[id] ?? verdicts[id]?.decision;
}

// ─── classify ─────────────────────────────────────────────────────────────────

async function submit(client: Anthropic): Promise<Pending | null> {
    const verdicts = loadVerdicts();
    const overrides = loadOverrides();

    const todo = allArticles()
        .filter(({ category }) => !onlyCategory || category === onlyCategory)
        .map(({ article }) => article)
        .filter((a) => recheck || !verdicts[a.id_str])
        .filter((a) => !overrides[a.id_str])
        .slice(0, limit);

    if (todo.length === 0) {
        console.log('✅ Every article already has a verdict. Use --recheck to redo them.');
        return null;
    }

    const pending: Pending = { model, batchIds: [], ids: {} };
    for (let start = 0; start < todo.length; start += BATCH_SIZE) {
        const chunk = todo.slice(start, start + BATCH_SIZE);
        const requests = chunk.map((a, i) => {
            const customId = `a${start + i}`;
            pending.ids[customId] = a.id_str;
            return {
                custom_id: customId,
                params: {
                    model,
                    max_tokens: 4000,
                    system: POLICY,
                    output_config: {
                        effort: 'low' as const,
                        format: { type: 'json_schema' as const, schema: OUTPUT_SCHEMA },
                    },
                    messages: [{ role: 'user' as const, content: userPrompt(a) }],
                },
            };
        });
        const batch = await client.messages.batches.create({ requests });
        pending.batchIds.push(batch.id);
        console.log(`📤 Submitted batch ${batch.id} (${chunk.length} articles)`);
    }

    fs.mkdirSync(MODERATION_DIR, { recursive: true });
    fs.writeFileSync(PENDING_FILE, `${JSON.stringify(pending, null, 2)}\n`);
    console.log(`📝 ${todo.length} article(s) submitted to ${model}`);
    return pending;
}

async function collect(client: Anthropic, pending: Pending) {
    for (const batchId of pending.batchIds) {
        while (true) {
            const batch = await client.messages.batches.retrieve(batchId);
            if (batch.processing_status === 'ended') break;
            const c = batch.request_counts;
            console.log(
                `⏳ ${batchId}: ${c.succeeded + c.errored} done, ${c.processing} processing — checking again in ${POLL_MS / 1000}s`,
            );
            await sleep(POLL_MS);
        }
    }

    const verdicts = loadVerdicts();
    const at = new Date().toISOString().slice(0, 10);
    let ok = 0;
    let failed = 0;

    for (const batchId of pending.batchIds) {
        for await (const result of await client.messages.batches.results(batchId)) {
            const id = pending.ids[result.custom_id];
            if (!id) continue;

            if (result.result.type !== 'succeeded') {
                failed++;
                console.warn(`⚠️  ${id}: ${result.result.type} — will be retried on the next run`);
                continue;
            }
            const message = result.result.message;
            if (message.stop_reason === 'refusal') {
                // A refused article is one a human should look at.
                verdicts[id] = { decision: 'review', reasons: [], note: 'Model refused to classify', model: pending.model, at };
                ok++;
                continue;
            }
            const text = message.content.find((b) => b.type === 'text');
            try {
                const parsed = JSON.parse(text?.type === 'text' ? text.text : '') as {
                    decision: Decision;
                    reasons: Reason[];
                    note: string;
                };
                verdicts[id] = { ...parsed, model: pending.model, at };
                ok++;
            } catch {
                failed++;
                console.warn(`⚠️  ${id}: unparseable output (stop_reason ${message.stop_reason}) — will be retried`);
            }
        }
    }

    saveVerdicts(verdicts);
    fs.rmSync(PENDING_FILE, { force: true });
    console.log(`\n✅ ${ok} verdict(s) saved${failed ? `, ${failed} failed (run again to retry)` : ''}`);
}

async function classify() {
    const client = new Anthropic();
    let pending: Pending | null = fs.existsSync(PENDING_FILE)
        ? (JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')) as Pending)
        : null;

    if (pending) console.log(`↩️  Resuming ${pending.batchIds.length} pending batch(es)`);
    else pending = await submit(client);
    if (!pending) return;

    await collect(client, pending);
    report();
}

// ─── report ───────────────────────────────────────────────────────────────────

function report() {
    const verdicts = loadVerdicts();
    const overrides = loadOverrides();
    const blockedAuthors = new Set(loadBlocklist().authors);
    const rows = allArticles();

    const groups: Record<Decision, typeof rows> = { keep: [], review: [], remove: [] };
    let unclassified = 0;
    const removalsByAuthor = new Map<string, number>();
    const byReason = new Map<string, number>();

    for (const row of rows) {
        const d = finalDecision(row.article.id_str, verdicts, overrides);
        if (!d) { unclassified++; continue; }
        groups[d].push(row);
        if (d === 'remove') {
            const name = row.article.screen_name;
            removalsByAuthor.set(name, (removalsByAuthor.get(name) ?? 0) + 1);
            for (const r of verdicts[row.article.id_str]?.reasons ?? []) {
                byReason.set(r, (byReason.get(r) ?? 0) + 1);
            }
        }
    }

    const line = (row: (typeof rows)[number]) => {
        const a = row.article;
        const v = verdicts[a.id_str];
        const why = overrides[a.id_str] ? `override: ${overrides[a.id_str]}` : `${v?.reasons.join(', ')} — ${v?.note}`;
        return `- \`${a.id_str}\` [${a.title}](${a.url ?? ''}) — @${a.screen_name} (${row.category})\n  ${why}`;
    };

    const topAuthors = [...removalsByAuthor.entries()].sort((x, y) => y[1] - x[1]).slice(0, 30);
    const md = [
        `# Moderation report`,
        ``,
        `${rows.length} articles: ${groups.keep.length} keep, ${groups.review.length} review, ${groups.remove.length} remove, ${unclassified} not classified yet.`,
        ``,
        `Removals by reason: ${[...byReason.entries()].map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}`,
        ``,
        `## Authors with the most removals`,
        ``,
        `Consider adding these to \`authors\` in blocklist.json if their whole publication is propaganda.`,
        ``,
        ...topAuthors.map(([name, n]) => `- @${name}: ${n}${blockedAuthors.has(name) ? ' (blocked)' : ''}`),
        ``,
        `## To review (${groups.review.length})`,
        ``,
        `Decide each one in overrides.json: \`{ "<id>": "keep" }\` or \`{ "<id>": "remove" }\`.`,
        ``,
        ...groups.review.map(line),
        ``,
        `## Will be removed by \`apply\` (${groups.remove.length})`,
        ``,
        ...groups.remove.map(line),
        ``,
    ].join('\n');

    fs.mkdirSync(MODERATION_DIR, { recursive: true });
    fs.writeFileSync(REPORT_FILE, md);
    console.log(
        `\n📊 ${groups.keep.length} keep, ${groups.review.length} review, ${groups.remove.length} remove, ${unclassified} unclassified`,
    );
    console.log(`📄 ${path.relative(process.cwd(), REPORT_FILE)}`);
}

// ─── apply ────────────────────────────────────────────────────────────────────

function apply() {
    const verdicts = loadVerdicts();
    const overrides = loadOverrides();
    const blocklist = loadBlocklist();
    const blockedAuthors = new Set(blocklist.authors);
    const alreadyBlocked = new Set(blocklist.articles.map((a) => a.id_str));
    const today = new Date().toISOString().slice(0, 10);

    const data = readArticles();
    let removed = 0;

    for (const cat of data.articles) {
        cat.content = cat.content.filter((a) => {
            const byAuthor = blockedAuthors.has(a.screen_name);
            if (!byAuthor && finalDecision(a.id_str, verdicts, overrides) !== 'remove') return true;

            removed++;
            console.log(`🗑️  [${cat.category}] ${a.title} — @${a.screen_name}${byAuthor ? ' (blocked author)' : ''}`);
            if (!alreadyBlocked.has(a.id_str)) {
                blocklist.articles.push({
                    id_str: a.id_str,
                    url: a.url,
                    title: a.title,
                    screen_name: a.screen_name,
                    reasons: verdicts[a.id_str]?.reasons ?? [],
                    removed_at: today,
                });
                alreadyBlocked.add(a.id_str);
            }
            return false;
        });
    }

    if (removed === 0) {
        console.log('✅ Nothing to remove.');
        return;
    }
    writeArticles(data);
    saveBlocklist(blocklist);
    console.log(`\n✅ Removed ${removed} article(s) and added them to blocklist.json.`);
    console.log('   Run `bun run check-data` before committing.');
}

// ─── main ─────────────────────────────────────────────────────────────────────

switch (command) {
    case 'classify':
        await classify();
        break;
    case 'report':
        report();
        break;
    case 'apply':
        apply();
        break;
    default:
        console.error(`Unknown command "${command}". Use classify (default), report or apply.`);
        process.exit(1);
}
