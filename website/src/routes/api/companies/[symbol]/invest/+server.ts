import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { COMPANY_TOTAL_SHARES } from '$lib/data/constants';
import { investInRound } from '$lib/server/companies';

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

	const result = await investInRound(userId, params.symbol.toUpperCase(), shares);

	return json({
		success: true,
		sharesBought: shares,
		totalCost: result.cost,
		newBalance: result.newBalance
	});
}
