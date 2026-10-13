<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import CoinIcon from '$lib/components/self/CoinIcon.svelte';
	import SEO from '$lib/components/self/SEO.svelte';
	import { goto } from '$app/navigation';
	import { COMPANY_TOTAL_SHARES } from '$lib/data/constants';
	import { formatPrice, formatMarketCap, formatTimeUntil } from '$lib/utils';

	let { data } = $props();

	const isOpen = (c: (typeof data.companies)[number]) =>
		c.status === 'PRIVATE' &&
		new Date(c.roundEndsAt) > new Date() &&
		c.roundSharesSold < c.roundShares;
</script>

<SEO
	title="Companies - Rugplay"
	description="Found a startup or invest in other players' companies in Rugplay."
/>

<div class="container mx-auto max-w-7xl px-4 py-6">
	<div class="mb-6 flex items-center justify-between gap-4">
		<h1 class="text-2xl font-bold">Companies</h1>
		<Button href="/companies/create">Found a company</Button>
	</div>

	{#if data.companies.length === 0}
		<div class="text-muted-foreground py-24 text-center">
			No companies yet.
			<a href="/companies/create" class="text-primary underline">Found the first one!</a>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{#each data.companies as c (c.symbol)}
				<Card.Root
					class="group cursor-pointer gap-1 transition-all duration-200 hover:shadow-lg"
					onclick={() => goto(`/companies/${c.symbol}`)}
				>
					<Card.Header>
						<div class="flex min-w-0 items-start justify-between gap-2">
							<div class="flex min-w-0 items-center gap-3">
								<CoinIcon icon={null} symbol={c.symbol} size={8} />
								<div class="min-w-0">
									<h3 class="text-lg break-words font-semibold leading-tight">{c.name}</h3>
									<p class="text-muted-foreground truncate text-sm">{c.symbol}</p>
								</div>
							</div>
							<Badge variant="secondary" class="shrink-0 text-xs">{c.sector}</Badge>
						</div>
					</Card.Header>

					<Card.Content>
						<div class="space-y-3 text-sm">
							<div class="flex justify-between">
								<span class="text-muted-foreground">Price / share</span>
								<span class="font-mono">${formatPrice(c.sharePrice)}</span>
							</div>
							<div class="flex justify-between">
								<span class="text-muted-foreground">Valuation</span>
								<span class="font-mono">{formatMarketCap(c.sharePrice * COMPANY_TOTAL_SHARES)}</span
								>
							</div>
							<div class="space-y-1">
								<Progress value={(c.roundSharesSold / c.roundShares) * 100} />
								<div class="text-muted-foreground flex justify-between text-xs">
									<span>{Math.floor((c.roundSharesSold / c.roundShares) * 100)}% funded</span>
									<span>
										{isOpen(c) ? `Ends in ${formatTimeUntil(c.roundEndsAt)}` : 'Round closed'}
									</span>
								</div>
							</div>
						</div>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>
