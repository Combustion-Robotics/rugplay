import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/auth';
import { db } from '$lib/server/db';
import {
	coin,
	company,
	companyHolding,
	crowdDecision,
	crowdSettings,
	stockOrder,
	user,
	userPortfolio
} from '$lib/server/db/schema';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { getCrowdSettings } from '$lib/server/crowd';

async function requireAdmin(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) throw error(403, 'Admin access required');

	const [currentUser] = await db
		.select({ isAdmin: user.isAdmin })
		.from(user)
		.where(eq(user.id, Number(session.user.id)))
		.limit(1);
	if (!currentUser?.isAdmin) throw error(403, 'Admin access required');
}

const SettingsSchema = z.object({
	enabled: z.boolean(),
	coinsEnabled: z.boolean(),
	coinPool: z.number().min(0).max(1_000_000_000)
});

async function botValues(id: number) {
	const [[orders], [stocks], [coins]] = await Promise.all([
		db
			.select({ v: sql<string>`COALESCE(SUM(${stockOrder.shares} * ${stockOrder.price}), 0)` })
			.from(stockOrder)
			.where(and(eq(stockOrder.userId, id), eq(stockOrder.side, 'BUY'))),
		db
			.select({
				v: sql<string>`COALESCE(SUM(${companyHolding.shares} * ${company.sharePrice}), 0)`
			})
			.from(companyHolding)
			.innerJoin(company, eq(company.id, companyHolding.companyId))
			.where(and(eq(companyHolding.userId, id), eq(company.status, 'PUBLIC'))),
		db
			.select({
				v: sql<string>`COALESCE(SUM(${userPortfolio.quantity} * ${coin.currentPrice}), 0)`
			})
			.from(userPortfolio)
			.innerJoin(coin, eq(coin.id, userPortfolio.coinId))
			.where(eq(userPortfolio.userId, id))
	]);
	return { orderCash: Number(orders.v), stockValue: Number(stocks.v), coinValue: Number(coins.v) };
}

export const GET: RequestHandler = async ({ request }) => {
	await requireAdmin(request);

	const [settings, botRows, sources, recent] = await Promise.all([
		getCrowdSettings(),
		db
			.select({ id: user.id, username: user.username, cash: user.baseCurrencyBalance })
			.from(user)
			.where(eq(user.isBot, true))
			.orderBy(user.id),
		db
			.select({ source: crowdDecision.source, n: sql<number>`COUNT(*)::int` })
			.from(crowdDecision)
			.where(gt(crowdDecision.createdAt, new Date(Date.now() - 3_600_000)))
			.groupBy(crowdDecision.source),
		db.select().from(crowdDecision).orderBy(desc(crowdDecision.id)).limit(20)
	]);
	const bots = await Promise.all(
		botRows.map(async (b) => ({
			archetype: b.username.replace(/^crowd-/, '').toUpperCase(),
			username: b.username,
			cash: Number(b.cash),
			...(await botValues(b.id))
		}))
	);

	return json({
		settings,
		llm: { configured: !!env.CROWD_LLM_URL, model: env.CROWD_LLM_MODEL || 'local' },
		bots,
		lastHour: Object.fromEntries(sources.map((s) => [s.source, Number(s.n)])),
		recent: recent.map((d) => ({
			id: d.id,
			market: d.market,
			symbol: d.symbol,
			archetype: d.archetype,
			source: d.source,
			buy: Number(d.pBuy),
			sell: Number(d.pSell),
			hold: Number(d.pHold),
			createdAt: d.createdAt
		}))
	});
};

export const PUT: RequestHandler = async ({ request }) => {
	await requireAdmin(request);

	const parsed = SettingsSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Invalid settings');
	const { enabled, coinsEnabled, coinPool } = parsed.data;

	const values = { enabled, coinsEnabled, coinPool: coinPool.toFixed(8), updatedAt: new Date() };
	await db
		.insert(crowdSettings)
		.values({ id: 1, ...values })
		.onConflictDoUpdate({ target: crowdSettings.id, set: values });

	return json({ success: true, settings: { enabled, coinsEnabled, coinPool } });
};
