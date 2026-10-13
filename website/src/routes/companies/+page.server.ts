import { error } from '@sveltejs/kit';

export async function load({ fetch }) {
	const res = await fetch('/api/companies');
	if (!res.ok) throw error(500, 'Failed to load companies');
	return await res.json();
}
