export interface Env {
	ARTICLE_VIEWS: KVNamespace;
}

interface LeaderboardEntry {
	slug: string;
	count: number;
}

const ALLOWED_ORIGINS = [
	"https://elhellal.com",
	"https://www.elhellal.com",
];

// Article slugs are mostly Arabic (sent decoded, as the site stores them).
const SLUG_RE = /^[\p{L}\p{M}\p{N}_-]{1,200}$/u;
const LEADERBOARD_KEY = "leaderboard";
const LEADERBOARD_SIZE = 50;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
const DEDUPE_TTL_SECONDS = 1800; // one increment per visitor per article per 30 min
// Visits that came from a social post (?utm_source=x&utm_content=<post id>), counted per post so
// `bun run x-stats --report` can rank posts by the readers they actually sent.
const CLICK_SOURCES = new Set(["x", "tumblr", "linkedin"]);
const CID_RE = /^[\p{L}\p{N}_:.\/-]{1,160}$/u;
const MAX_CLICK_IDS = 5000;

function isAllowedOrigin(origin: string | null): boolean {
	if (!origin) return false;
	if (ALLOWED_ORIGINS.includes(origin)) return true;
	// dev convenience — any localhost port
	return /^http:\/\/localhost:\d+$/.test(origin);
}

function corsHeaders(origin: string | null): HeadersInit {
	const allowed = isAllowedOrigin(origin);
	return {
		"Access-Control-Allow-Origin": allowed ? (origin as string) : "https://elhellal.com",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type",
		Vary: "Origin",
	};
}

function json(data: unknown, init: ResponseInit, origin: string | null): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...corsHeaders(origin),
			...(init.headers || {}),
		},
	});
}

async function getLeaderboard(env: Env): Promise<LeaderboardEntry[]> {
	const raw = await env.ARTICLE_VIEWS.get(LEADERBOARD_KEY);
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function upsertLeaderboard(env: Env, slug: string, count: number): Promise<void> {
	const board = await getLeaderboard(env);
	const existing = board.find((e) => e.slug === slug);
	if (existing) {
		existing.count = count;
	} else {
		board.push({ slug, count });
	}
	board.sort((a, b) => b.count - a.count);
	await env.ARTICLE_VIEWS.put(LEADERBOARD_KEY, JSON.stringify(board.slice(0, LEADERBOARD_SIZE)));
}

async function handleTrackView(request: Request, env: Env, origin: string | null): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "invalid body" }, { status: 400 }, origin);
	}

	const slug = (body as { slug?: unknown })?.slug;
	if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
		return json({ error: "invalid slug" }, { status: 400 }, origin);
	}

	// Cheap dedupe: one counted view per (ip, slug) per DEDUPE_TTL_SECONDS.
	const ip = request.headers.get("CF-Connecting-IP") || "unknown";
	const seenKey = `seen:${slug}:${ip}`;
	const alreadySeen = await env.ARTICLE_VIEWS.get(seenKey);

	const countKey = `views:${slug}`;
	let count = Number((await env.ARTICLE_VIEWS.get(countKey)) || "0");

	if (!alreadySeen) {
		count += 1;
		await env.ARTICLE_VIEWS.put(countKey, String(count));
		await env.ARTICLE_VIEWS.put(seenKey, "1", { expirationTtl: DEDUPE_TTL_SECONDS });
		await upsertLeaderboard(env, slug, count);
		const { src, cid } = body as { src?: unknown; cid?: unknown };
		if (typeof src === "string" && CLICK_SOURCES.has(src) && typeof cid === "string" && CID_RE.test(cid)) {
			await countClick(env, src, cid);
		}
	}

	return json({ slug, count, counted: !alreadySeen }, { status: 200 }, origin);
}

async function getClicks(env: Env, src: string): Promise<Record<string, number>> {
	try {
		const parsed = JSON.parse((await env.ARTICLE_VIEWS.get(`clicks:${src}`)) || "{}");
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

async function countClick(env: Env, src: string, cid: string): Promise<void> {
	const map = await getClicks(env, src);
	map[cid] = (map[cid] ?? 0) + 1;
	const ids = Object.keys(map);
	// Keep the map bounded: drop the least-clicked ids first.
	if (ids.length > MAX_CLICK_IDS) {
		for (const id of ids.sort((a, b) => map[a]! - map[b]!).slice(0, ids.length - MAX_CLICK_IDS)) delete map[id];
	}
	await env.ARTICLE_VIEWS.put(`clicks:${src}`, JSON.stringify(map));
}

async function handleSocialClicks(request: Request, env: Env, origin: string | null): Promise<Response> {
	const src = new URL(request.url).searchParams.get("source") || "";
	if (!CLICK_SOURCES.has(src)) return json({ error: "unknown source" }, { status: 400 }, origin);
	return json({ source: src, clicks: await getClicks(env, src) }, { status: 200, headers: { "Cache-Control": "no-store" } }, origin);
}

async function handleMostRead(request: Request, env: Env, origin: string | null): Promise<Response> {
	const url = new URL(request.url);
	const limitParam = Number(url.searchParams.get("limit"));
	const limit = Number.isFinite(limitParam) && limitParam > 0
		? Math.min(Math.floor(limitParam), MAX_LIMIT)
		: DEFAULT_LIMIT;

	const board = await getLeaderboard(env);
	return json(
		{ items: board.slice(0, limit) },
		{ status: 200, headers: { "Cache-Control": "public, max-age=60" } },
		origin,
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const origin = request.headers.get("Origin");
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders(origin) });
		}

		if (url.pathname === "/api/track-view" && request.method === "POST") {
			return handleTrackView(request, env, origin);
		}

		if (url.pathname === "/api/most-read" && request.method === "GET") {
			return handleMostRead(request, env, origin);
		}

		if (url.pathname === "/api/social-clicks" && request.method === "GET") {
			return handleSocialClicks(request, env, origin);
		}

		return json({ error: "not found" }, { status: 404 }, origin);
	},
};
