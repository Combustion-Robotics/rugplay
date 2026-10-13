import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { company, stockOrder, stockTrade } from '$lib/server/db/schema';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { COMPANY_TOTAL_SHARES, STOCK_BOOK_DEPTH, STOCK_MAX_PRICE } from '$lib/data/constants';
import { getSellable, placeOrder } from '$lib/server/orderbook';

const OrderSchema = z.object({
	side: z.enum(['BUY', 'SELL'], 'Pick buy or sell'),
	type: z.enum(['LIMIT', 'MARKET'], 'Pick limit or market'),
	shares: z
		.number('Enter a number of shares')
		.int('Shares must be a whole number')
		.positive('Shares must be at least 1')
		.max(COMPANY_TOTAL_SHARES),
	price: z
		.number('Enter a price')
		.positive('Price must be above $0')
		.max(STOCK_MAX_PRICE)
		.optional()
});

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

export async function GET({ params, request }) {
	const [c] = await db
		.select({
			id: company.id,
			founderId: company.founderId,
			status: company.status,
			sharePrice: company.sharePrice,
			roundShares: company.roundShares,
			roundSharesSold: company.roundSharesSold,
			roundEndsAt: company.roundEndsAt,
			raisedCash: company.raisedCash
		})
		.from(company)
		.where(eq(company.symbol, params.symbol.toUpperCase()))
		.limit(1);
	if (!c) throw error(404, 'Company not found');

	const session = await auth.api.getSession({ headers: request.headers });
	const userId = session?.user ? Number(session.user.id) : null;

	const level = (side: 'BUY' | 'SELL') =>
		db
			.select({ price: stockOrder.price, shares: sql`SUM(${stockOrder.shares})`.mapWith(Number) })
			.from(stockOrder)
			.where(and(eq(stockOrder.companyId, c.id), eq(stockOrder.side, side)))
			.groupBy(stockOrder.price)
			.orderBy(side === 'BUY' ? desc(stockOrder.price) : asc(stockOrder.price))
			.limit(STOCK_BOOK_DEPTH);

	const [bids, asks, trades, [refTrade], mine, myOrders] = await Promise.all([
		level('BUY'),
		level('SELL'),
		db
			.select({
				id: stockTrade.id,
				price: stockTrade.price,
				shares: stockTrade.shares,
				takerSide: stockTrade.takerSide,
				createdAt: stockTrade.createdAt
			})
			.from(stockTrade)
			.where(eq(stockTrade.companyId, c.id))
			.orderBy(desc(stockTrade.id))
			.limit(500),
		db
			.select({ price: stockTrade.price })
			.from(stockTrade)
			.where(
				and(
					eq(stockTrade.companyId, c.id),
					lte(stockTrade.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000))
				)
			)
			.orderBy(desc(stockTrade.createdAt))
			.limit(1),
		userId ? getSellable(db, c, userId) : null,
		userId
			? db
					.select({
						id: stockOrder.id,
						side: stockOrder.side,
						price: stockOrder.price,
						shares: stockOrder.shares,
						createdAt: stockOrder.createdAt
					})
					.from(stockOrder)
					.where(and(eq(stockOrder.companyId, c.id), eq(stockOrder.userId, userId)))
					.orderBy(desc(stockOrder.id))
			: []
	]);

	const lastPrice = Number(c.sharePrice);
	const ipoPrice =
		c.roundSharesSold > 0 ? Number(c.raisedCash) / c.roundSharesSold : Number(c.sharePrice);
	const ref = refTrade ? Number(refTrade.price) : ipoPrice;

	const chart = new Map<number, number>();
	if (c.status !== 'PRIVATE') chart.set(sec(c.roundEndsAt), ipoPrice);
	for (let i = trades.length - 1; i >= 0; i--)
		chart.set(sec(trades[i].createdAt), Number(trades[i].price));

	return json({
		lastPrice,
		change24h: ref > 0 ? ((lastPrice - ref) / ref) * 100 : 0,
		bids: bids.map((l) => ({ price: Number(l.price), shares: l.shares })),
		asks: asks.map((l) => ({ price: Number(l.price), shares: l.shares })),
		trades: trades.slice(0, 20).map((t) => ({ ...t, price: Number(t.price) })),
		chart: [...chart].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value })),
		me: mine && {
			shares: mine.owned,
			sellable: mine.sellable,
			lockedShares: mine.locked,
			orders: myOrders.map((o) => ({ ...o, price: Number(o.price) }))
		}
	});
}

export async function POST({ params, request }) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) throw error(401, 'Not authenticated');

	const parsed = OrderSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, parsed.error.issues[0].message);
	if (parsed.data.type === 'LIMIT' && parsed.data.price === undefined)
		throw error(400, 'Enter a price');

	const [c] = await db
		.select({ id: company.id })
		.from(company)
		.where(eq(company.symbol, params.symbol.toUpperCase()))
		.limit(1);
	if (!c) throw error(404, 'Company not found');

	return json({
		success: true,
		...(await placeOrder({ userId: Number(session.user.id), companyId: c.id, ...parsed.data }))
	});
}
