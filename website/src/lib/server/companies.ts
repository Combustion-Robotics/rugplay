import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	company,
	companyAnnouncement,
	companyEarnings,
	companyHolding,
	sectorCondition,
	user
} from '$lib/server/db/schema';
import { and, desc, eq, gt, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import {
	COMPANY_QUARTER_MS,
	COMPANY_SECTORS,
	COMPANY_SPENDING,
	SECTOR_DRIFT_PULL,
	SECTOR_DRIFT_STEP,
	SECTOR_MULTIPLIER_MAX,
	SECTOR_MULTIPLIER_MIN
} from '$lib/data/constants';
import { createNotification } from '$lib/server/notification';
import { cancelAllOrders } from '$lib/server/orderbook';

const CREDIBILITY_PRIOR = 2; // a new founder starts at 100%; a broken promise costs more than a kept one earns back

// per founder, across all their companies; the company page and the AI crowd both read it
export async function getCredibility(userId: number) {
	const [r] = await db
		.select({
			kept: sql<number>`COUNT(*) FILTER (WHERE ${companyAnnouncement.claimResult})::int`,
			broken: sql<number>`COUNT(*) FILTER (WHERE NOT ${companyAnnouncement.claimResult})::int`,
			pending: sql<number>`COUNT(*) FILTER (WHERE ${companyAnnouncement.claim} IS NOT NULL AND ${companyAnnouncement.claimResult} IS NULL)::int`
		})
		.from(companyAnnouncement)
		.where(eq(companyAnnouncement.authorId, userId));
	return { ...r, score: (r.kept + CREDIBILITY_PRIOR) / (r.kept + r.broken + CREDIBILITY_PRIOR) };
}

export function computeQuarter(
	raised: number,
	level: keyof typeof COMPANY_SPENDING,
	sectorMultiplier: number,
	luck = Math.random()
) {
	const { rate, luckMin, luckMax } = COMPANY_SPENDING[level];
	const spending = raised * rate;
	const revenue = spending * sectorMultiplier * (luckMin + (luckMax - luckMin) * luck);
	return { spending, revenue, profit: revenue - spending };
}

// force = admin "close one quarter now" (ignores the timers, never the funding round)
export async function closeCompanyQuarters(force = false): Promise<number> {
	const now = new Date();
	const cutoff = new Date(now.getTime() - COMPANY_QUARTER_MS);
	const nextQuarterAt = new Date(now.getTime() + COMPANY_QUARTER_MS);
	let closed = 0;
	// IPO: a round that ended with at least one investor goes public at the round price
	await db
		.update(company)
		.set({ status: 'PUBLIC' })
		.where(
			and(
				eq(company.status, 'PRIVATE'),
				lte(company.roundEndsAt, now),
				gt(company.roundSharesSold, 0)
			)
		);
	await db
		.insert(sectorCondition)
		.values(COMPANY_SECTORS.map((sector) => ({ sector })))
		.onConflictDoNothing();
	// one statement: concurrent runners block on the row lock, re-check updated_at, and skip
	await db
		.update(sectorCondition)
		.set({
			multiplier: sql`LEAST(${SECTOR_MULTIPLIER_MAX}::numeric, GREATEST(${SECTOR_MULTIPLIER_MIN}::numeric,
					${sectorCondition.multiplier} + (1 - ${sectorCondition.multiplier}) * ${SECTOR_DRIFT_PULL}::numeric
					+ (random()::numeric * 2 - 1) * ${SECTOR_DRIFT_STEP}::numeric))`,
			updatedAt: now
		})
		.where(force ? undefined : lte(sectorCondition.updatedAt, cutoff));
	const sectors = new Map(
		(await db.select().from(sectorCondition)).map((s) => [s.sector, Number(s.multiplier)])
	);

	const due = await db
		.select({ id: company.id })
		.from(company)
		.where(
			and(
				ne(company.status, 'BANKRUPT'),
				lte(company.roundEndsAt, now), // no quarters while the funding round runs
				force ? undefined : lte(company.nextQuarterAt, now)
			)
		);

	for (const { id } of due) {
		try {
			const bankrupt = await db.transaction(async (tx) => {
				const [c] = await tx
					.select({
						name: company.name,
						symbol: company.symbol,
						sector: company.sector,
						status: company.status,
						spendingLevel: company.spendingLevel,
						treasuryCash: company.treasuryCash,
						raisedCash: company.raisedCash,
						nextQuarterAt: company.nextQuarterAt
					})
					.from(company)
					.where(eq(company.id, id))
					.for('update')
					.limit(1);
				// re-check under the lock: another replica or an admin call may have just closed it
				if (!c || c.status === 'BANKRUPT' || (!force && c.nextQuarterAt > now)) return null;

				const raised = Number(c.raisedCash);
				const sectorMultiplier = sectors.get(c.sector) ?? 1;
				const r = computeQuarter(raised, c.spendingLevel, sectorMultiplier);
				const profit = r.profit.toFixed(8);
				const cashAfter = Number(c.treasuryCash) + Number(profit);
				const isBankrupt = cashAfter <= 0;

				const [last] = await tx
					.select({ quarter: companyEarnings.quarter, revenue: companyEarnings.revenue })
					.from(companyEarnings)
					.where(eq(companyEarnings.companyId, id))
					.orderBy(desc(companyEarnings.quarter))
					.limit(1);
				await tx.insert(companyEarnings).values({
					companyId: id,
					quarter: (last?.quarter ?? 0) + 1,
					spendingLevel: c.spendingLevel,
					sectorMultiplier: sectorMultiplier.toFixed(2),
					revenue: r.revenue.toFixed(8),
					spending: r.spending.toFixed(8),
					profit,
					cashAfter: cashAfter.toFixed(8)
				});
				// promises made before this report are checked now; credibility counts these rows
				const kept = {
					PROFIT: Number(profit) > 0,
					REVENUE_UP: last ? Number(r.revenue.toFixed(8)) > Number(last.revenue) : false
				};
				await tx
					.update(companyAnnouncement)
					.set({
						claimResult: sql`CASE ${companyAnnouncement.claim} WHEN 'PROFIT' THEN ${kept.PROFIT}::boolean ELSE ${kept.REVENUE_UP}::boolean END`
					})
					.where(
						and(
							eq(companyAnnouncement.companyId, id),
							isNotNull(companyAnnouncement.claim),
							isNull(companyAnnouncement.claimResult)
						)
					);
				if (isBankrupt) await cancelAllOrders(tx, id);
				await tx
					.update(company)
					.set(
						isBankrupt
							? {
									status: 'BANKRUPT',
									treasuryCash: '0.00000000',
									sharePrice: '0.00000000',
									nextQuarterAt
								}
							: {
									treasuryCash: sql`${company.treasuryCash} + ${profit}::numeric`,
									nextQuarterAt
								}
					)
					.where(eq(company.id, id));
				closed++;
				return isBankrupt ? c : null;
			});
			if (bankrupt) {
				const holders = await db
					.select({ userId: companyHolding.userId })
					.from(companyHolding)
					.where(eq(companyHolding.companyId, id));
				for (const h of holders) {
					await createNotification(
						h.userId.toString(),
						'SYSTEM',
						`${bankrupt.name} went bankrupt`,
						`${bankrupt.symbol} ran out of cash. Its shares are now worth $0.`,
						`/companies/${bankrupt.symbol}`
					).catch(console.error);
				}
			}
		} catch (err) {
			console.error(`Failed to close quarter for company ${id}:`, err);
		}
	}
	if (closed > 0) console.log(`📊 Closed ${closed} company quarters`);
	return closed;
}

// the invest route and the AI crowd both call this; lock order: company, then user (see orderbook.ts)
export async function investInRound(userId: number, symbol: string, shares: number) {
	return db.transaction(async (tx) => {
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
}
