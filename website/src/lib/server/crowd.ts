// The AI crowd: three bot accounts (retail, fund, trader) that trade stocks, fill funding rounds and
// (optionally) trade coins, driven by crowd-decide.ts. All money moves go through the same functions
// players use (placeOrder/cancelOrder, investInRound, executeCoinTrade), which lock and re-check.
import { isHttpError } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	coin,
	comment,
	company,
	companyEarnings,
	crowdAsset,
	crowdDecision,
	crowdSettings,
	priceHistory,
	sectorCondition,
	stockOrder,
	stockTrade,
	transaction,
	user,
	type CrowdMood
} from '$lib/server/db/schema';
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	notInArray,
	or,
	sql
} from 'drizzle-orm';
import { cancelOrder, placeOrder } from '$lib/server/orderbook';
import { investInRound } from '$lib/server/companies';
import { executeCoinTrade } from '$lib/server/amm';
import {
	ARCHETYPES,
	CROWD_RETAIL_LAG_MS,
	decide,
	type Archetype,
	type Facts
} from '$lib/server/crowd-decide';
import { COMPANY_SPENDING, COMPANY_TOTAL_SHARES, STOCK_MAX_PRICE } from '$lib/data/constants';

// tunables: guesses until playtested; server-only so pool sizes never reach the client
export const CROWD_RUN_MS = 20_000; // scheduler poll; each market ticks on its own random timer
const CROWD_TICK_MS = 90_000; // per market, × 0.5–1.5
const CROWD_EVAL_MS = 8 * 60_000; // slow re-evaluation timer, × 0.5–1.5
const CROWD_REEVAL_MOVE = 0.05; // price move that triggers a new decision
const CROWD_BIG_TRADE = 0.01; // player trade of this share of market cap triggers a new decision
const CROWD_START_CASH: Record<Archetype, number> = {
	RETAIL: 5_000_000,
	FUND: 20_000_000,
	TRADER: 2_000_000
};
const CROWD_STOCK_POOL: Record<Archetype, number> = { RETAIL: 0.1, FUND: 0.2, TRADER: 0.05 }; // share of market cap
const CROWD_COIN_POOL_SPLIT: Record<Archetype, number> = { RETAIL: 0.6, FUND: 0.1, TRADER: 0.3 }; // of admin coinPool
const CROWD_ACTIVITY_RATE: Record<Archetype, number> = { RETAIL: 0.02, FUND: 0.01, TRADER: 0.03 }; // of pool per tick
const CROWD_SMOOTHING: Record<Archetype, number> = { RETAIL: 0.3, FUND: 0.15, TRADER: 0.5 };
const CROWD_QUOTE_SPREAD: Record<Archetype, number> = { RETAIL: 0.04, FUND: 0.06, TRADER: 0.02 };
const CROWD_ROUND_SHARE: Record<Archetype, number> = { RETAIL: 0.3, FUND: 0.5, TRADER: 0 };
const CROWD_MAX_TICK_FLOW = 0.005; // of market cap, per archetype per tick
const CROWD_COIN_MAX_TICK_FLOW = 0.01; // of the coin's AMM base liquidity
const CROWD_MAX_CASH_PER_TICK = 0.01; // of the bot's cash, per market per tick (takes and the bid each)
const CROWD_TAKE_SLIP = 0.03; // takes never pay more than 3% past the last price
const CROWD_QUOTE_SHARE = 0.01; // quote size, share of pool
const CROWD_ROUND_STEP = 0.02; // of round shares per tick
const CROWD_ROUND_MAX_CASH = 0.05; // of start cash in one company's round
const CROWD_MIN_ORDER = 1; // $
const CROWD_MAX_COINS = 20;
const CROWD_COIN_MIN_LIQUIDITY = 1_000;
const CROWD_MAX_ASSETS_PER_RUN = 40;
const CROWD_LOG_DAYS = 14;

type Summary = {
	assets: number;
	evals: { llm: number; heuristic: number; postponed: number };
	stockOrders: number;
	invests: number;
	coinTrades: number;
	errors: number;
};
type Mood = Partial<Record<Archetype, CrowdMood>>;

const jitter = () => 0.5 + Math.random();
const clamp = (x: number, max: number) => Math.max(-max, Math.min(max, x));
const shuffle = <T>(xs: readonly T[]) => [...xs].sort(() => Math.random() - 0.5);
// expected refusals (no money, round closed, bankrupt, filled meanwhile) are normal for the crowd; real errors still throw
const soft = <T>(p: Promise<T>) =>
	p.catch((e) => {
		if (isHttpError(e)) return null;
		throw e;
	});
// 1–3 child orders so the feed looks like several people; whole = shares, else dollars/coins
function split(total: number, whole: boolean): number[] {
	const n = total >= 3 ? 1 + Math.floor(Math.random() * 3) : 1;
	const w = Array.from({ length: n }, () => Math.random() + 0.2);
	const sum = w.reduce((x, y) => x + y);
	const parts = w
		.map((x) => (whole ? Math.floor((total * x) / sum) : (total * x) / sum))
		.filter((q) => q > 0);
	if (whole && parts.length) parts[0] += total - parts.reduce((x, y) => x + y, 0);
	return parts;
}

export async function getCrowdSettings() {
	const [s] = await db.select().from(crowdSettings).where(eq(crowdSettings.id, 1)).limit(1);
	return {
		enabled: s?.enabled ?? true,
		coinsEnabled: s?.coinsEnabled ?? false,
		coinPool: Number(s?.coinPool ?? 100_000)
	};
}

let bots: Record<Archetype, number> | null = null;
// idempotent across replicas; usernames have a "-" that players can't pick, emails can't come from Google
export async function getCrowdBots() {
	if (bots) return bots;
	const rows = ARCHETYPES.map((a) => ({
		a,
		username: `crowd-${a.toLowerCase()}`,
		email: `crowd-${a.toLowerCase()}@crowd.invalid`
	}));
	await db
		.insert(user)
		.values(
			rows.map((r) => ({
				name: `AI crowd (${r.a.toLowerCase()})`,
				username: r.username,
				email: r.email,
				isBot: true,
				bio: 'AI crowd account. Not a real player.',
				baseCurrencyBalance: CROWD_START_CASH[r.a].toFixed(8)
			}))
		)
		.onConflictDoNothing();
	const found = await db
		.select({ id: user.id, email: user.email })
		.from(user)
		.where(
			and(
				inArray(
					user.email,
					rows.map((r) => r.email)
				),
				eq(user.isBot, true)
			)
		);
	if (found.length !== rows.length) {
		console.error('AI crowd: bot accounts missing');
		return null;
	}
	bots = Object.fromEntries(
		rows.map((r) => [r.a, found.find((f) => f.email === r.email)!.id])
	) as Record<Archetype, number>;
	return bots;
}

const liveCompanies = () =>
	db
		.select({
			id: company.id,
			symbol: company.symbol,
			name: company.name,
			sector: company.sector,
			pitch: company.pitch,
			status: company.status,
			sharePrice: company.sharePrice,
			sharesOutstanding: company.sharesOutstanding,
			roundShares: company.roundShares,
			roundSharesSold: company.roundSharesSold,
			roundEndsAt: company.roundEndsAt,
			raisedCash: company.raisedCash,
			treasuryCash: company.treasuryCash,
			spendingLevel: company.spendingLevel,
			createdAt: company.createdAt
		})
		.from(company)
		.where(ne(company.status, 'BANKRUPT'));
type LiveCompany = Awaited<ReturnType<typeof liveCompanies>>[number];

const liveCoins = (now: Date) =>
	db
		.select({
			id: coin.id,
			symbol: coin.symbol,
			name: coin.name,
			currentPrice: coin.currentPrice,
			change24h: coin.change24h,
			volume24h: coin.volume24h,
			marketCap: coin.marketCap,
			poolBaseCurrencyAmount: coin.poolBaseCurrencyAmount,
			createdAt: coin.createdAt
		})
		.from(coin)
		.where(
			and(
				eq(coin.isListed, true),
				gte(coin.poolBaseCurrencyAmount, CROWD_COIN_MIN_LIQUIDITY.toFixed(8)),
				or(eq(coin.isLocked, false), isNull(coin.tradingUnlocksAt), lte(coin.tradingUnlocksAt, now))
			)
		)
		.orderBy(sql`${coin.volume24h} DESC NULLS LAST`)
		.limit(CROWD_MAX_COINS);
type LiveCoin = Awaited<ReturnType<typeof liveCoins>>[number];

// ---- facts

function times() {
	const now = Date.now();
	return {
		now,
		hourAgo: new Date(now - 3_600_000),
		dayAgo: new Date(now - 86_400_000),
		weekAgo: new Date(now - 7 * 86_400_000),
		eightHoursAgo: new Date(now - 8 * 3_600_000)
	};
}

async function stockFacts(c: LiveCompany, trending: Map<number, number>, trendingOf: number) {
	const { now, hourAgo, dayAgo, eightHoursAgo } = times();
	const lastPriceAt = (t: Date) =>
		db
			.select({ price: stockTrade.price })
			.from(stockTrade)
			.where(and(eq(stockTrade.companyId, c.id), lte(stockTrade.createdAt, t)))
			.orderBy(desc(stockTrade.id))
			.limit(1);
	const value = sql`${stockTrade.price} * ${stockTrade.shares}`;
	const [[ref1h], [ref24h], [stats], chartRows, [book], reportRows, [sectorRow]] =
		await Promise.all([
			lastPriceAt(hourAgo),
			lastPriceAt(dayAgo),
			db
				.select({
					vol: sql<string>`COALESCE(SUM(${value}), 0)`,
					n: sql<number>`COUNT(*)::int`,
					buy1h: sql<string>`COALESCE(SUM(${value}) FILTER (WHERE ${gt(stockTrade.createdAt, hourAgo)} AND ${stockTrade.takerSide} = 'BUY'), 0)`,
					sell1h: sql<string>`COALESCE(SUM(${value}) FILTER (WHERE ${gt(stockTrade.createdAt, hourAgo)} AND ${stockTrade.takerSide} = 'SELL'), 0)`
				})
				.from(stockTrade)
				.where(and(eq(stockTrade.companyId, c.id), gt(stockTrade.createdAt, dayAgo))),
			db.execute(sql`
				SELECT DISTINCT ON (date_trunc('hour', created_at)) price FROM stock_trade
				WHERE company_id = ${c.id} AND ${gt(stockTrade.createdAt, eightHoursAgo)}
				ORDER BY date_trunc('hour', created_at) DESC, id DESC`),
			db
				.select({
					bid: sql<
						string | null
					>`MAX(${stockOrder.price}) FILTER (WHERE ${stockOrder.side} = 'BUY')`,
					ask: sql<
						string | null
					>`MIN(${stockOrder.price}) FILTER (WHERE ${stockOrder.side} = 'SELL')`
				})
				.from(stockOrder)
				.where(eq(stockOrder.companyId, c.id)),
			db
				.select()
				.from(companyEarnings)
				.where(eq(companyEarnings.companyId, c.id))
				.orderBy(desc(companyEarnings.quarter))
				.limit(4),
			db
				.select({ multiplier: sectorCondition.multiplier })
				.from(sectorCondition)
				.where(eq(sectorCondition.sector, c.sector))
		]);

	const price = Number(c.sharePrice);
	const ipoPrice = c.roundSharesSold > 0 ? Number(c.raisedCash) / c.roundSharesSold : price;
	const change = (ref?: { price: string }) => {
		const r = ref ? Number(ref.price) : ipoPrice;
		return r > 0 ? price / r - 1 : 0;
	};
	const facts: Facts = {
		market: 'STOCK',
		symbol: c.symbol,
		name: c.name,
		sector: c.sector,
		price,
		marketCap: price * c.sharesOutstanding,
		change1h: change(ref1h),
		change24h: change(ref24h),
		chart: (chartRows as unknown as { price: string }[])
			.slice(0, 8)
			.reverse()
			.map((r) => Number(r.price)),
		trendingRank: trending.get(c.id) ?? null,
		trendingOf,
		volume24h: Number(stats.vol),
		trades24h: Number(stats.n),
		buy1h: Number(stats.buy1h),
		sell1h: Number(stats.sell1h),
		bestBid: book.bid === null ? null : Number(book.bid),
		bestAsk: book.ask === null ? null : Number(book.ask),
		reports: reportRows.map((r) => ({
			quarter: r.quarter,
			revenue: Number(r.revenue),
			profit: Number(r.profit),
			ageMs: now - r.createdAt.getTime()
		})),
		cash: Number(c.treasuryCash),
		spendingPerReport: Number(c.raisedCash) * COMPANY_SPENDING[c.spendingLevel].rate,
		spendingLevel: c.spendingLevel,
		sectorMultiplier: sectorRow ? Number(sectorRow.multiplier) : 1,
		ipoPrice,
		pitch: c.pitch,
		round:
			c.status === 'PRIVATE'
				? {
						valuation: price * COMPANY_TOTAL_SHARES,
						offerPct: (100 * c.roundShares) / COMPANY_TOTAL_SHARES,
						soldPct: c.roundShares ? (100 * c.roundSharesSold) / c.roundShares : 0,
						hoursLeft: (c.roundEndsAt.getTime() - now) / 3.6e6
					}
				: null,
		liquidity: 0,
		ageDays: 0,
		buzz: 0,
		comments: []
	};
	return { facts, latestQuarter: reportRows[0]?.quarter ?? 0 };
}

async function coinFacts(cn: LiveCoin, rank: number, of: number): Promise<Facts> {
	const { now, hourAgo, dayAgo, weekAgo, eightHoursAgo } = times();
	const recentComments = and(
		eq(comment.coinId, cn.id),
		eq(comment.isDeleted, false),
		gt(comment.createdAt, dayAgo),
		lte(user.createdAt, weekAgo) // accounts younger than a week don't move retail (comment spam)
	);
	const [[ref1h], chartRows, [flow], [buzz], latest] = await Promise.all([
		db
			.select({ price: priceHistory.price })
			.from(priceHistory)
			.where(and(eq(priceHistory.coinId, cn.id), lte(priceHistory.timestamp, hourAgo)))
			.orderBy(desc(priceHistory.timestamp))
			.limit(1),
		db.execute(sql`
			SELECT DISTINCT ON (date_trunc('hour', timestamp)) price FROM price_history
			WHERE coin_id = ${cn.id} AND ${gt(priceHistory.timestamp, eightHoursAgo)}
			ORDER BY date_trunc('hour', timestamp) DESC, id DESC`),
		db
			.select({
				buy: sql<string>`COALESCE(SUM(${transaction.totalBaseCurrencyAmount}) FILTER (WHERE ${transaction.type} = 'BUY'), 0)`,
				sell: sql<string>`COALESCE(SUM(${transaction.totalBaseCurrencyAmount}) FILTER (WHERE ${transaction.type} = 'SELL'), 0)`
			})
			.from(transaction)
			.where(and(eq(transaction.coinId, cn.id), gt(transaction.timestamp, hourAgo))),
		db
			.select({ n: sql<number>`COUNT(DISTINCT ${comment.userId})::int` })
			.from(comment)
			.innerJoin(user, eq(user.id, comment.userId))
			.where(recentComments),
		db
			.select({ content: comment.content })
			.from(comment)
			.innerJoin(user, eq(user.id, comment.userId))
			.where(recentComments)
			.orderBy(desc(comment.createdAt))
			.limit(3)
	]);

	const price = Number(cn.currentPrice);
	const ref = ref1h ? Number(ref1h.price) : 0;
	return {
		market: 'COIN',
		symbol: cn.symbol,
		name: cn.name,
		sector: null,
		price,
		marketCap: Number(cn.marketCap),
		change1h: ref > 0 ? price / ref - 1 : 0,
		change24h: Number(cn.change24h) / 100,
		chart: (chartRows as unknown as { price: string }[])
			.slice(0, 8)
			.reverse()
			.map((r) => Number(r.price)),
		trendingRank: rank,
		trendingOf: of,
		volume24h: Number(cn.volume24h),
		trades24h: null,
		buy1h: Number(flow.buy),
		sell1h: Number(flow.sell),
		bestBid: null,
		bestAsk: null,
		reports: [],
		cash: 0,
		spendingPerReport: 0,
		spendingLevel: null,
		sectorMultiplier: 1,
		ipoPrice: 0,
		pitch: '',
		round: null,
		liquidity: Number(cn.poolBaseCurrencyAmount),
		ageDays: (now - cn.createdAt.getTime()) / 864e5,
		buzz: Number(buzz.n),
		comments: latest.map((r) => r.content)
	};
}

// ---- trading

async function stockState(botId: number, companyId: number) {
	const [s] = await db
		.select({
			price: company.sharePrice,
			outstanding: company.sharesOutstanding,
			cash: user.baseCurrencyBalance,
			owned: sql<number>`COALESCE((SELECT shares FROM company_holding WHERE user_id = ${botId} AND company_id = ${companyId}), 0)::int`
		})
		.from(company)
		.innerJoin(user, eq(user.id, botId))
		.where(eq(company.id, companyId));
	return {
		price: Number(s.price),
		mcap: Number(s.price) * s.outstanding,
		cash: Number(s.cash),
		owned: Number(s.owned)
	};
}

async function tradeStock(
	botId: number,
	a: Archetype,
	companyId: number,
	m: CrowdMood,
	out: Summary
) {
	// the engine rejects self-trades, so pull our own quotes before taking
	const own = await db
		.select({ id: stockOrder.id })
		.from(stockOrder)
		.where(and(eq(stockOrder.companyId, companyId), eq(stockOrder.userId, botId)));
	for (const o of own) await soft(cancelOrder(botId, o.id));

	const s = await stockState(botId, companyId);
	if (s.price <= 0) return;
	const pool = CROWD_STOCK_POOL[a] * s.mcap;
	let flow = clamp(
		pool * CROWD_ACTIVITY_RATE[a] * (1 - m.hold) * (m.buy - m.sell) * jitter(),
		CROWD_MAX_TICK_FLOW * s.mcap
	);
	if (flow > 0) flow = Math.min(flow, s.cash * CROWD_MAX_CASH_PER_TICK);
	m.flow = Math.round(flow * 100) / 100;
	if (Math.abs(flow) >= CROWD_MIN_ORDER) {
		const side = flow > 0 ? 'BUY' : 'SELL';
		const limit = s.price * (flow > 0 ? 1 + CROWD_TAKE_SLIP : 1 - CROWD_TAKE_SLIP);
		const total =
			flow > 0 ? Math.floor(flow / limit) : Math.min(Math.floor(-flow / s.price), s.owned);
		for (const q of split(total, true)) {
			const r = await soft(
				placeOrder({ userId: botId, companyId, side, type: 'LIMIT', shares: q, price: limit })
			);
			if (!r) break;
			out.stockOrders++;
			if (r.orderId) await soft(cancelOrder(botId, r.orderId)); // crowd takes never rest
		}
	}

	// market maker: one bid and one ask around the new price
	const q = await stockState(botId, companyId);
	const spread = CROWD_QUOTE_SPREAD[a] * jitter();
	const size = CROWD_QUOTE_SHARE * pool;
	const bid = q.price * (1 - spread);
	const ask = q.price * (1 + spread);
	const bidShares = Math.floor(Math.min(size, q.cash * CROWD_MAX_CASH_PER_TICK) / bid);
	const askShares = Math.min(Math.floor(size / ask), q.owned);
	if (
		bidShares >= 1 &&
		bid >= 0.000001 &&
		(await soft(
			placeOrder({
				userId: botId,
				companyId,
				side: 'BUY',
				type: 'LIMIT',
				shares: bidShares,
				price: bid
			})
		))
	)
		out.stockOrders++;
	if (
		askShares >= 1 &&
		ask <= STOCK_MAX_PRICE &&
		(await soft(
			placeOrder({
				userId: botId,
				companyId,
				side: 'SELL',
				type: 'LIMIT',
				shares: askShares,
				price: ask
			})
		))
	)
		out.stockOrders++;
}

async function fillRound(b: Record<Archetype, number>, c: LiveCompany, mood: Mood, out: Summary) {
	const start = c.createdAt.getTime();
	const end = c.roundEndsAt.getTime();
	const now = Date.now();
	if (now >= end) return;
	// the crowd joins gradually, so players who come early beat it
	const progress = Math.min(1, (now - start) / (end - start) + 0.1);
	for (const a of shuffle(['RETAIL', 'FUND'] as const)) {
		const m = mood[a];
		if (!m) continue;
		const [r] = await db
			.select({
				sold: company.roundSharesSold,
				price: company.sharePrice,
				held: sql<number>`COALESCE((SELECT shares FROM company_holding WHERE user_id = ${b[a]} AND company_id = ${c.id}), 0)::int`
			})
			.from(company)
			.where(eq(company.id, c.id));
		if (!r) return;
		const price = Number(r.price);
		const cap = Math.min(
			c.roundShares * CROWD_ROUND_SHARE[a] * m.buy * progress,
			(CROWD_ROUND_MAX_CASH * CROWD_START_CASH[a]) / price
		);
		const want = Math.min(
			Math.floor(cap) - Number(r.held),
			Math.ceil(c.roundShares * CROWD_ROUND_STEP * jitter()),
			c.roundShares - r.sold
		);
		if (want >= 1 && (await soft(investInRound(b[a], c.symbol, want)))) out.invests++;
	}
}

async function tradeCoin(
	botId: number,
	a: Archetype,
	cn: LiveCoin,
	coinPool: number,
	m: CrowdMood,
	out: Summary
) {
	const [s] = await db
		.select({
			price: coin.currentPrice,
			liquidity: coin.poolBaseCurrencyAmount,
			cash: user.baseCurrencyBalance,
			held: sql<string>`COALESCE((SELECT quantity FROM user_portfolio WHERE user_id = ${botId} AND coin_id = ${cn.id}), 0)`
		})
		.from(coin)
		.innerJoin(user, eq(user.id, botId))
		.where(eq(coin.id, cn.id));
	if (!s) return;
	const price = Number(s.price);
	if (price <= 0) return;
	let held = Number(s.held);
	let flow = clamp(
		coinPool *
			CROWD_COIN_POOL_SPLIT[a] *
			CROWD_ACTIVITY_RATE[a] *
			(1 - m.hold) *
			(m.buy - m.sell) *
			jitter(),
		CROWD_COIN_MAX_TICK_FLOW * Number(s.liquidity)
	);
	flow =
		flow > 0
			? Math.min(flow, Number(s.cash) * CROWD_MAX_CASH_PER_TICK)
			: -Math.min(-flow, held * price);
	m.flow = Math.round(flow * 100) / 100;
	if (Math.abs(flow) < CROWD_MIN_ORDER) return;
	for (const part of split(Math.abs(flow), false).slice(0, 2)) {
		const amount = flow > 0 ? part : Math.min(part / price, held); // BUY = dollars, SELL = coins
		if (!(amount > 0)) break; // executeCoinTrade trusts its caller for a positive amount (the route checks it)
		const r = await soft(executeCoinTrade(botId, cn.symbol, flow > 0 ? 'BUY' : 'SELL', amount));
		if (!r) break;
		out.coinTrades++;
		if (flow < 0) held -= amount;
	}
}

// ---- the run

let running = false;

// one crowd tick over all due markets; force = ignore timers and re-decide everything (admin test tool)
export async function runCrowd(force = false): Promise<Summary | { skipped: true }> {
	if (running) return { skipped: true };
	running = true;
	try {
		return await run(force);
	} finally {
		running = false;
	}
}

async function run(force: boolean): Promise<Summary> {
	const out: Summary = {
		assets: 0,
		evals: { llm: 0, heuristic: 0, postponed: 0 },
		stockOrders: 0,
		invests: 0,
		coinTrades: 0,
		errors: 0
	};
	const settings = await getCrowdSettings();
	const b = await getCrowdBots();
	if (!b) return out;
	const botIds = Object.values(b);

	await db
		.delete(crowdDecision)
		.where(lt(crowdDecision.createdAt, new Date(Date.now() - CROWD_LOG_DAYS * 86_400_000)));

	if (!settings.enabled) {
		// stale crowd quotes must not stay farmable
		const orders = await db
			.select({ id: stockOrder.id, userId: stockOrder.userId })
			.from(stockOrder)
			.where(inArray(stockOrder.userId, botIds));
		for (const o of orders) await soft(cancelOrder(o.userId, o.id));
		return out;
	}

	// register live markets, drop dead ones (they would eat claim slots)
	const startedAt = new Date();
	const companies = await liveCompanies();
	const coins = settings.coinsEnabled ? await liveCoins(startedAt) : [];
	const assets = [
		...companies.map((c) => ({ market: 'STOCK' as const, assetId: c.id })),
		...coins.map((c) => ({ market: 'COIN' as const, assetId: c.id }))
	];
	if (assets.length) await db.insert(crowdAsset).values(assets).onConflictDoNothing();
	await db.delete(crowdAsset).where(
		or(
			and(
				eq(crowdAsset.market, 'STOCK'),
				companies.length
					? notInArray(
							crowdAsset.assetId,
							companies.map((c) => c.id)
						)
					: undefined
			),
			and(
				eq(crowdAsset.market, 'COIN'),
				coins.length
					? notInArray(
							crowdAsset.assetId,
							coins.map((c) => c.id)
						)
					: undefined
			)
		)
	);

	// claim: the exactly-once point
	const due = db
		.select({ id: crowdAsset.id })
		.from(crowdAsset)
		.where(force ? undefined : lte(crowdAsset.nextTickAt, new Date()))
		.orderBy(asc(crowdAsset.nextTickAt))
		.limit(CROWD_MAX_ASSETS_PER_RUN)
		.for('update', { skipLocked: true });
	// a concurrent runner skips rows we locked and later sees next_tick_at in the future: each tick runs once
	const claimed = await db
		.update(crowdAsset)
		.set({
			nextTickAt: sql`now() + ${CROWD_TICK_MS}::float8 * (0.5 + random()) * interval '1 millisecond'`
		})
		.where(inArray(crowdAsset.id, due))
		.returning();
	if (!claimed.length) return out;

	// bot-vs-bot volume doesn't make a stock "trending" or trigger a re-decision
	const playerTrade = sql`NOT (COALESCE(${inArray(stockTrade.buyerId, botIds)}, false) AND COALESCE(${inArray(stockTrade.sellerId, botIds)}, false))`;
	const trending = new Map<number, number>();
	const publicIds = new Set(companies.filter((c) => c.status === 'PUBLIC').map((c) => c.id));
	if (claimed.some((r) => r.market === 'STOCK')) {
		const rows = await db
			.select({ id: stockTrade.companyId })
			.from(stockTrade)
			.where(and(gt(stockTrade.createdAt, new Date(Date.now() - 86_400_000)), playerTrade))
			.groupBy(stockTrade.companyId)
			.orderBy(desc(sql`SUM(${stockTrade.price} * ${stockTrade.shares})`));
		rows.filter((r) => publicIds.has(r.id)).forEach((r, i) => trending.set(r.id, i + 1));
	}

	// build items and decide who re-evaluates
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	type Item = {
		row: (typeof claimed)[number];
		company?: LiveCompany;
		coin?: LiveCoin;
		facts: Facts;
		latestQuarter: number;
		mood: Mood;
		due: Set<Archetype>;
		evaluated: boolean;
	};
	const items: Item[] = [];
	for (const row of claimed) {
		let item: Item;
		let archetypes: readonly Archetype[] = ARCHETYPES;
		if (row.market === 'STOCK') {
			const c = companies.find((x) => x.id === row.assetId);
			if (!c || (c.status === 'PRIVATE' && c.roundEndsAt.getTime() <= now)) continue; // waiting for IPO
			const { facts, latestQuarter } = await stockFacts(c, trending, publicIds.size);
			item = {
				row,
				company: c,
				facts,
				latestQuarter,
				mood: { ...row.mood },
				due: new Set(),
				evaluated: false
			};
			if (c.status === 'PRIVATE') archetypes = ['RETAIL', 'FUND'];
		} else {
			const cn = coins.find((x) => x.id === row.assetId);
			if (!cn) continue;
			const facts = await coinFacts(cn, coins.indexOf(cn) + 1, coins.length);
			item = {
				row,
				coin: cn,
				facts,
				latestQuarter: 0,
				mood: { ...row.mood },
				due: new Set(),
				evaluated: false
			};
		}
		const c = item.company;
		const ipoAt = c?.status === 'PUBLIC' ? c.roundEndsAt.getTime() : null;
		let all = false;
		if (
			row.lastEvalPrice &&
			Math.abs(item.facts.price / Number(row.lastEvalPrice) - 1) > CROWD_REEVAL_MOVE
		)
			all = true;
		if (!all && c?.status === 'PUBLIC') {
			const [big] = await db
				.select({ id: stockTrade.id })
				.from(stockTrade)
				.where(
					and(
						eq(stockTrade.companyId, c.id),
						gt(stockTrade.createdAt, row.lastEvalAt),
						sql`${stockTrade.price} * ${stockTrade.shares} >= ${(CROWD_BIG_TRADE * item.facts.marketCap).toFixed(8)}::numeric`,
						playerTrade
					)
				)
				.limit(1);
			if (big) all = true;
		}
		const newReport = item.latestQuarter > row.lastQuarter;
		for (const a of archetypes) {
			const m = item.mood[a];
			if (
				force ||
				all ||
				!m ||
				now >= Date.parse(m.nextEvalAt) ||
				(ipoAt !== null && Date.parse(m.evaluatedAt) < ipoAt) || // it IPO'd since
				(newReport && a !== 'RETAIL')
			)
				item.due.add(a);
			else if (newReport && a === 'RETAIL')
				m.nextEvalAt = new Date(
					Math.min(Date.parse(m.nextEvalAt), now + CROWD_RETAIL_LAG_MS * jitter())
				).toISOString();
		}
		items.push(item);
	}

	// decide, grouped by archetype so llama.cpp reuses the cached system prompt; no DB transaction is open here
	const decisions: (typeof crowdDecision.$inferInsert)[] = [];
	for (const a of ARCHETYPES) {
		for (const it of items) {
			if (!it.due.has(a)) continue;
			const d = await decide(a, it.facts);
			if (!d) {
				out.evals.postponed++;
				continue;
			}
			out.evals[d.source]++;
			const old = it.mood[a];
			it.mood[a] = {
				buy: old ? old.buy : d.probs.buy,
				sell: old ? old.sell : d.probs.sell,
				hold: old ? old.hold : d.probs.hold,
				rawBuy: d.probs.buy,
				rawSell: d.probs.sell,
				rawHold: d.probs.hold,
				reason: d.reason,
				source: d.source,
				evaluatedAt: nowIso,
				nextEvalAt: new Date(now + CROWD_EVAL_MS * jitter()).toISOString(),
				flow: old?.flow ?? 0
			};
			decisions.push({
				market: it.row.market,
				assetId: it.row.assetId,
				symbol: it.facts.symbol,
				archetype: a,
				source: d.source,
				model: d.model,
				context: d.context,
				pBuy: d.probs.buy.toFixed(4),
				pSell: d.probs.sell.toFixed(4),
				pHold: d.probs.hold.toFixed(4),
				latencyMs: d.latencyMs
			});
			it.evaluated = true;
		}
	}

	for (const it of items) {
		// smooth every tick, not only after decisions
		for (const a of ARCHETYPES) {
			const m = it.mood[a];
			if (!m) continue;
			const k = CROWD_SMOOTHING[a];
			m.buy += k * (m.rawBuy - m.buy);
			m.sell += k * (m.rawSell - m.sell);
			m.hold += k * (m.rawHold - m.hold);
		}

		try {
			if (it.company?.status === 'PRIVATE') await fillRound(b, it.company, it.mood, out);
			else if (it.company) {
				for (const a of shuffle(ARCHETYPES)) {
					const m = it.mood[a];
					if (m) await tradeStock(b[a], a, it.company.id, m, out);
				}
			} else if (it.coin) {
				for (const a of shuffle(ARCHETYPES)) {
					const m = it.mood[a];
					if (m) await tradeCoin(b[a], a, it.coin, settings.coinPool, m, out);
				}
			}
		} catch (err) {
			out.errors++;
			console.error('AI crowd tick failed for', it.facts.symbol, err);
		}

		await db
			.update(crowdAsset)
			.set({
				mood: it.mood,
				lastQuarter: it.latestQuarter,
				...(it.evaluated
					? { lastEvalPrice: it.facts.price.toFixed(8), lastEvalAt: new Date(now) }
					: {})
			})
			.where(eq(crowdAsset.id, it.row.id));
	}
	if (decisions.length) await db.insert(crowdDecision).values(decisions);
	out.assets = items.length;
	return out;
}
