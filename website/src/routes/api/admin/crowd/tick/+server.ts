import { error, json } from '@sveltejs/kit';
import { auth } from '$lib/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { runCrowd } from '$lib/server/crowd';

async function requireAdmin(request: Request) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) throw error(403, 'Admin access required');

	const [currentUser] = await db
		.select({ isAdmin: user.isAdmin })
		.from(user)
		.where(eq(user.id, Number(session.user.id)))
		.limit(1);
	if (!currentUser?.isAdmin) throw error(403, 'Admin access required');
}

export const POST: RequestHandler = async ({ request }) => {
	await requireAdmin(request);
	const body = await request.json().catch(() => null);
	return json({ success: true, result: await runCrowd(body?.force === true) });
};
