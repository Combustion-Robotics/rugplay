import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { auth } from '$lib/auth';
import {
	company,
	companyEarnings,
	companyHolding,
	sectorCondition,
	user
} from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { COMPANY_SPENDING_LEVELS } from '$lib/data/constants';

const SpendingSchema = z.object({ spendingLevel: z.enum(COMPANY_SPENDING_LEVELS) });

export async function GET({ params }) {
	const symbol = params.symbol.toUpperCase();

	const [row] = await db
		.select({
			company,
			founderUsername: user.username,
			founderName: user.name,
			founderImage: user.image
		})
		.from(company)
		.leftJoin(user, eq(user.id, company.founderId))
		.where(eq(company.symbol, symbol))
		.limit(1);

	if (!row) {
		throw error(404, 'Company not found');
	}
	const c = row.company;

	const [holderRows, reports, [sector]] = await Promise.all([
		db
			.select({
				userId: user.id,
				username: user.username,
				name: user.name,
				image: user.image,
				nameColor: user.nameColor,
				shares: companyHolding.shares
			})
			.from(companyHolding)
			.innerJoin(user, eq(user.id, companyHolding.userId))
			.where(eq(companyHolding.companyId, c.id))
			.orderBy(desc(companyHolding.shares))
			.limit(50),
		db
			.select()
			.from(companyEarnings)
			.where(eq(companyEarnings.companyId, c.id))
			.orderBy(desc(companyEarnings.quarter))
			.limit(8),
		db
			.select({ multiplier: sectorCondition.multiplier })
			.from(sectorCondition)
			.where(eq(sectorCondition.sector, c.sector))
			.limit(1)
	]);

	return json({
		company: {
			...c,
			sharePrice: Number(c.sharePrice),
			treasuryCash: Number(c.treasuryCash),
			raisedCash: Number(c.raisedCash),
			founderUsername: row.founderUsername,
			founderName: row.founderName,
			founderImage: row.founderImage
		},
		reports: reports.map((r) => ({
			quarter: r.quarter,
			spendingLevel: r.spendingLevel,
			sectorMultiplier: Number(r.sectorMultiplier),
			revenue: Number(r.revenue),
			spending: Number(r.spending),
			profit: Number(r.profit),
			cashAfter: Number(r.cashAfter),
			createdAt: r.createdAt
		})),
		sectorMultiplier: sector ? Number(sector.multiplier) : 1,
		holders: holderRows.map((h) => ({
			...h,
			percentage: c.sharesOutstanding > 0 ? (h.shares / c.sharesOutstanding) * 100 : 0
		}))
	});
}

export async function PATCH({ params, request }) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) throw error(401, 'Not authenticated');

	const parsed = SpendingSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, 'Pick LOW, MEDIUM or HIGH');

	const [c] = await db
		.select({ id: company.id, founderId: company.founderId, status: company.status })
		.from(company)
		.where(eq(company.symbol, params.symbol.toUpperCase()))
		.limit(1);
	if (!c) throw error(404, 'Company not found');
	if (c.founderId !== Number(session.user.id)) {
		throw error(403, 'Only the founder can change spending');
	}
	if (c.status === 'BANKRUPT') throw error(400, 'This company is bankrupt');

	// no money moves here; the quarter close reads the level under its row lock
	await db
		.update(company)
		.set({ spendingLevel: parsed.data.spendingLevel })
		.where(eq(company.id, c.id));
	return json({ success: true, spendingLevel: parsed.data.spendingLevel });
}
