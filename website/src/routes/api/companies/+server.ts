import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { company, companyHolding, user } from '$lib/server/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isNameAppropriate } from '$lib/server/moderation';
import {
	COMPANY_CREATION_FEE,
	COMPANY_TOTAL_SHARES,
	COMPANY_MIN_VALUATION,
	COMPANY_MAX_VALUATION,
	COMPANY_MIN_OFFER_PERCENT,
	COMPANY_MAX_OFFER_PERCENT,
	COMPANY_ROUND_DURATION_MS,
	COMPANY_SECTORS
} from '$lib/data/constants';

const CreateCompanySchema = z.object({
	name: z
		.string()
		.trim()
		.min(2, 'Name must be 2-40 characters')
		.max(40, 'Name must be 2-40 characters')
		.regex(
			/^[a-zA-Z0-9]+( [a-zA-Z0-9]+)*$/,
			'Name can only use letters, numbers and single spaces'
		),
	symbol: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{2,5}$/, 'Ticker must be 2-5 letters'),
	sector: z.enum(COMPANY_SECTORS, 'Pick a sector'),
	pitch: z
		.string()
		.trim()
		.min(20, 'Pitch must be 20-1000 characters')
		.max(1000, 'Pitch must be 20-1000 characters'),
	valuation: z.number().int().min(COMPANY_MIN_VALUATION).max(COMPANY_MAX_VALUATION),
	offerPercent: z.number().int().min(COMPANY_MIN_OFFER_PERCENT).max(COMPANY_MAX_OFFER_PERCENT)
});

export async function GET() {
	// shortcut: newest 100 only, add pagination like /api/market when the list grows
	const rows = await db
		.select({
			symbol: company.symbol,
			name: company.name,
			sector: company.sector,
			status: company.status,
			sharePrice: company.sharePrice,
			roundShares: company.roundShares,
			roundSharesSold: company.roundSharesSold,
			roundEndsAt: company.roundEndsAt,
			treasuryCash: company.treasuryCash,
			createdAt: company.createdAt,
			founderUsername: user.username
		})
		.from(company)
		.leftJoin(user, eq(user.id, company.founderId))
		.orderBy(desc(company.createdAt))
		.limit(100);

	return json({
		companies: rows.map((c) => ({
			...c,
			sharePrice: Number(c.sharePrice),
			treasuryCash: Number(c.treasuryCash)
		}))
	});
}

export async function POST({ request }) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		throw error(401, 'Not authenticated');
	}
	const userId = Number(session.user.id);

	const parsed = CreateCompanySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		throw error(400, parsed.error.issues[0].message);
	}
	const { name, symbol, sector, pitch, valuation, offerPercent } = parsed.data;

	const [nameOk, symbolOk, pitchOk] = await Promise.all([
		isNameAppropriate(name),
		isNameAppropriate(symbol),
		isNameAppropriate(pitch)
	]);
	if (!nameOk) throw error(400, 'Company name contains inappropriate content');
	if (!symbolOk) throw error(400, 'Ticker contains inappropriate content');
	if (!pitchOk) throw error(400, 'Pitch contains inappropriate content');

	const roundShares = (COMPANY_TOTAL_SHARES * offerPercent) / 100;
	const founderShares = COMPANY_TOTAL_SHARES - roundShares;
	const sharePrice = (valuation / COMPANY_TOTAL_SHARES).toFixed(8);

	const created = await db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: company.id })
			.from(company)
			.where(eq(company.symbol, symbol))
			.limit(1);
		if (existing) {
			throw error(400, 'A company with this ticker already exists');
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

		const balance = Number(userData.baseCurrencyBalance);
		if (balance < COMPANY_CREATION_FEE) {
			throw error(
				400,
				`Insufficient funds. You need $${COMPANY_CREATION_FEE.toFixed(2)} but only have $${balance.toFixed(2)}.`
			);
		}

		await tx
			.update(user)
			.set({
				baseCurrencyBalance: sql`${user.baseCurrencyBalance} - ${COMPANY_CREATION_FEE.toFixed(8)}::numeric`,
				updatedAt: new Date()
			})
			.where(eq(user.id, userId));

		const [newCompany] = await tx
			.insert(company)
			.values({
				name,
				symbol,
				sector,
				pitch,
				founderId: userId,
				sharePrice,
				sharesOutstanding: founderShares,
				roundShares,
				roundEndsAt: new Date(Date.now() + COMPANY_ROUND_DURATION_MS)
			})
			.returning({ id: company.id, symbol: company.symbol });

		await tx
			.insert(companyHolding)
			.values({ userId, companyId: newCompany.id, shares: founderShares });

		return newCompany;
	});

	return json({
		success: true,
		company: { symbol: created.symbol },
		feePaid: COMPANY_CREATION_FEE
	});
}
