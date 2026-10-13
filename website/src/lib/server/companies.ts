import { db } from '$lib/server/db';
import { company, companyEarnings, companyHolding, sectorCondition } from '$lib/server/db/schema';
import { and, desc, eq, lte, ne, sql } from 'drizzle-orm';
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
						sharePrice: company.sharePrice,
						roundSharesSold: company.roundSharesSold,
						nextQuarterAt: company.nextQuarterAt
					})
					.from(company)
					.where(eq(company.id, id))
					.for('update')
					.limit(1);
				// re-check under the lock: another replica or an admin call may have just closed it
				if (!c || c.status === 'BANKRUPT' || (!force && c.nextQuarterAt > now)) return null;

				// shortcut: raised = round shares × round price; the IPO phase must store raised cash before sharePrice starts moving
				const raised = c.roundSharesSold * Number(c.sharePrice);
				const sectorMultiplier = sectors.get(c.sector) ?? 1;
				const r = computeQuarter(raised, c.spendingLevel, sectorMultiplier);
				const profit = r.profit.toFixed(8);
				const cashAfter = Number(c.treasuryCash) + Number(profit);
				const isBankrupt = cashAfter <= 0;

				const [last] = await tx
					.select({ quarter: companyEarnings.quarter })
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
