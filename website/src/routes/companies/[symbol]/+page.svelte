<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import * as Alert from '$lib/components/ui/alert';
	import CoinIcon from '$lib/components/self/CoinIcon.svelte';
	import DataTable from '$lib/components/self/DataTable.svelte';
	import SEO from '$lib/components/self/SEO.svelte';
	import SignInConfirmDialog from '$lib/components/self/SignInConfirmDialog.svelte';
	import StockMarket from '$lib/components/self/StockMarket.svelte';
	import CompanyAnnouncements from '$lib/components/self/CompanyAnnouncements.svelte';
	import CrowdInsights from '$lib/components/self/CrowdInsights.svelte';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { Loading03Icon } from '@hugeicons/core-free-icons';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { USER_DATA } from '$lib/stores/user-data';
	import { PORTFOLIO_SUMMARY, fetchPortfolioSummary } from '$lib/stores/portfolio-data';
	import { haptic } from '$lib/stores/haptics';
	import { COMPANY_TOTAL_SHARES, COMPANY_SPENDING, COMPANY_QUARTER_MS } from '$lib/data/constants';
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
	let reports = $state(data.reports);
	let sectorMultiplier = $state(data.sectorMultiplier);
	let announcements = $state(data.announcements);
	let founderCredibility = $state(data.founderCredibility);

	$effect(() => {
		company = data.company;
		holders = data.holders;
		reports = data.reports;
		sectorMultiplier = data.sectorMultiplier;
		announcements = data.announcements;
		founderCredibility = data.founderCredibility;
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
				reports = result.reports;
				sectorMultiplier = result.sectorMultiplier;
				announcements = result.announcements;
				founderCredibility = result.founderCredibility;
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
	let isBankrupt = $derived(company.status === 'BANKRUPT');
	let roundEnded = $derived(new Date(company.roundEndsAt) <= new Date());
	let raised = $derived(company.raisedCash);
	const budget = (l: keyof typeof COMPANY_SPENDING) => raised * COMPANY_SPENDING[l].rate;
	const money = (v: number) => (v < 0 ? '-' : '') + formatValue(Math.abs(v));
	const sign = (v: number) => (v >= 0 ? '+' : '') + money(v);
	const tone = (v: number) => (v > 0 ? 'text-success' : v < 0 ? 'text-destructive' : '');
	const LEVELS = {
		LOW: { label: 'Low', hint: 'Safe. Small gains.' },
		MEDIUM: { label: 'Medium', hint: 'Balanced.' },
		HIGH: { label: 'High', hint: 'Win big or burn cash.' }
	} as const;
	type Level = keyof typeof LEVELS;
	let level = $derived(company.spendingLevel as Level);
	let isSaving = $state(false);

	async function setSpending(next: Level) {
		if (isSaving || next === level) return;
		isSaving = true;
		try {
			const res = await fetch(`/api/companies/${company.symbol}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ spendingLevel: next })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.message || result.error || 'Failed to save');
			company.spendingLevel = next;
			haptic.trigger('success');
			toast.success('Spending updated', { description: 'Applies at the next report.' });
		} catch (e) {
			haptic.trigger('error');
			toast.error('Failed to update spending', { description: (e as Error).message });
		} finally {
			isSaving = false;
		}
	}

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

	const reportColumns = [
		{ key: 'quarter', label: 'Quarter', render: (v: number) => `Q${v}` },
		{
			key: 'spendingLevel',
			label: 'Spending',
			render: (v: Level) => ({ component: 'badge', variant: 'secondary', text: LEVELS[v].label })
		},
		{ key: 'sectorMultiplier', label: 'Sector', render: (v: number) => `×${v.toFixed(2)}` },
		{ key: 'revenue', label: 'Revenue', class: 'font-mono', render: money },
		{ key: 'spending', label: 'Spent', class: 'font-mono', render: money },
		{
			key: 'profit',
			label: 'Profit',
			class: 'font-mono',
			render: (v: number) => ({ component: 'text', text: sign(v), class: tone(v) })
		},
		{ key: 'cashAfter', label: 'Cash', class: 'font-mono', render: money }
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
		{#if isBankrupt}
			<Badge variant="destructive">Bankrupt</Badge>
		{:else}
			<Badge variant="outline">{company.status}</Badge>
		{/if}
	</div>

	{#if isBankrupt}
		<Alert.Root variant="destructive" class="mb-6">
			<Alert.Title>Bankrupt</Alert.Title>
			<Alert.Description>This company ran out of cash. Its shares are worth $0.</Alert.Description>
		</Alert.Root>
	{/if}

	{#if company.status === 'PUBLIC'}
		<StockMarket {company} onTrade={refresh} />
	{/if}

	<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
		<CompanyAnnouncements
			symbol={company.symbol}
			{announcements}
			credibility={founderCredibility}
			canPost={isFounder && !isBankrupt}
			canPromiseRevenue={reports.length > 0}
			onPosted={refresh}
			class={isBankrupt ? 'lg:col-span-3' : 'lg:col-span-2'}
		/>
		{#if !isBankrupt}
			<CrowdInsights symbol={company.symbol} isPublic={company.status === 'PUBLIC'} />
		{/if}

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
						<span class="text-muted-foreground">
							{company.status === 'PUBLIC' ? 'Market cap' : 'Valuation'}
						</span>
						<span class="font-mono">
							{formatMarketCap(company.sharePrice * COMPANY_TOTAL_SHARES)}
						</span>
					</div>
					<div class="flex justify-between">
						<span class="text-muted-foreground">Raised</span>
						<span class="font-mono">{formatValue(raised)}</span>
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

				{#if company.status === 'PRIVATE' && roundEnded && company.roundSharesSold > 0}
					<p class="text-muted-foreground text-center text-sm">
						Going public soon. Trading opens within 5 minutes.
					</p>
				{/if}

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
								You can sell your shares once the company goes public.
							</p>
						</form>
					{/if}
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root class="lg:col-span-2">
			<Card.Header>
				<Card.Title>Earnings</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-4">
				{#if reports.length}
					<p class="text-sm">
						<span class="font-semibold">Q{reports[0].quarter} report:</span>
						Revenue {money(reports[0].revenue)} · Spending {money(reports[0].spending)} · Profit
						<span class={tone(reports[0].profit)}>{sign(reports[0].profit)}</span>
					</p>
				{/if}
				<DataTable
					columns={reportColumns}
					data={reports}
					emptyTitle="No reports yet"
					emptyDescription="The first report comes one quarter after the round ends."
				/>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Business</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-4">
				<p class="text-muted-foreground text-xs">
					Every {COMPANY_QUARTER_MS / 3_600_000}h your company spends cash and earns revenue.
				</p>
				<div class="space-y-2 text-sm">
					<div class="flex justify-between">
						<span class="text-muted-foreground">Cash</span>
						<span class="font-mono">{money(company.treasuryCash)}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-muted-foreground">Sector</span>
						<span class="font-mono {tone(sectorMultiplier - 1)}">
							{company.sector} ×{sectorMultiplier.toFixed(2)}
						</span>
					</div>
					<div class="flex justify-between">
						<span class="text-muted-foreground">Spending</span>
						<span>{LEVELS[level].label}</span>
					</div>
					<div class="flex justify-between">
						<span class="text-muted-foreground">Next report</span>
						<span>
							{isBankrupt
								? '—'
								: !roundEnded
									? 'When the round ends'
									: `in ${formatTimeUntil(company.nextQuarterAt)}`}
						</span>
					</div>
				</div>

				{#if isFounder && !isBankrupt}
					<div class="grid grid-cols-3 gap-2">
						{#each Object.keys(LEVELS) as Level[] as l (l)}
							<Button
								variant={level === l ? 'default' : 'outline'}
								disabled={isSaving}
								aria-pressed={level === l}
								onclick={() => setSpending(l)}
							>
								{LEVELS[l].label}
							</Button>
						{/each}
					</div>
					<p class="text-muted-foreground text-xs">
						{LEVELS[level].hint} Spends {formatValue(budget(level))} per quarter.
					</p>
					{#if roundEnded && company.treasuryCash < budget(level)}
						<p class="text-destructive text-xs">
							Not enough cash for this level. If cash hits $0 you go bankrupt.
						</p>
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
