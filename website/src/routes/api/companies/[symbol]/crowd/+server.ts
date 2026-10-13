import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	company,
	companyAnnouncement,
	companyEarnings,
	crowdAsset,
	crowdDecision,
	stockTrade,
	user
} from '$lib/server/db/schema';
import { and, desc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import { ARCHETYPES } from '$lib/server/crowd-decide';

const MOVE_MIN = 0.1; // an hour that moved the price 10% or more is a "big move"
const MOVE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MOVE_MAX = 3;
const NEWS_BEFORE_MS = 60 * 60 * 1000; // news up to 1h before a move can explain it (retail hears ~20 min late)
const BIG_TRADE = 0.01; // a player whose trades in the move reach 1% of market cap is named
const WHO = { RETAIL: 'Everyday investors', FUND: 'Big funds', TRADER: 'Fast traders' } as const;
const PROMISE = { PROFIT: 'a profit', REVENUE_UP: 'more revenue' } as const;

type Reason = {
	kind: 'EARNINGS' | 'NEWS' | 'FLOW' | 'MOOD' | 'TRADE';
	tone: 'up' | 'down' | 'neutral';
	text: string;
};

const money = (n: number) =>
	'$' +
	Math.abs(n).toLocaleString(
		'en-US',
		Math.abs(n) < 1 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 2 }
	);
const r2 = (x: number) => Math.round(x * 100) / 100;

// rule-made reasons from what is already stored; no LLM text
async function explain(companyId: number, mcap: number, from: Date, to: Date) {
	const newsFrom = new Date(from.getTime() - NEWS_BEFORE_MS);
	const takerId = sql`CASE WHEN ${stockTrade.takerSide} = 'BUY' THEN ${stockTrade.buyerId} ELSE ${stockTrade.sellerId} END`;
	const value = sql`${stockTrade.price} * ${stockTrade.shares}`;
	const isCrowd = sql<boolean>`COALESCE(${user.isBot}, false)`;
	const inMove = and(
		eq(stockTrade.companyId, companyId),
		gt(stockTrade.createdAt, from),
		lte(stockTrade.createdAt, to)
	);
	const [reports, news, flows, bigTrades, decisions] = await Promise.all([
		db
			.select({ quarter: companyEarnings.quarter, profit: companyEarnings.profit })
			.from(companyEarnings)
			.where(
				and(
					eq(companyEarnings.companyId, companyId),
					gte(companyEarnings.createdAt, newsFrom),
					lte(companyEarnings.createdAt, to)
				)
			),
		db
			.select({
				text: companyAnnouncement.text,
				claim: companyAnnouncement.claim,
				claimResult: companyAnnouncement.claimResult
			})
			.from(companyAnnouncement)
			.where(
				and(
					eq(companyAnnouncement.companyId, companyId),
					gte(companyAnnouncement.createdAt, newsFrom),
					lte(companyAnnouncement.createdAt, to)
				)
			)
			.orderBy(desc(companyAnnouncement.id))
			.limit(2),
		// net taker buying: who pushed the price, the AI crowd or players (deleted users count as players)
		db
			.select({
				crowd: isCrowd,
				net: sql<string>`SUM(CASE WHEN ${stockTrade.takerSide} = 'BUY' THEN ${value} ELSE -(${value}) END)`
			})
			.from(stockTrade)
			.leftJoin(user, eq(user.id, takerId))
			.where(inMove)
			.groupBy(isCrowd),
		db
			.select({
				username: user.username,
				side: stockTrade.takerSide,
				shares: sql<number>`SUM(${stockTrade.shares})::int`,
				total: sql<string>`SUM(${value})`
			})
			.from(stockTrade)
			.innerJoin(user, eq(user.id, takerId))
			.where(and(inMove, eq(user.isBot, false)))
			.groupBy(user.id, stockTrade.takerSide)
			.having(sql`SUM(${value}) >= ${(BIG_TRADE * mcap).toFixed(8)}::numeric`)
			.orderBy(desc(sql`SUM(${value})`))
			.limit(3),
		db
			.selectDistinctOn([crowdDecision.archetype], {
				archetype: crowdDecision.archetype,
				pBuy: crowdDecision.pBuy,
				pSell: crowdDecision.pSell,
				reason: crowdDecision.reason
			})
			.from(crowdDecision)
			.where(
				and(
					eq(crowdDecision.market, 'STOCK'),
					eq(crowdDecision.assetId, companyId),
					gte(crowdDecision.createdAt, newsFrom),
					lte(crowdDecision.createdAt, to)
				)
			)
			.orderBy(crowdDecision.archetype, desc(crowdDecision.createdAt))
	]);

	const out: Reason[] = [];
	for (const r of reports) {
		const p = Number(r.profit);
		out.push({
			kind: 'EARNINGS',
			tone: p > 0 ? 'up' : 'down',
			text: `Q${r.quarter} report: ${p > 0 ? `made a profit of ${money(p)}` : `lost ${money(p)}`}`
		});
	}
	for (const n of news) {
		const result =
			n.claimResult === true
				? ' (promise kept)'
				: n.claimResult === false
					? ' (promise broken)'
					: '';
		out.push({
			kind: 'NEWS',
			tone: 'neutral',
			text:
				`The founder said: "${n.text}"` +
				(n.claim ? ` They promised ${PROMISE[n.claim]} next report${result}.` : '')
		});
	}
	for (const f of flows.sort((a, b) => Math.abs(Number(b.net)) - Math.abs(Number(a.net)))) {
		const net = Number(f.net);
		if (Math.abs(net) < 1) continue;
		const [who, it] = f.crowd ? ['The AI crowd', 'it'] : ['Players', 'they'];
		out.push({
			kind: 'FLOW',
			tone: net > 0 ? 'up' : 'down',
			text:
				net > 0
					? `${who} bought ${money(net)} more than ${it} sold`
					: `${who} sold ${money(net)} more than ${it} bought`
		});
	}
	for (const a of ARCHETYPES) {
		const d = decisions.find((x) => x.archetype === a);
		if (!d) continue;
		const p = Number(d.pBuy) - Number(d.pSell);
		out.push({
			kind: 'MOOD',
			tone: p > 0.1 ? 'up' : p < -0.1 ? 'down' : 'neutral',
			text:
				`${WHO[a]} ${p > 0.1 ? 'were buying' : p < -0.1 ? 'were selling' : 'were waiting'}` +
				(d.reason ? `: ${d.reason}` : '')
		});
	}
	for (const t of bigTrades)
		out.push({
			kind: 'TRADE',
			tone: t.side === 'BUY' ? 'up' : 'down',
			text: `@${t.username} ${t.side === 'BUY' ? 'bought' : 'sold'} ${t.shares.toLocaleString('en-US')} shares (${money(Number(t.total))})`
		});
	return out;
}

export async function GET({ params }) {
	const [c] = await db
		.select({
			id: company.id,
			status: company.status,
			sharePrice: company.sharePrice,
			sharesOutstanding: company.sharesOutstanding
		})
		.from(company)
		.where(eq(company.symbol, params.symbol.toUpperCase()))
		.limit(1);
	if (!c) throw error(404, 'Company not found');

	const hour = sql`date_trunc('hour', ${stockTrade.createdAt})`;
	const [[row], closes] = await Promise.all([
		db
			.select({ mood: crowdAsset.mood })
			.from(crowdAsset)
			.where(and(eq(crowdAsset.market, 'STOCK'), eq(crowdAsset.assetId, c.id)))
			.limit(1),
		// hourly closes, newest first; +1h so the oldest move in the window has a "before"
		c.status === 'PUBLIC'
			? db
					.selectDistinctOn([hour], { price: stockTrade.price, at: stockTrade.createdAt })
					.from(stockTrade)
					.where(
						and(
							eq(stockTrade.companyId, c.id),
							gt(stockTrade.createdAt, new Date(Date.now() - MOVE_LOOKBACK_MS - 3_600_000))
						)
					)
					.orderBy(desc(hour), desc(stockTrade.id))
			: []
	]);

	const moves: { from: Date; to: Date; priceBefore: number; priceAfter: number; change: number }[] =
		[];
	for (let i = 0; i + 1 < closes.length && moves.length < MOVE_MAX; i++) {
		const priceAfter = Number(closes[i].price);
		const priceBefore = Number(closes[i + 1].price);
		const change = priceAfter / priceBefore - 1; // trade prices are always > 0
		if (Math.abs(change) >= MOVE_MIN)
			moves.push({ from: closes[i + 1].at, to: closes[i].at, priceBefore, priceAfter, change });
	}
	// shortcut: no cache (≤ 18 indexed queries per call, polled every 60s); add a 30s Redis cache if this page gets heavy traffic
	const mcap = Number(c.sharePrice) * c.sharesOutstanding;
	const reasons = await Promise.all(moves.map((m) => explain(c.id, mcap, m.from, m.to)));

	return json({
		mood: Object.fromEntries(
			ARCHETYPES.flatMap((a) => {
				const m = row?.mood[a];
				return m
					? [
							[
								a,
								{
									buy: r2(m.buy),
									sell: r2(m.sell),
									hold: r2(m.hold),
									reason: m.reason,
									evaluatedAt: m.evaluatedAt
								}
							]
						]
					: [];
			})
		),
		moves: moves.map((m, i) => ({
			...m,
			change: Math.round(m.change * 10000) / 10000,
			reasons: reasons[i]
		}))
	});
}
