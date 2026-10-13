import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { company, companyHolding, stockOrder, stockTrade, user } from '$lib/server/db/schema';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
	COMPANY_TOTAL_SHARES,
	COMPANY_VESTING_MS,
	STOCK_MARKET_BAND,
	STOCK_MAX_FILLS,
	STOCK_MAX_PRICE,
	SWAP_FEE_RATE
} from '$lib/data/constants';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Side = 'BUY' | 'SELL';
const KEEP = (1 - SWAP_FEE_RATE).toFixed(6); // seller keeps this; the fee is burned like the coin swap fee

export function lockedFounderShares(
	c: { roundShares: number; roundEndsAt: Date },
	now = Date.now()
) {
	const left = 1 - (now - c.roundEndsAt.getTime()) / COMPANY_VESTING_MS;
	return left <= 0 ? 0 : Math.ceil((COMPANY_TOTAL_SHARES - c.roundShares) * Math.min(1, left));
}

type CompanyRef = { id: number; founderId: number | null; roundShares: number; roundEndsAt: Date };

// shares stay in company_holding while listed; sell orders only reserve them by this check
export async function getSellable(q: Pick<typeof db, 'select'>, c: CompanyRef, userId: number) {
	const [h] = await q
		.select({ shares: companyHolding.shares })
		.from(companyHolding)
		.where(and(eq(companyHolding.userId, userId), eq(companyHolding.companyId, c.id)))
		.limit(1);
	const [l] = await q
		.select({ n: sql<number>`COALESCE(SUM(${stockOrder.shares}), 0)::int` })
		.from(stockOrder)
		.where(
			and(
				eq(stockOrder.companyId, c.id),
				eq(stockOrder.userId, userId),
				eq(stockOrder.side, 'SELL')
			)
		);
	const owned = h?.shares ?? 0;
	const locked = c.founderId === userId ? Math.min(owned, lockedFounderShares(c)) : 0;
	return { owned, listed: l.n, locked, sellable: Math.max(0, owned - l.n - locked) };
}

async function moveShares(tx: Tx, companyId: number, fromId: number, toId: number, q: number) {
	const [from] = await tx
		.update(companyHolding)
		.set({ shares: sql`${companyHolding.shares} - ${q}` })
		.where(and(eq(companyHolding.userId, fromId), eq(companyHolding.companyId, companyId)))
		.returning({ shares: companyHolding.shares });
	if (!from) throw new Error(`seller ${fromId} has no holding in company ${companyId}`); // never expected; rolls back
	if (from.shares === 0)
		await tx
			.delete(companyHolding)
			.where(and(eq(companyHolding.userId, fromId), eq(companyHolding.companyId, companyId)));
	await tx
		.insert(companyHolding)
		.values({ userId: toId, companyId, shares: q })
		.onConflictDoUpdate({
			target: [companyHolding.userId, companyHolding.companyId],
			set: { shares: sql`${companyHolding.shares} + ${q}` }
		});
}

export type OrderInput = {
	userId: number;
	companyId: number;
	side: Side;
	type: 'LIMIT' | 'MARKET';
	shares: number;
	price?: number;
};

// The only way into the stock market: the HTTP route and the Phase 4 crowd both call this.
// Lock order everywhere: company row, then user rows by ascending id, then holdings/orders.
export async function placeOrder({ userId, companyId, side, type, shares, price }: OrderInput) {
	if (!Number.isInteger(shares) || shares < 1 || shares > COMPANY_TOTAL_SHARES)
		throw error(400, 'Shares must be a whole number of at least 1');
	let limitStr = '';
	if (type === 'LIMIT') {
		if (typeof price !== 'number' || !Number.isFinite(price) || price > STOCK_MAX_PRICE)
			throw error(400, 'Enter a valid price');
		limitStr = price.toFixed(6);
		if (Number(limitStr) <= 0) throw error(400, 'Price must be at least $0.000001');
	}

	return db.transaction(async (tx) => {
		const [c] = await tx
			.select({
				id: company.id,
				founderId: company.founderId,
				status: company.status,
				sharePrice: company.sharePrice,
				roundShares: company.roundShares,
				roundEndsAt: company.roundEndsAt
			})
			.from(company)
			.where(eq(company.id, companyId))
			.for('update')
			.limit(1);
		if (!c) throw error(404, 'Company not found');
		if (c.status !== 'PUBLIC')
			throw error(
				400,
				c.status === 'BANKRUPT'
					? 'This company is bankrupt'
					: 'Trading starts when the company goes public'
			);

		// market = fill now or cancel, inside a price guard so an empty or thin book can't wreck you
		const last = Number(c.sharePrice);
		const bound =
			type === 'LIMIT'
				? limitStr
				: (last * (side === 'BUY' ? 1 + STOCK_MARKET_BAND : 1 - STOCK_MARKET_BAND)).toFixed(8);
		const opposite: Side = side === 'BUY' ? 'SELL' : 'BUY';
		const crosses = and(
			eq(stockOrder.companyId, c.id),
			eq(stockOrder.side, opposite),
			side === 'BUY' ? lte(stockOrder.price, bound) : gte(stockOrder.price, bound)
		);
		const book = await tx
			.select({
				id: stockOrder.id,
				userId: stockOrder.userId,
				price: stockOrder.price,
				shares: stockOrder.shares
			})
			.from(stockOrder)
			.where(crosses)
			.orderBy(side === 'BUY' ? asc(stockOrder.price) : desc(stockOrder.price), asc(stockOrder.id))
			.limit(STOCK_MAX_FILLS);

		const reach: typeof book = [];
		for (let i = 0, cum = 0; i < book.length && cum < shares; i++) {
			reach.push(book[i]);
			cum += book[i].shares;
		}
		if (reach.some((o) => o.userId === userId))
			throw error(400, 'This would trade with your own order. Cancel it first.');

		const ids = [...new Set([userId, ...reach.map((o) => o.userId)])];
		const users = await tx
			.select({ id: user.id, balance: user.baseCurrencyBalance })
			.from(user)
			.where(inArray(user.id, ids))
			.orderBy(asc(user.id))
			.for('update');
		const me = users.find((u) => u.id === userId);
		if (!me) throw error(404, 'User not found');
		const alive = new Set(users.map((u) => u.id)); // a maker deleted meanwhile: FK cascade already removed their orders

		if (side === 'SELL') {
			const s = await getSellable(tx, c, userId);
			if (shares > s.sellable)
				throw error(
					400,
					s.sellable > 0
						? `You can sell up to ${s.sellable} shares`
						: s.locked > 0
							? 'Your founder shares are still locked'
							: "You don't have shares to sell"
				);
		} else if (type === 'LIMIT' && Number(me.balance) < shares * Number(limitStr)) {
			throw error(400, `Not enough money. You need $${(shares * Number(limitStr)).toFixed(2)}.`);
		}

		// shortcut: one statement per row per fill (≤ STOCK_MAX_FILLS); batch if Phase 4 volume makes this slow
		let left = shares;
		let cash = Number(me.balance);
		let gross = 0;
		let lastPrice: string | null = null;
		for (const o of reach) {
			if (left === 0) break;
			if (!alive.has(o.userId)) continue;
			const p = Number(o.price);
			let q = Math.min(left, o.shares);
			// shortcut: float sizing for market buys; the exact SQL balance check below rolls back a rare off-by-one
			if (side === 'BUY' && type === 'MARKET') q = Math.min(q, Math.floor(cash / p));
			if (q === 0) break;
			cash -= q * p;
			const buyerId = side === 'BUY' ? userId : o.userId;
			const sellerId = side === 'BUY' ? o.userId : userId;
			const amount = sql`${o.price}::numeric * ${q}`;
			if (side === 'BUY')
				// maker buyers already paid when their order rested
				await tx
					.update(user)
					.set({
						baseCurrencyBalance: sql`${user.baseCurrencyBalance} - ${amount}`,
						updatedAt: new Date()
					})
					.where(eq(user.id, userId));
			await tx
				.update(user)
				.set({
					baseCurrencyBalance: sql`${user.baseCurrencyBalance} + ROUND(${amount} * ${KEEP}::numeric, 8)`,
					updatedAt: new Date()
				})
				.where(eq(user.id, sellerId));
			await moveShares(tx, c.id, sellerId, buyerId, q);
			if (q === o.shares) await tx.delete(stockOrder).where(eq(stockOrder.id, o.id));
			else
				await tx
					.update(stockOrder)
					.set({ shares: sql`${stockOrder.shares} - ${q}` })
					.where(eq(stockOrder.id, o.id));
			await tx
				.insert(stockTrade)
				.values({ companyId: c.id, buyerId, sellerId, takerSide: side, price: o.price, shares: q });
			left -= q;
			gross += q * p;
			lastPrice = o.price;
		}

		const filled = shares - left;
		if (type === 'MARKET' && filled === 0)
			throw error(
				400,
				side === 'BUY' && reach.length > 0
					? 'Not enough money for 1 share'
					: `No one is ${side === 'BUY' ? 'selling' : 'buying'} near the current price. Try a limit order.`
			);
		if (lastPrice)
			await tx.update(company).set({ sharePrice: lastPrice }).where(eq(company.id, c.id));

		let orderId: number | null = null;
		let resting = 0;
		if (type === 'LIMIT' && left > 0) {
			// never leave a crossed book: if something still crosses (fill cap hit), drop the rest
			const [stillCrosses] = await tx
				.select({ id: stockOrder.id })
				.from(stockOrder)
				.where(crosses)
				.limit(1);
			if (!stillCrosses) {
				if (side === 'BUY')
					await tx
						.update(user)
						.set({
							baseCurrencyBalance: sql`${user.baseCurrencyBalance} - ${limitStr}::numeric * ${left}`,
							updatedAt: new Date()
						})
						.where(eq(user.id, userId));
				const [row] = await tx
					.insert(stockOrder)
					.values({ companyId: c.id, userId, side, price: limitStr, shares: left })
					.returning({ id: stockOrder.id });
				orderId = row.id;
				resting = left;
			}
		}
		if (side === 'BUY') {
			// exact check; the JS checks above are estimates
			const [b] = await tx
				.select({ negative: sql<boolean>`${user.baseCurrencyBalance} < 0` })
				.from(user)
				.where(eq(user.id, userId));
			if (b.negative) throw error(400, 'Not enough money');
		}
		return {
			filled,
			total: side === 'BUY' ? gross : gross * (1 - SWAP_FEE_RATE), // display only
			avgPrice: filled > 0 ? gross / filled : null,
			resting,
			cancelled: shares - filled - resting,
			orderId
		};
	});
}

export async function cancelOrder(userId: number, orderId: number) {
	return db.transaction(async (tx) => {
		const [o] = await tx
			.select({
				companyId: stockOrder.companyId,
				userId: stockOrder.userId,
				side: stockOrder.side,
				price: stockOrder.price
			})
			.from(stockOrder)
			.where(eq(stockOrder.id, orderId))
			.limit(1);
		if (!o || o.userId !== userId) throw error(404, 'Order not found');
		await tx
			.select({ id: company.id })
			.from(company)
			.where(eq(company.id, o.companyId))
			.for('update');
		const [cur] = await tx
			.select({ shares: stockOrder.shares })
			.from(stockOrder)
			.where(eq(stockOrder.id, orderId))
			.limit(1);
		if (!cur) throw error(404, 'Order not found'); // filled while we waited for the lock
		if (o.side === 'BUY')
			await tx
				.update(user)
				.set({
					baseCurrencyBalance: sql`${user.baseCurrencyBalance} + ${o.price}::numeric * ${cur.shares}`,
					updatedAt: new Date()
				})
				.where(eq(user.id, userId));
		await tx.delete(stockOrder).where(eq(stockOrder.id, orderId));
		return { refunded: o.side === 'BUY' ? Number(o.price) * cur.shares : 0 };
	});
}

// caller holds the company row lock (bankruptcy); refunds go by ascending user id like everywhere else
export async function cancelAllOrders(tx: Tx, companyId: number) {
	const refunds = await tx
		.select({
			userId: stockOrder.userId,
			amount: sql<string>`SUM(${stockOrder.shares} * ${stockOrder.price})`
		})
		.from(stockOrder)
		.where(and(eq(stockOrder.companyId, companyId), eq(stockOrder.side, 'BUY')))
		.groupBy(stockOrder.userId)
		.orderBy(asc(stockOrder.userId));
	for (const r of refunds)
		await tx
			.update(user)
			.set({
				baseCurrencyBalance: sql`${user.baseCurrencyBalance} + ${r.amount}::numeric`,
				updatedAt: new Date()
			})
			.where(eq(user.id, r.userId));
	await tx.delete(stockOrder).where(eq(stockOrder.companyId, companyId));
}

// display value (like coins at current price): public shares at last price + cash waiting in buy orders
export async function getUserStocks(userId: number) {
	const [rows, [escrow]] = await Promise.all([
		db
			.select({
				symbol: company.symbol,
				name: company.name,
				status: company.status,
				shares: companyHolding.shares,
				price: company.sharePrice
			})
			.from(companyHolding)
			.innerJoin(company, eq(company.id, companyHolding.companyId))
			.where(eq(companyHolding.userId, userId))
			.orderBy(desc(companyHolding.shares)),
		db
			.select({ cash: sql<string>`COALESCE(SUM(${stockOrder.shares} * ${stockOrder.price}), 0)` })
			.from(stockOrder)
			.where(and(eq(stockOrder.userId, userId), eq(stockOrder.side, 'BUY')))
	]);
	// private shares can't be sold yet and bankrupt ones are worth 0
	const stockHoldings = rows.map((r) => {
		const price = Number(r.price);
		return { ...r, price, value: r.status === 'PUBLIC' ? r.shares * price : 0 };
	});
	const orderCash = Number(escrow.cash);
	return {
		stockHoldings,
		orderCash,
		totalStockValue: orderCash + stockHoldings.reduce((s, h) => s + h.value, 0)
	};
}
