import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { company, companyHolding, user } from '$lib/server/db/schema';
import { eq, desc } from 'drizzle-orm';

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

	const holderRows = await db
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
		.limit(50);

	return json({
		company: {
			...c,
			sharePrice: Number(c.sharePrice),
			treasuryCash: Number(c.treasuryCash),
			founderUsername: row.founderUsername,
			founderName: row.founderName,
			founderImage: row.founderImage
		},
		holders: holderRows.map((h) => ({
			...h,
			percentage: c.sharesOutstanding > 0 ? (h.shares / c.sharesOutstanding) * 100 : 0
		}))
	});
}
