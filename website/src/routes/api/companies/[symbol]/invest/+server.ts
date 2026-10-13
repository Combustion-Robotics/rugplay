import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { company, companyHolding, user } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { COMPANY_TOTAL_SHARES } from '$lib/data/constants';

const InvestSchema = z.object({ shares: z.number().int().positive().max(COMPANY_TOTAL_SHARES) });

export async function POST({ params, request }) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		throw error(401, 'Not authenticated');
	}
	const userId = Number(session.user.id);

	const parsed = InvestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		throw error(400, 'Shares must be a whole number of at least 1');
	}
	const { shares } = parsed.data;
	const symbol = params.symbol.toUpperCase();

	const result = await db.transaction(async (tx) => {
		// lock order: company, then user (same as the order book, see lib/server/orderbook.ts)
		const [c] = await tx
			.select({
				id: company.id,
				founderId: company.founderId,
				status: company.status,
				sharePrice: company.sharePrice,
				roundShares: company.roundShares,
				roundSharesSold: company.roundSharesSold,
				roundEndsAt: company.roundEndsAt,
				cost: sql<string>`${company.sharePrice} * ${shares}` // exact numeric math
			})
			.from(company)
			.where(eq(company.symbol, symbol))
			.for('update')
			.limit(1);
		if (!c) {
			throw error(404, 'Company not found');
		}

		const [userData] = await tx
			.select({ baseCurrencyBalance: user.baseCurrencyBalance })
			.from(user)
			.where(eq(user.id, userId))
			.for('update')
			.limit(1);
		if (!userData) {
			throw error(404, 'User not found');
		}

		if (c.founderId === userId) {
			throw error(400, "You can't invest in your own company");
		}

		const left = c.roundShares - c.roundSharesSold;
		if (c.status !== 'PRIVATE' || new Date() >= c.roundEndsAt || left <= 0) {
			throw error(400, 'This funding round is closed');
		}
		if (shares > left) {
			throw error(400, `Only ${left} shares left in this round`);
		}

		const costStr = c.cost;
		const cost = Number(costStr);
		const balance = Number(userData.baseCurrencyBalance);
		if (balance < cost) {
			throw error(
				400,
				`Insufficient funds. You need $${cost.toFixed(2)} but only have $${balance.toFixed(2)}.`
			);
		}

		await tx
			.update(user)
			.set({
				baseCurrencyBalance: sql`${user.baseCurrencyBalance} - ${costStr}::numeric`,
				updatedAt: new Date()
			})
			.where(eq(user.id, userId));

		await tx
			.update(company)
			.set({
				roundSharesSold: sql`${company.roundSharesSold} + ${shares}`,
				sharesOutstanding: sql`${company.sharesOutstanding} + ${shares}`,
				treasuryCash: sql`${company.treasuryCash} + ${costStr}::numeric`,
				raisedCash: sql`${company.raisedCash} + ${costStr}::numeric`
			})
			.where(eq(company.id, c.id));

		await tx
			.insert(companyHolding)
			.values({ userId, companyId: c.id, shares })
			.onConflictDoUpdate({
				target: [companyHolding.userId, companyHolding.companyId],
				set: { shares: sql`${companyHolding.shares} + ${shares}` }
			});

		return { cost, newBalance: balance - cost };
	});

	return json({
		success: true,
		sharesBought: shares,
		totalCost: result.cost,
		newBalance: result.newBalance
	});
}
