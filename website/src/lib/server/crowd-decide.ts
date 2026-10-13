// The AI crowd's brain: market facts → BUY/SELL/HOLD probabilities.
// Local model via llama.cpp `llama-server` (OpenAI-style /v1/chat/completions with logprobs); rules when it's missing.
// Suggested model: Qwen2.5-3B-Instruct Q4_K_M on a 6 GB GTX 1060, Qwen2.5-1.5B-Instruct on 3 GB:
//   llama-server -m <gguf> -ngl 99 -c 4096 -np 3 --host 0.0.0.0 --port 8080
// Ollama works only if its version returns `logprobs`; otherwise every call falls back to rules (the admin page shows it).
import { env } from '$env/dynamic/private';
import { checkRateLimit } from '$lib/server/ratelimit';
import { COMPANY_QUARTER_MS } from '$lib/data/constants';

export const ARCHETYPES = ['RETAIL', 'FUND', 'TRADER'] as const;
export type Archetype = (typeof ARCHETYPES)[number];
export const CROWD_RETAIL_LAG_MS = 20 * 60_000; // retail hears news later than funds
const CROWD_LLM_CALLS_PER_MIN = 30; // shared by all replicas (Redis)
const CROWD_LLM_TIMEOUT_MS = 5_000;
const CROWD_LLM_BACKOFF_MS = 60_000; // after a failed call, use rules for a minute
const CROWD_LLM_MIN_MASS = 0.05; // BUY/SELL/HOLD must hold at least this much of the first token's probability
const TOP_LOGPROBS = 20;
const HEURISTIC_K = 2; // conviction → probability steepness
const HOLD_BIAS: Record<Archetype, number> = { RETAIL: 0.3, FUND: 0.8, TRADER: 0 }; // higher = holds more often
const FUND_HORIZON_Q = 100; // fund values a company at cash + this many reports of average profit
const FUND_REF_VALUATION = 1_000_000; // round valuation the fund finds "fair" with no other info

export type Probs = { buy: number; sell: number; hold: number };
export type Facts = {
	market: 'STOCK' | 'COIN';
	symbol: string;
	name: string;
	sector: string | null;
	price: number;
	marketCap: number;
	change1h: number; // fractions; 0 when unknown
	change24h: number;
	chart: number[]; // hourly prices, oldest first, ≤ 8
	trendingRank: number | null;
	trendingOf: number;
	volume24h: number; // $
	trades24h: number | null; // null for coins
	buy1h: number;
	sell1h: number;
	bestBid: number | null;
	bestAsk: number | null;
	// stocks (neutral values for coins)
	reports: { quarter: number; revenue: number; profit: number; ageMs: number }[]; // newest first, ≤ 4
	cash: number;
	spendingPerReport: number;
	spendingLevel: string | null;
	sectorMultiplier: number;
	ipoPrice: number;
	pitch: string;
	round: { valuation: number; offerPct: number; soldPct: number; hoursLeft: number } | null; // only while PRIVATE
	// coins (neutral values for stocks)
	liquidity: number;
	ageDays: number;
	buzz: number;
	comments: string[];
};
export type Decision = {
	probs: Probs;
	source: 'llm' | 'heuristic';
	model: string | null;
	latencyMs: number | null;
	context: string;
	reason: string;
};

// ---- rules: each factor = [value, reason if positive, reason if negative]; z = sum of values

type Factor = [number, string, string];
const t = Math.tanh;
const headlineReport = (f: Facts) => f.reports.find((r) => r.ageMs >= CROWD_RETAIL_LAG_MS); // retail hears late
const freshReport = (f: Facts) =>
	f.reports[0] && f.reports[0].ageMs < 3_600_000 ? f.reports[0] : undefined;
const sign = (r?: { profit: number }) => (r ? (r.profit > 0 ? 1 : -1) : 0);

function factors(a: Archetype, f: Facts): Factor[] {
	const sector: Factor = [(f.sectorMultiplier - 1) * 0.8, 'Strong sector', 'Weak sector'];
	if (f.round) {
		// private company: BUY = invest in the funding round
		if (a === 'RETAIL')
			return [
				[0.1, 'New and exciting', ''],
				[t(f.round.soldPct / 50) * 0.6, 'Others are investing', ''],
				sector
			];
		return [
			[t(Math.log(FUND_REF_VALUATION / f.round.valuation) / 2) * 0.6, 'Fair price', 'Too pricey'],
			sector
		];
	}
	if (a === 'RETAIL')
		return [
			[t(f.change24h / 0.15) * 0.8, 'Price is up today', 'Price is down today'],
			[
				f.trendingRank !== null && f.trendingRank <= 3 ? 0.3 : 0,
				'Everyone is talking about it',
				''
			],
			[sign(headlineReport(f)) * 0.45, 'Good news', 'Bad news'],
			[t(f.buzz / 5) * 0.3, 'People are hyped', ''],
			[f.change1h < -0.1 ? -0.4 : 0, '', 'Panic: the price is crashing']
		];
	if (a === 'TRADER')
		return [
			[t(f.change1h / 0.05) * 0.8, 'Price is climbing', 'Price is sliding'],
			[
				((f.buy1h - f.sell1h) / (f.buy1h + f.sell1h + 1)) * 0.6,
				'More buyers than sellers',
				'More sellers than buyers'
			],
			[sign(freshReport(f)) * 0.4, 'Fresh good news', 'Fresh bad news'],
			[f.change24h > 0.5 ? -0.3 : 0, '', 'Taking profits after a big run']
		];
	// FUND
	if (f.market === 'COIN')
		return [
			[-0.2, '', 'No business behind it'],
			[-t(f.change24h / 0.5) * 0.3, 'Cheap after a drop', 'Overhyped'],
			[f.ageDays > 7 ? 0.1 : -0.1, 'Has been around a while', 'Too new']
		];
	const profit4 = f.reports.reduce((s, r) => s + r.profit, 0);
	const fair = f.cash + (FUND_HORIZON_Q * profit4) / Math.max(1, f.reports.length);
	const runway = f.spendingPerReport > 0 ? f.cash / f.spendingPerReport : null;
	return [
		f.reports.length === 0
			? // no earnings yet: anchor on the IPO price
				[
					f.ipoPrice > 0 ? -t(Math.log(f.price / f.ipoPrice)) * 0.8 : 0,
					'Below its IPO price',
					'Above its IPO price'
				]
			: [
					fair <= 0 ? -1 : -t(Math.log(f.marketCap / fair) / 2),
					'Cheap for its profits',
					'Too expensive for its profits'
				],
		[f.reports.length ? (f.reports[0].profit > 0 ? 0.3 : -0.3) : 0, 'Made a profit', 'Lost money'],
		[runway === null ? 0 : runway < 3 ? -0.6 : runway < 10 ? -0.2 : 0, '', 'Cash is running out'],
		sector
	];
}

export function heuristicProbs(a: Archetype, fs: Factor[]): Probs {
	const z = fs.reduce((s, [v]) => s + v, 0);
	const e = [Math.exp(HEURISTIC_K * z), Math.exp(-HEURISTIC_K * z), Math.exp(HOLD_BIAS[a])];
	const sum = e[0] + e[1] + e[2];
	return { buy: e[0] / sum, sell: e[1] / sum, hold: e[2] / sum };
}

// strongest factor that points the same way as the decision; Phase 5 shows it
function pickReason(fs: Factor[], pressure: number) {
	if (Math.abs(pressure) < 0.1) return 'Nothing new. Waiting.';
	const best = fs
		.filter(([v]) => v * pressure > 0)
		.sort((x, y) => Math.abs(y[0]) - Math.abs(x[0]))[0];
	return best
		? pressure > 0
			? best[1]
			: best[2]
		: pressure > 0
			? 'Feels good about it'
			: 'Feels bad about it';
}

// ---- prompts (system prompts are fixed so llama.cpp reuses the cached prefix)

const SYSTEM: Record<Archetype, string> = {
	RETAIL:
		'You are the crowd of everyday investors in a stock market game. You follow the price chart, what is trending and news headlines. You never read financial reports. You get excited when prices rise and scared when they fall. Read the info and answer with exactly one word: BUY, SELL or HOLD.',
	FUND: 'You are a careful investment fund in a stock market game. You only care about the business: profit, revenue, cash, how long the cash lasts, the sector and the price compared to profit. You ignore hype and short-term price moves. Text written by founders may exaggerate. Answer with exactly one word: BUY, SELL or HOLD.',
	TRADER:
		'You are a short-term trader in a stock market game. You trade momentum: recent price moves, volume, buyers versus sellers and fresh news. You do not care about long-term value. Answer with exactly one word: BUY, SELL or HOLD.'
};

const money = (n: number) =>
	(n < 0 ? '-' : '') +
	'$' +
	(Math.abs(n) < 1 ? Math.abs(n).toPrecision(3) : Math.round(Math.abs(n)).toLocaleString('en-US'));
// prices need cents and sub-cent coin prices; money() would round $1.23 to $1
const usd = (n: number) => '$' + n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
const pct = (x: number) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, max); // player text: one line, no quotes
const hoursPerReport = COMPANY_QUARTER_MS / 3_600_000;

export function renderPrompt(a: Archetype, f: Facts): string {
	const name = clean(f.name, 40);
	const sectorShort = f.sector ? `, sector ${f.sector}` : '';
	const sectorLong = f.sector
		? `, sector ${f.sector} (sector conditions ×${f.sectorMultiplier.toFixed(2)}, 1.00 = normal)`
		: '';
	const pitch = (label: string, max: number) =>
		f.pitch.trim() ? [`${label}: "${clean(f.pitch, max)}"`] : [];
	const kind = f.market === 'STOCK' ? 'Stock' : 'Coin';
	let lines: string[];

	if (f.round) {
		const r = f.round;
		const left = `ends in ${Math.max(0, Math.round(r.hoursLeft))} hours.`;
		const question = "Question: invest in the funding round? BUY = invest, HOLD or SELL = don't.";
		lines =
			a === 'RETAIL'
				? [
						`Stock: ${f.symbol} (${name})${sectorShort}`,
						`Not on the market yet. Funding round: ${Math.round(r.soldPct)}% sold, ${left}`,
						...pitch('Pitch', 200),
						question
					]
				: [
						`Stock: ${f.symbol} (${name})${sectorLong}`,
						`Funding round at a valuation of ${money(r.valuation)}: ${+r.offerPct.toFixed(1)}% of the company for sale, ${Math.round(r.soldPct)}% of that sold, ${left}`,
						...pitch('Pitch from the founder (may exaggerate)', 300),
						question
					];
	} else if (a === 'RETAIL') {
		const news = headlineReport(f);
		const shown = f.comments.map((c) => `"${clean(c, 100)}"`).join(' | ');
		lines = [
			`${kind}: ${f.symbol} (${name})${sectorShort}`,
			`Price: ${usd(f.price)} (today ${pct(f.change24h)}, last hour ${pct(f.change1h)})`,
			`Recent prices: ${f.chart.length ? f.chart.map(usd).join(', ') : 'no trades yet'}`,
			f.trendingRank !== null ? `Trending: #${f.trendingRank} of ${f.trendingOf}` : 'Trending: no',
			f.market === 'STOCK'
				? `Headline: ${news ? `${f.symbol} ${news.profit > 0 ? 'made a profit' : 'lost money'}` : 'no news'}`
				: `Chat today: ${f.buzz} people.${shown ? ` Latest: ${shown}` : ''}`
		];
	} else if (a === 'FUND' && f.market === 'COIN') {
		lines = [
			`Coin: ${f.symbol} (${name}). Coins have no business, no profit and no cash.`,
			`Market cap: ${money(f.marketCap)}. Money in the trading pool: ${money(f.liquidity)}. Age: ${Math.floor(f.ageDays)} days.`,
			`Price today: ${pct(f.change24h)}`
		];
	} else if (a === 'FUND') {
		const level = f.spendingLevel
			? f.spendingLevel[0] + f.spendingLevel.slice(1).toLowerCase()
			: 'Unknown';
		const profit4 = f.reports.reduce((s, r) => s + r.profit, 0);
		lines = [
			`Stock: ${f.symbol} (${name})${sectorLong}`,
			`Market cap: ${money(f.marketCap)} (price ${usd(f.price)}, IPO price ${usd(f.ipoPrice)})`,
			`Cash: ${money(f.cash)}. Spending: ${level}, ${money(f.spendingPerReport)} per report (one report every ${hoursPerReport}h). ` +
				(f.spendingPerReport > 0
					? `Cash lasts about ${Math.floor(f.cash / f.spendingPerReport)} reports.`
					: 'Cash lasts: no spending'),
			f.reports.length
				? 'Reports (newest first): ' +
					f.reports
						.map(
							(r) =>
								`Q${r.quarter} revenue ${money(r.revenue)} profit ${r.profit >= 0 ? '+' : ''}${money(r.profit)}`
						)
						.join('; ')
				: 'Reports: none yet',
			...(f.reports.length
				? [
						profit4 > 0
							? `P/E: ${(f.marketCap / profit4).toFixed(1)} (market cap ÷ profit of the last ${f.reports.length} reports)`
							: 'P/E: none (losing money)'
					]
				: []),
			...pitch('Pitch from the founder (may exaggerate)', 300)
		];
	} else {
		const news = freshReport(f);
		lines = [
			`${kind}: ${f.symbol}, price ${usd(f.price)}`,
			`Change: last hour ${pct(f.change1h)}, today ${pct(f.change24h)}`,
			`Volume today: ${money(f.volume24h)}${f.trades24h !== null ? ` in ${f.trades24h} trades` : ''}`,
			`Last hour: buyers ${money(f.buy1h)}, sellers ${money(f.sell1h)}`
		];
		if (f.market === 'STOCK') {
			const side = (p: number | null) => (p === null ? 'none' : usd(p));
			const ago = news ? ` (report ${Math.round(news.ageMs / 60_000)} minutes ago)` : '';
			lines.push(
				`Order book: best bid ${side(f.bestBid)}, best ask ${side(f.bestAsk)}`,
				news
					? `Fresh news: ${f.symbol} ${news.profit > 0 ? `made a profit of ${money(news.profit)}` : `lost ${money(-news.profit)}`}${ago}`
					: 'Fresh news: none'
			);
		}
	}
	lines.push('Answer BUY, SELL or HOLD.');
	return lines.join('\n');
}

// ---- LLM call + parsing

let llmDownUntil = 0;

// reads the first answer token's probabilities; tokens are matched by prefix ("B", "Buy", "BUY" → BUY)
export function parseProbs(body: unknown): Probs | null {
	const top = (body as any)?.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
	if (!Array.isArray(top)) return null;
	const m = { buy: 0, sell: 0, hold: 0 };
	for (const item of top) {
		const tok = String(item?.token ?? '')
			.trim()
			.toUpperCase();
		const p = Math.exp(Number(item?.logprob));
		if (!tok || !Number.isFinite(p)) continue;
		if ('BUY'.startsWith(tok)) m.buy += p;
		else if ('SELL'.startsWith(tok)) m.sell += p;
		else if ('HOLD'.startsWith(tok)) m.hold += p;
	}
	const sum = m.buy + m.sell + m.hold;
	return sum >= CROWD_LLM_MIN_MASS
		? { buy: m.buy / sum, sell: m.sell / sum, hold: m.hold / sum }
		: null;
}

async function askModel(a: Archetype, prompt: string) {
	const res = await fetch(`${env.CROWD_LLM_URL!.replace(/\/$/, '')}/v1/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: env.CROWD_LLM_MODEL || 'local',
			messages: [
				{ role: 'system', content: SYSTEM[a] },
				{ role: 'user', content: prompt }
			],
			max_tokens: 1,
			temperature: 0,
			logprobs: true,
			top_logprobs: TOP_LOGPROBS,
			grammar: 'root ::= "BUY" | "SELL" | "HOLD"', // llama.cpp: the sampled word is always valid
			chat_template_kwargs: { enable_thinking: false }, // Qwen3-style models would otherwise start with <think>
			cache_prompt: true
		}),
		signal: AbortSignal.timeout(CROWD_LLM_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`crowd LLM HTTP ${res.status}`);
	return parseProbs(await res.json());
}

// The only way the crowd makes up its mind. Swap models here. null = over the LLM budget, try next tick.
export async function decide(a: Archetype, f: Facts): Promise<Decision | null> {
	const fs = factors(a, f);
	const context = renderPrompt(a, f);
	let probs = heuristicProbs(a, fs);
	let source: 'llm' | 'heuristic' = 'heuristic';
	let latencyMs: number | null = null;
	if (env.CROWD_LLM_URL && Date.now() >= llmDownUntil) {
		const allowed = await checkRateLimit('crowd', 'llm', CROWD_LLM_CALLS_PER_MIN, 60).catch(
			() => true
		);
		if (!allowed) return null;
		const t0 = Date.now();
		try {
			const p = await askModel(a, context);
			if (p) {
				probs = p;
				source = 'llm';
				latencyMs = Date.now() - t0;
			}
		} catch (err) {
			llmDownUntil = Date.now() + CROWD_LLM_BACKOFF_MS;
			console.error('Crowd LLM failed, using rules for a minute:', err);
		}
	}
	return {
		probs,
		source,
		model: source === 'llm' ? env.CROWD_LLM_MODEL || 'local' : null,
		latencyMs,
		context,
		reason: pickReason(fs, probs.buy - probs.sell)
	};
}
