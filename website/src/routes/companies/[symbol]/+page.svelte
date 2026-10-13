<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import CoinIcon from '$lib/components/self/CoinIcon.svelte';
	import DataTable from '$lib/components/self/DataTable.svelte';
	import SEO from '$lib/components/self/SEO.svelte';
	import SignInConfirmDialog from '$lib/components/self/SignInConfirmDialog.svelte';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { Loading03Icon } from '@hugeicons/core-free-icons';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { USER_DATA } from '$lib/stores/user-data';
	import { PORTFOLIO_SUMMARY, fetchPortfolioSummary } from '$lib/stores/portfolio-data';
	import { haptic } from '$lib/stores/haptics';
	import { COMPANY_TOTAL_SHARES } from '$lib/data/constants';
	import {
		formatPrice,
		formatValue,
		formatMarketCap,
		formatQuantity,
		formatTimeUntil
	} from '$lib/utils';

	let { data } = $props();
	let company = $state(data.company);
	let holders = $state(data.holders);

	$effect(() => {
		company = data.company;
		holders = data.holders;
	});

	let sharesInput = $state('');
	let isInvesting = $state(false);
	let shouldSignIn = $state(false);

	onMount(() => {
		if ($USER_DATA) fetchPortfolioSummary();
	});

	// no invalidateAll: the layout caches for 30s
	async function refresh() {
		try {
			const res = await fetch(`/api/companies/${company.symbol}`);
			if (res.ok) {
				const result = await res.json();
				company = result.company;
				holders = result.holders;
			}
		} catch (e) {
			console.error('Failed to refresh company', e);
		}
	}

	let left = $derived(company.roundShares - company.roundSharesSold);
	let isOpen = $derived(
		company.status === 'PRIVATE' && new Date(company.roundEndsAt) > new Date() && left > 0
	);
	let isFounder = $derived($USER_DATA ? Number($USER_DATA.id) === company.founderId : false);
	let balance = $derived($PORTFOLIO_SUMMARY?.baseCurrencyBalance ?? 0);

	let shares = $derived(Number(sharesInput));
	let cost = $derived(shares * company.sharePrice);
	let sharesError = $derived(
		sharesInput === ''
			? ''
			: !Number.isInteger(shares) || shares < 1
				? 'Enter a whole number of shares'
				: shares > left
					? `Only ${left.toLocaleString()} shares left`
					: cost > balance
						? 'Not enough money'
						: ''
	);
	let canInvest = $derived(sharesInput !== '' && !sharesError && !isInvesting);

	function setMax() {
		sharesInput = String(Math.max(0, Math.min(left, Math.floor(balance / company.sharePrice))));
	}

	async function invest(event: { preventDefault: () => void }) {
		event.preventDefault();
		if (!canInvest) return;

		isInvesting = true;
		try {
			const res = await fetch(`/api/companies/${company.symbol}/invest`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ shares })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.message || result.error || 'Failed to invest');

			haptic.trigger('success');
			toast.success(`Bought ${result.sharesBought.toLocaleString()} shares`, {
				description: `You paid ${formatValue(result.totalCost)}`
			});
			sharesInput = '';
			await Promise.all([refresh(), fetchPortfolioSummary()]);
		} catch (e) {
			haptic.trigger('error');
			toast.error('Failed to invest', { description: (e as Error).message });
		} finally {
			isInvesting = false;
		}
	}

	const holderColumns = [
		{
			key: 'user',
			label: 'User',
			class: 'w-[45%] min-w-[150px]',
			sortable: false,
			render: (_: any, row: any) => ({
				component: 'user',
				image: row.image,
				name: row.name || 'Anonymous',
				username: row.username,
				nameColor: row.nameColor
			})
		},
		{
			key: 'shares',
			label: 'Shares',
			class: 'w-[30%] min-w-[100px] font-mono',
			defaultSort: 'desc' as const,
			render: (value: number) => formatQuantity(value)
		},
		{
			key: 'percentage',
			label: '%',
			class: 'w-[25%] min-w-[70px]',
			sortable: false,
			render: (value: number) => ({
				component: 'badge',
				variant: 'secondary',
				text: `${value.toFixed(1)}%`
			})
		}
	];
</script>

<SEO
	title="{company.name} - Companies - Rugplay"
	description="Invest in {company.name} ({company.symbol}) on Rugplay."
/>

<SignInConfirmDialog bind:open={shouldSignIn} />

<div class="container mx-auto max-w-7xl px-4 py-6">
	<div class="mb-6 flex flex-wrap items-center gap-3">
		<CoinIcon icon={null} symbol={company.symbol} size={10} />
		<div>
			<h1 class="text-2xl font-bold leading-tight">{company.name}</h1>
			<p class="text-muted-foreground text-sm">
				{company.symbol} · by
				{#if company.founderUsername}
					<a href="/user/{company.founderUsername}" class="text-primary hover:underline">
						@{company.founderUsername}
					</a>
				{:else}
					deleted user
				{/if}
			</p>
		</div>
		<Badge variant="secondary">{company.sector}</Badge>
		<Badge variant="outline">{company.status}</Badge>
	</div>

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<Card.Root class="lg:col-span-2">
			<Card.Header>
				<Card.Title>Pitch</Card.Title>
			</Card.Header>
			<Card.Content>
				<p class="whitespace-pre-line break-words">{company.pitch}</p>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Funding round</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div class="space-y-2 text-sm">
					<div class="flex justify-between">
						<span class="text-muted-foreground">Price / share</span>
						<span class="font-mono">${formatPrice(company.sharePrice)}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-muted-foreground">Valuation</span>
						<span class="font-mono">
							{formatMarketCap(company.sharePrice * COMPANY_TOTAL_SHARES)}
						</span>
					</div>
					<div class="flex justify-between">
						<span class="text-muted-foreground">Raised</span>
						<span class="font-mono">{formatValue(company.treasuryCash)}</span>
					</div>
				</div>

				<div class="space-y-1">
					<Progress value={(company.roundSharesSold / company.roundShares) * 100} />
					<div class="text-muted-foreground flex justify-between text-xs">
						<span>
							{company.roundSharesSold.toLocaleString()} / {company.roundShares.toLocaleString()} shares
						</span>
						<span
							>{isOpen ? `Ends in ${formatTimeUntil(company.roundEndsAt)}` : 'Round closed'}</span
						>
					</div>
				</div>

				{#if isOpen}
					{#if !$USER_DATA}
						<Button class="w-full" onclick={() => (shouldSignIn = true)}>Sign in to invest</Button>
					{:else if isFounder}
						<p class="text-muted-foreground text-center text-sm">This is your company</p>
					{:else}
						<form onsubmit={invest} class="space-y-2">
							<Label for="shares">Shares to buy</Label>
							<div class="flex gap-2">
								<Input
									id="shares"
									type="number"
									min="1"
									step="1"
									max={left}
									bind:value={sharesInput}
									placeholder="e.g., 1000"
								/>
								<Button type="button" variant="outline" onclick={setMax}>Max</Button>
							</div>
							{#if sharesError}
								<p class="text-destructive text-xs">{sharesError}</p>
							{:else}
								<p class="text-muted-foreground text-xs">
									Cost: {formatValue(Number.isFinite(cost) ? cost : 0)} · You have {formatValue(
										balance
									)}
								</p>
							{/if}
							<Button type="submit" class="w-full" disabled={!canInvest}>
								{#if isInvesting}
									<HugeiconsIcon icon={Loading03Icon} class="h-4 w-4 animate-spin" />
									Investing...
								{:else}
									Invest
								{/if}
							</Button>
							<p class="text-muted-foreground text-xs">
								Invested money is locked until the company goes public and doesn't count in your
								score.
							</p>
						</form>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="lg:col-span-3">
			<Card.Header>
				<Card.Title>Shareholders</Card.Title>
			</Card.Header>
			<Card.Content>
				<DataTable
					columns={holderColumns}
					data={holders}
					onRowClick={(h) => goto(`/user/${h.username}`)}
					enableUserPreview={true}
					emptyTitle="No shareholders"
					emptyDescription="Nobody owns shares yet."
				/>
			</Card.Content>
		</Card.Root>
	</div>
</div>
