<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { Loading03Icon } from '@hugeicons/core-free-icons';
	import { toast } from 'svelte-sonner';
	import { haptic } from '$lib/stores/haptics';
	import { formatTimeAgo } from '$lib/utils';

	type Claim = 'PROFIT' | 'REVENUE_UP';
	type Announcement = {
		id: number;
		text: string;
		claim: Claim | null;
		claimResult: boolean | null;
		createdAt: string;
	};
	type Credibility = { score: number; kept: number; broken: number; pending: number };

	let {
		symbol,
		announcements,
		credibility,
		canPost,
		canPromiseRevenue,
		onPosted,
		class: className = ''
	}: {
		symbol: string;
		announcements: Announcement[];
		credibility: Credibility | null;
		canPost: boolean;
		canPromiseRevenue: boolean;
		onPosted?: () => void;
		class?: string;
	} = $props();

	const PROMISES: Record<Claim, string> = {
		PROFIT: 'a profit',
		REVENUE_UP: 'more revenue'
	};

	let text = $state('');
	let claim = $state<Claim | null>(null);
	let posting = $state(false);

	let trimmed = $derived(text.replace(/\s+/g, ' ').trim());
	let hasPending = $derived(announcements.some((a) => a.claim && a.claimResult === null));
	let canSubmit = $derived(trimmed.length >= 5 && trimmed.length <= 200 && !posting);
	let percent = $derived(credibility ? Math.round(credibility.score * 100) : 0);
	let trustColor = $derived(
		percent >= 75 ? 'text-success' : percent >= 50 ? 'text-yellow-500' : 'text-destructive'
	);

	async function post(event: { preventDefault: () => void }) {
		event.preventDefault();
		if (!canSubmit) return;

		posting = true;
		try {
			const res = await fetch(`/api/companies/${symbol}/announcements`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: trimmed, claim: hasPending ? null : claim })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.message || result.error || 'Try again');

			haptic.trigger('success');
			toast.success('Posted', { description: 'The AI crowd will react soon.' });
			text = '';
			claim = null;
			onPosted?.();
		} catch (e) {
			haptic.trigger('error');
			toast.error('Failed to post', { description: (e as Error).message });
		} finally {
			posting = false;
		}
	}
</script>

<Card.Root class={className}>
	<Card.Header class="flex flex-row items-start justify-between gap-4">
		<Card.Title>Founder news</Card.Title>
		<div class="text-right">
			{#if credibility}
				<p class="text-sm font-semibold {trustColor}">Trust {percent}%</p>
				<p class="text-muted-foreground text-xs">
					{credibility.kept + credibility.broken === 0
						? 'No promises checked yet'
						: `Kept ${credibility.kept} of ${credibility.kept + credibility.broken} promises`}
				</p>
			{:else}
				<p class="text-muted-foreground text-sm">Founder left</p>
			{/if}
		</div>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if canPost}
			<form onsubmit={post} class="space-y-2">
				<Label for="announce-text">Post news</Label>
				<Textarea
					id="announce-text"
					rows={2}
					maxlength={200}
					bind:value={text}
					placeholder="Tell investors what's new"
				/>
				<p class="text-muted-foreground text-xs">{trimmed.length}/200</p>

				<div class="flex flex-wrap gap-2">
					<Button
						type="button"
						size="sm"
						variant={claim === null ? 'default' : 'outline'}
						aria-pressed={claim === null}
						onclick={() => (claim = null)}
					>
						No promise
					</Button>
					<Button
						type="button"
						size="sm"
						variant={claim === 'PROFIT' ? 'default' : 'outline'}
						aria-pressed={claim === 'PROFIT'}
						disabled={hasPending}
						onclick={() => (claim = 'PROFIT')}
					>
						Profit next report
					</Button>
					<Button
						type="button"
						size="sm"
						variant={claim === 'REVENUE_UP' ? 'default' : 'outline'}
						aria-pressed={claim === 'REVENUE_UP'}
						disabled={hasPending || !canPromiseRevenue}
						onclick={() => (claim = 'REVENUE_UP')}
					>
						More revenue next report
					</Button>
				</div>
				{#if hasPending}
					<p class="text-muted-foreground text-xs">
						You have a promise waiting for the next report.
					</p>
				{/if}
				<p class="text-muted-foreground text-xs">
					Promises are checked at the next report. Broken promises lower your trust, and the crowd
					stops believing you.
				</p>

				<Button type="submit" disabled={!canSubmit}>
					{#if posting}
						<HugeiconsIcon icon={Loading03Icon} class="h-4 w-4 animate-spin" />
						Posting...
					{:else}
						Post
					{/if}
				</Button>
			</form>
		{/if}

		{#if announcements.length}
			<ul class="space-y-3">
				{#each announcements as a (a.id)}
					<li class="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
						<p class="text-muted-foreground text-xs">{formatTimeAgo(a.createdAt)}</p>
						<p class="break-words text-sm">{a.text}</p>
						{#if a.claim}
							{#if a.claimResult === true}
								<Badge variant="outline" class="text-success">Promise kept</Badge>
							{:else if a.claimResult === false}
								<Badge variant="destructive">Promise broken</Badge>
							{:else}
								<Badge variant="outline">Promise: {PROMISES[a.claim]} next report</Badge>
							{/if}
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-muted-foreground text-sm">No news yet.</p>
		{/if}
	</Card.Content>
</Card.Root>
