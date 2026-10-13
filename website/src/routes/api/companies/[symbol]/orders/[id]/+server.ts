import { auth } from '$lib/auth';
import { error, json } from '@sveltejs/kit';
import { cancelOrder } from '$lib/server/orderbook';

export async function DELETE({ params, request }) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647) throw error(404, 'Order not found');

	return json({ success: true, ...(await cancelOrder(Number(session.user.id), id)) });
}
