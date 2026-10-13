<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { onMount } from 'svelte';
	import { formatPrice, formatTimeAgo } from '$lib/utils';

	type Who = 'RETAIL' | 'FUND' | 'TRADER';
	type Mood = { buy: number; sell: number; hold: number; reason: string; evaluatedAt: string };
	type Reason = {
		kind: 'EARNINGS' | 'NEWS' | 'FLOW' | 'MOOD' | 'TRADE';
		tone: 'up' | 'down' | 'neutral';
		text: string;
	};
	type Move = {
		from: string;
		to: string;
		priceBefore: number;
		priceAfter: number;
		change: number;
		reasons: Reason[];
	};
	type Insights = { mood: Partial<Record<Who, Mood>>; moves: Move[] };

	let { symbol, isPublic }: { symbol: string; isPublic: boolean } = $props();

	const WHO: { key: Who; label: string; sub: string }[] = [
		{ key: 'RETAIL', label: 'Everyday investors', sub: 'Follow hype and the chart' },
		{ key: 'FUND', label: 'Big funds', sub: 'Read the earnings' },
		{ key: 'TRADER', label: 'Fast traders', sub: 'Chase quick moves' }
	];
	const MARKERS = { up: '▲', down: '▼', neutral: '•' } as const;
	const MARKER_COLORS = {
		up: 'text-success',
		down: 'text-destructive',
		neutral: 'text-muted-foreground'
	} as const;

	let insights = $state<Insights | null>(null);
	let selectedTo = $state('');

	async function load() {
		try {
			const res = await fetch(`/api/companies/${symbol}/crowd`);
			if (res.ok) insights = await res.json();
		} catch (e) {
			console.error('Failed to load crowd insights', e);
		}
	}

	onMount(() => {
		load();
		const timer = setInterval(load, 60_000);
		return () => clearInterval(timer);
	});

	const pct = (x: number) => Math.round(x * 100);
	const verdict = (m: Mood) => {
		const p = m.buy - m.sell;
		return p > 0.1
			? { text: 'Buying', color: 'text-success' }
			: p < -0.1
				? { text: 'Selling', color: 'text-destructive' }
				: { text: 'Waiting', color: 'text-muted-foreground' };
	};
	const timeOf = (iso: string) =>
		new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

	let mood = $derived(insights?.mood ?? {});
	let hasMood = $derived(Object.keys(mood).length > 0);
	let newest = $derived(
		Object.values(mood).reduce<string>((a, m) => (m && m.evaluatedAt > a ? m.evaluatedAt : a), '')
	);
	let moves = $derived(insights?.moves ?? []);
	let move = $derived(moves.find((m) => m.to === selectedTo) ?? moves[0]);
</script>

<Card.Root>
	<Card.Header>
		<Card.Title>Crowd mood</Card.Title>
		<Card.Description class="text-xs">What the AI traders think right now.</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4">
		{#if hasMood}
			{#each WHO as w (w.key)}
				{@const m = mood[w.key]}
				<div class="space-y-1">
					<div class="flex items-start justify-between gap-2">
						<div>
							<p class="font-medium">{w.label}</p>
							<p class="text-muted-foreground text-xs">{w.sub}</p>
						</div>
						{#if m}
							{@const v = verdict(m)}
							<span class="text-sm font-semibold {v.color}">{v.text}</span>
						{/if}
					</div>
					{#if m}
						<div
							class="bg-muted flex h-2 overflow-hidden rounded-full"
							role="img"
							aria-label="{w.label}: buy {pct(m.buy)}%, wait {pct(m.hold)}%, sell {pct(m.sell)}%"
						>
							<div class="bg-success" style="width: {pct(m.buy)}%"></div>
							<div class="bg-muted-foreground/30" style="width: {pct(m.hold)}%"></div>
							<div class="bg-destructive" style="width: {pct(m.sell)}%"></div>
						</div>
						<p class="text-muted-foreground break-words text-xs">
							"{m.reason}" · Buy {pct(m.buy)}% · Wait {pct(m.hold)}% · Sell {pct(m.sell)}%
						</p>
					{:else}
						<p class="text-muted-foreground text-xs">
							{w.key === 'TRADER' && !isPublic
								? 'Waits until the stock goes public'
								: "Hasn't looked yet"}
						</p>
					{/if}
				</div>
			{/each}
			<p class="text-muted-foreground text-xs">Updated {formatTimeAgo(newest)}</p>
		{:else if insights}
			<p class="text-muted-foreground text-sm">The AI crowd hasn't looked at this company yet.</p>
		{:else}
			<p class="text-muted-foreground text-sm">Loading...</p>
		{/if}
	</Card.Content>
</Card.Root>

{#if isPublic}
	<Card.Root class="lg:col-span-3">
		<Card.Header>
			<Card.Title>Why did the price move?</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if move}
				<div class="flex flex-wrap gap-2">
					{#each moves as m (m.to)}
						<Button
							size="sm"
							variant={move === m ? 'default' : 'outline'}
							aria-pressed={move === m}
							onclick={() => (selectedTo = m.to)}
						>
							{m.change > 0 ? '+' : '-'}{Math.abs(Math.round(m.change * 100))}% at {timeOf(m.to)}
						</Button>
					{/each}
				</div>
				<p class="font-medium {move.change > 0 ? 'text-success' : 'text-destructive'}">
					The price went {move.change > 0 ? 'up' : 'down'}
					{Math.abs(Math.round(move.change * 100))}%: ${formatPrice(move.priceBefore)} → ${formatPrice(
						move.priceAfter
					)}
				</p>
				{#if move.reasons.length}
					<ul class="space-y-2 text-sm">
						{#each move.reasons as r, i (i)}
							<li class="flex gap-2">
								<span aria-hidden="true" class={MARKER_COLORS[r.tone]}>{MARKERS[r.tone]}</span>
								<span class="break-words">{r.text}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="text-muted-foreground text-sm">No clear reason. Sometimes prices just move.</p>
				{/if}
				<p class="text-muted-foreground text-xs">
					Built from trades, news and what the AI crowd was thinking at that time.
				</p>
			{:else if insights}
				<p class="text-sm">No big moves in the last 24 hours.</p>
				<p class="text-muted-foreground text-xs">
					A big move is when the price changes 10% or more within an hour.
				</p>
			{:else}
				<p class="text-muted-foreground text-sm">Loading...</p>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
