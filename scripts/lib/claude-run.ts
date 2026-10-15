// Runs a headless Claude Code session (`claude -p`) and prints its progress as plain log lines,
// for the admin panel's AI jobs (the Sites tab). Ctrl-C / SIGINT stops the session.
//   bun scripts/lib/claude-run.ts --cwd <repo> [--add-dir <dir>]... [--model <m>] -- <prompt>
export {};

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep < 0 ? argv : argv.slice(0, sep);
const prompt = sep < 0 ? '' : argv.slice(sep + 1).join(' ');
const take = (name: string) => opts.flatMap((a, i) => (a === name && opts[i + 1] ? [opts[i + 1]!] : []));
const cwd = take('--cwd')[0];
if (!cwd || !prompt.trim()) {
    console.error('usage: bun scripts/lib/claude-run.ts --cwd <repo> [--add-dir <dir>]... [--model <m>] -- <prompt>');
    process.exit(2);
}

// File edits are accepted without asking (it's the repo's own data), the web is open for research,
// and shell access is limited to the repo's scripts and read-only tools. Shipping is left to the panel.
const ALLOWED = [
    'Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'TodoWrite', 'Skill',
    'Bash(node:*)', 'Bash(bun run build)', 'Bash(bun run build-questions)', 'Bash(bun scripts/:*)', 'Bash(bun run check-data)',
    'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(awk:*)', 'Bash(sed -n:*)', 'Bash(cut:*)', 'Bash(sort:*)', 'Bash(uniq:*)', 'Bash(find:*)', 'Bash(mkdir:*)', 'Bash(jq:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git log:*)',
];
const DENIED = ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(bunx:*)', 'Bash(bun x:*)', 'Bash(npx:*)', 'Bash(wrangler:*)'];

const cmd = [
    'claude', '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...ALLOWED,
    '--disallowedTools', ...DENIED,
    ...take('--add-dir').flatMap((d) => ['--add-dir', d]),
    ...take('--model').flatMap((m) => ['--model', m]),
];

// Bun loads elhellal/.env, whose ANTHROPIC_API_KEY (for other scripts) would take precedence over the
// claude.ai login the Terminal sessions use; drop it so both bill the same way.
const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'inherit', stdin: 'ignore' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => proc.kill(sig));

const short = (s: unknown, n = 160) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const rel = (p: unknown) => String(p ?? '').replace(cwd.endsWith('/') ? cwd : cwd + '/', '');

/** One line per tool call: what it did, without the payload. */
function describeTool(name: string, input: Record<string, any>) {
    switch (name) {
        case 'Bash': return `$ ${short(input.command, 200)}`;
        case 'Read': return `read ${rel(input.file_path)}`;
        case 'Write': return `write ${rel(input.file_path)} (${String(input.content ?? '').length.toLocaleString()} chars)`;
        case 'Edit': return `edit ${rel(input.file_path)}`;
        case 'Glob': case 'Grep': return `${name.toLowerCase()} ${short(input.pattern, 100)}`;
        case 'WebSearch': return `search “${short(input.query, 120)}”`;
        case 'WebFetch': return `fetch ${short(input.url, 160)}`;
        case 'Skill': return `skill /${input.skill ?? input.name ?? ''} ${short(input.args, 100)}`;
        case 'TodoWrite': return `todo: ${(input.todos ?? []).map((t: any) => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '…' : '·'} ${short(t.content, 50)}`).join(' | ')}`;
        default: return `${name} ${short(JSON.stringify(input), 120)}`;
    }
}

let buffer = '';
const decoder = new TextDecoder();
function handle(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { if (line.trim()) console.log(line); return; }
    if (ev.type === 'system' && ev.subtype === 'init') console.log(`● session ${ev.session_id} · ${ev.model} · ${cwd}`);
    else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
            if (c.type === 'text' && c.text.trim()) console.log(`\n${c.text.trim()}\n`);
            else if (c.type === 'tool_use') console.log(`→ ${describeTool(c.name, c.input ?? {})}`);
        }
    } else if (ev.type === 'user') {
        for (const c of ev.message?.content ?? []) {
            if (c.type !== 'tool_result' || !c.is_error) continue;
            const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join(' ') : c.content;
            console.log(`  ✗ ${short(text, 300)}`);
        }
    } else if (ev.type === 'result') {
        const mins = Math.round((ev.duration_ms ?? 0) / 6000) / 10;
        console.log(`\n● ${ev.subtype === 'success' && !ev.is_error ? 'done' : `ended: ${ev.subtype}`} · ${ev.num_turns ?? '?'} turns · ${mins} min${ev.total_cost_usd != null ? ` · $${ev.total_cost_usd.toFixed(2)}` : ''}`);
        if (ev.permission_denials?.length) console.log(`  denied: ${[...new Set(ev.permission_denials.map((d: any) => d.tool_name))].join(', ')}`);
        if (ev.session_id) console.log(`  continue it in a terminal: cd ${cwd} && claude --resume ${ev.session_id}`);
        if (ev.is_error) process.exitCode = 1;
    }
}

for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) > -1) {
        handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
    }
}
if (buffer) handle(buffer);
const code = await proc.exited;
process.exit(process.exitCode || code);
