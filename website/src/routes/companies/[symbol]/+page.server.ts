import { error } from '@sveltejs/kit';

export async function load({ params, fetch }) {
	const res = await fetch(`/api/companies/${params.symbol}`);
	if (res.status === 404) throw error(404, 'Company not found');
	if (!res.ok) throw error(500, 'Failed to load company');
	return await res.json();
}
