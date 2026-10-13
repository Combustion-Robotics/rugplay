import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { company, companyAnnouncement, companyEarnings } from '$lib/server/db/schema';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { isNameAppropriate } from '$lib/server/moderation';

const ANNOUNCE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // per company; every post wakes the AI crowd

const AnnouncementSchema = z.object({
	text: z
		.string('Write 5-200 characters')
		.transform((s) => s.replace(/\s+/g, ' ').trim())
		.pipe(z.string().min(5, 'Write 5-200 characters').max(200, 'Write 5-200 characters')),
	claim: z.enum(['PROFIT', 'REVENUE_UP'], 'Pick a valid promise').nullish()
});

export async function POST({ params, request }) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) throw error(401, 'Not authenticated');
	const userId = Number(session.user.id);

	const parsed = AnnouncementSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) throw error(400, parsed.error.issues[0].message);
	const { text } = parsed.data;
	const claim = parsed.data.claim ?? null;

	const [c] = await db
		.select({ id: company.id, founderId: company.founderId, status: company.status })
		.from(company)
		.where(eq(company.symbol, params.symbol.toUpperCase()))
		.limit(1);
	if (!c) throw error(404, 'Company not found');
	if (c.founderId !== userId) throw error(403, 'Only the founder can post news');
	if (c.status === 'BANKRUPT') throw error(400, 'This company is bankrupt');
	if (!(await isNameAppropriate(text)))
		throw error(400, 'Your post contains inappropriate content');

	const announcement = await db.transaction(async (tx) => {
		// the company lock serializes posts (cooldown) and orders them against the quarter close that checks promises
		const [locked] = await tx
			.select({ status: company.status })
			.from(company)
			.where(eq(company.id, c.id))
			.for('update')
			.limit(1);
		if (!locked || locked.status === 'BANKRUPT') throw error(400, 'This company is bankrupt');

		const [last] = await tx
			.select({ createdAt: companyAnnouncement.createdAt })
			.from(companyAnnouncement)
			.where(eq(companyAnnouncement.companyId, c.id))
			.orderBy(desc(companyAnnouncement.id))
			.limit(1);
		const wait = last ? last.createdAt.getTime() + ANNOUNCE_COOLDOWN_MS - Date.now() : 0;
		if (wait > 0) throw error(400, `You can post again in ${Math.ceil(wait / 3_600_000)}h`);

		if (claim) {
			const [pending] = await tx
				.select({ id: companyAnnouncement.id })
				.from(companyAnnouncement)
				.where(
					and(
						eq(companyAnnouncement.companyId, c.id),
						isNotNull(companyAnnouncement.claim),
						isNull(companyAnnouncement.claimResult)
					)
				)
				.limit(1);
			if (pending) throw error(400, 'You already made a promise for the next report');
			if (claim === 'REVENUE_UP') {
				const [report] = await tx
					.select({ quarter: companyEarnings.quarter })
					.from(companyEarnings)
					.where(eq(companyEarnings.companyId, c.id))
					.limit(1);
				if (!report) throw error(400, 'You need one report before promising more revenue');
			}
		}

		const [row] = await tx
			.insert(companyAnnouncement)
			.values({ companyId: c.id, authorId: userId, text, claim })
			.returning({
				id: companyAnnouncement.id,
				text: companyAnnouncement.text,
				claim: companyAnnouncement.claim,
				claimResult: companyAnnouncement.claimResult,
				createdAt: companyAnnouncement.createdAt
			});
		return row;
	});

	return json({ success: true, announcement });
}
