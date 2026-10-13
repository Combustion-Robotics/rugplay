<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import StockChart from '$lib/components/self/StockChart.svelte';
	import SignInConfirmDialog from '$lib/components/self/SignInConfirmDialog.svelte';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { Loading03Icon } from '@hugeicons/core-free-icons';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { USER_DATA } from '$lib/stores/user-data';
	import { PORTFOLIO_SUMMARY, fetchPortfolioSummary } from '$lib/stores/portfolio-data';
	import { haptic } from '$lib/stores/haptics';
	import { COMPANY_VESTING_MS, STOCK_MARKET_BAND, SWAP_FEE_RATE } from '$lib/data/constants';
	import {
		formatPrice,
		formatValue,
		formatQuantity,
		formatTimeAgo,
		formatTimeUntil
	} from '$lib/utils';

	const px = (p: number) => '$' + p.toFixed(6).replace(/\.?0+$/, '');

	type Level = { price: number; shares: number };
	type Market = {
		lastPrice: number;
		change24h: number;
		bids: Level[];
		asks: Level[];
		trades: {
			id: number;
			price: number;
			shares: number;
			takerSide: 'BUY' | 'SELL';
			createdAt: string;
		}[];
		chart: { time: number; value: number }[];
		me: null | {
			shares: number;
			sellable: number;
			lockedShares: number;
			orders: {
				id: number;
				side: 'BUY' | 'SELL';
				price: number;
				shares: number;
				createdAt: string;
			}[];
		};
	};

	let {
		company,
		onTrade
	}: {
		company: { symbol: string; sharePrice: number; roundEndsAt: string; founderId: number | null };
		onTrade?: () => void;
	} = $props();

	let market = $state<Market | null>(null);
	let side = $state<'BUY' | 'SELL'>('BUY');
	let type = $state<'LIMIT' | 'MARKET'>('LIMIT');
	let sharesInput = $state('');
	let priceInput = $state('');
	let submitting = $state(false);
	let shouldSignIn = $state(false);
	let cancelling = $state<number | null>(null);

	async function load() {
		try {
			const res = await fetch(`/api/companies/${company.symbol}/orders`);
			if (res.ok) market = await res.json();
		} catch (e) {
			console.error('Failed to load order book', e);
		}
	}

	onMount(() => {
		priceInput = String(company.sharePrice);
		load();
		const timer = setInterval(load, 15_000);
		return () => clearInterval(timer);
	});

	let last = $derived(market?.lastPrice ?? company.sharePrice);
	let balance = $derived($PORTFOLIO_SUMMARY?.baseCurrencyBalance ?? 0);
	let sellable = $derived(market?.me?.sellable ?? 0);
	let locked = $derived(market?.me?.lockedShares ?? 0);
	let bestAsk = $derived(market?.asks[0]?.price ?? 0);
	let bestBid = $derived(market?.bids[0]?.price ?? 0);

	let shares = $derived(Number(sharesInput));
	let price = $derived(type === 'LIMIT' ? Number(priceInput) : side === 'BUY' ? bestAsk : bestBid);
	let total = $derived(Number.isFinite(shares * price) ? shares * price : 0);
	let farFromLast = $derived(
		type === 'LIMIT' && price > 0 && Math.abs(price - last) / last > STOCK_MARKET_BAND
	);

	let error = $derived(
		sharesInput === ''
			? ''
			: !Number.isInteger(shares) || shares < 1
				? 'Enter a whole number of shares'
				: type === 'LIMIT' && !(price > 0)
					? 'Enter a price'
					: side === 'SELL' && shares > sellable
						? `You can sell up to ${sellable.toLocaleString()} shares`
						: side === 'BUY' && type === 'LIMIT' && total > balance
							? 'Not enough money'
							: ''
	);
	let canSubmit = $derived(sharesInput !== '' && !error && !submitting);

	function setMax() {
		const max =
			side === 'SELL'
				? sellable
				: type === 'LIMIT'
					? price > 0
						? Math.floor(balance / price)
						: 0
					: bestAsk > 0
						? Math.floor(balance / bestAsk)
						: 0;
		sharesInput = String(Math.max(0, max));
	}

	async function submit(event: { preventDefault: () => void }) {
		event.preventDefault();
		if (!canSubmit) return;

		submitting = true;
		try {
			const res = await fetch(`/api/companies/${company.symbol}/orders`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ side, type, shares, ...(type === 'LIMIT' ? { price } : {}) })
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.message || result.error || 'Order failed');

			const verb = side === 'BUY' ? 'Bought' : 'Sold';
			const filledText = `${verb} ${result.filled.toLocaleString()} shares for ${formatValue(result.total)}`;
			haptic.trigger('success');
			if (result.resting > 0) {
				toast.success(
					`Order placed: ${side === 'BUY' ? 'buy' : 'sell'} ${result.resting.toLocaleString()} at ${px(price)}`,
					{ description: result.filled > 0 ? filledText : undefined }
				);
			} else if (result.cancelled > 0) {
				toast.success(filledText, {
					description: `${result.cancelled.toLocaleString()} couldn't fill and were cancelled`
				});
			} else {
				toast.success(filledText);
			}
			sharesInput = '';
			await Promise.all([load(), fetchPortfolioSummary()]);
			onTrade?.();
		} catch (e) {
			haptic.trigger('error');
			toast.error('Order failed', { description: (e as Error).message });
		} finally {
			submitting = false;
		}
	}

	async function cancel(id: number) {
		cancelling = id;
		try {
			const res = await fetch(`/api/companies/${company.symbol}/orders/${id}`, {
				method: 'DELETE'
			});
			const result = await res.json();
			if (!res.ok) throw new Error(result.message || result.error || 'Failed to cancel');
			haptic.trigger('success');
			toast.success('Order cancelled');
		} catch (e) {
			haptic.trigger('error');
			toast.error('Failed to cancel', { description: (e as Error).message });
		}
		await Promise.all([load(), fetchPortfolioSummary()]);
		cancelling = null;
	}
</script>

<SignInConfirmDialog bind:open={shouldSignIn} />

<div class="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
	<Card.Root class="lg:col-span-2">
		<Card.Header>
			<Card.Title class="flex flex-wrap items-center gap-2">
				${formatPrice(last)}
				{#if market}
					<span
						class="text-sm font-medium {market.change24h >= 0
							? 'text-success'
							: 'text-destructive'}"
					>
						{market.change24h >= 0 ? '+' : ''}{market.change24h.toFixed(2)}% (24h)
					</span>
				{/if}
			</Card.Title>
		</Card.Header>
		<Card.Content>
			<StockChart data={market?.chart ?? []} />
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Trade</Card.Title>
		</Card.Header>
		<Card.Content>
			{#if !$USER_DATA}
				<Button class="w-full" onclick={() => (shouldSignIn = true)}>Sign in to trade</Button>
			{:else}
				<form onsubmit={submit} class="space-y-3">
					<div class="grid grid-cols-2 gap-2">
						{#each ['BUY', 'SELL'] as const as s (s)}
							<Button
								type="button"
								variant={side === s ? 'default' : 'outline'}
								aria-pressed={side === s}
								onclick={() => (side = s)}
							>
								{s === 'BUY' ? 'Buy' : 'Sell'}
							</Button>
						{/each}
					</div>
					<div class="grid grid-cols-2 gap-2">
						{#each ['LIMIT', 'MARKET'] as const as t (t)}
							<Button
								type="button"
								size="sm"
								variant={type === t ? 'default' : 'outline'}
								aria-pressed={type === t}
								onclick={() => (type = t)}
							>
								{t === 'LIMIT' ? 'Limit' : 'Market'}
							</Button>
						{/each}
					</div>
					<p class="text-muted-foreground text-xs">
						{type === 'LIMIT'
							? 'Pick your price. Your order waits until someone matches it.'
							: 'Trade now at the best price.'}
					</p>

					<div class="space-y-2">
						<Label for="stock-shares">Shares</Label>
						<div class="flex gap-2">
							<Input
								id="stock-shares"
								type="number"
								min="1"
								step="1"
								bind:value={sharesInput}
								placeholder="e.g., 100"
							/>
							<Button type="button" variant="outline" onclick={setMax}>Max</Button>
						</div>
					</div>
					{#if type === 'LIMIT'}
						<div class="space-y-2">
							<Label for="stock-price">Price per share</Label>
							<Input
								id="stock-price"
								type="number"
								min="0.000001"
								step="any"
								bind:value={priceInput}
							/>
						</div>
					{/if}

					{#if error}
						<p class="text-destructive text-xs">{error}</p>
					{:else}
						<p class="text-muted-foreground text-xs">
							{#if side === 'BUY' && type === 'LIMIT'}
								You pay up to {formatValue(total)}. The money is held until your order fills or you
								cancel.
							{:else if side === 'BUY'}
								Only fills up to {Math.round(STOCK_MARKET_BAND * 100)}% above ${formatPrice(last)}.
							{:else}
								You get about {formatValue(total * (1 - SWAP_FEE_RATE))} ({SWAP_FEE_RATE * 100}%
								fee).
							{/if}
						</p>
					{/if}
					{#if farFromLast}
						<p class="text-xs text-yellow-500">That's far from the current price.</p>
					{/if}
					{#if side === 'SELL'}
						<p class="text-muted-foreground text-xs">
							You can sell {sellable.toLocaleString()} shares.
						</p>
					{/if}
					{#if locked > 0}
						<p class="text-muted-foreground text-xs">
							{locked.toLocaleString()} founder shares are still locked. All unlock in {formatTimeUntil(
								new Date(company.roundEndsAt).getTime() + COMPANY_VESTING_MS
							)}.
						</p>
					{/if}

					<Button type="submit" class="w-full" disabled={!canSubmit}>
						{#if submitting}
							<HugeiconsIcon icon={Loading03Icon} class="h-4 w-4 animate-spin" />
							Placing...
						{:else}
							{side === 'BUY' ? 'Buy' : 'Sell'} shares
						{/if}
					</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Order book</Card.Title>
		</Card.Header>
		<Card.Content class="grid grid-cols-2 gap-4 text-sm">
			{#each [{ title: 'Buyers', rows: market?.bids ?? [], tone: 'text-success' }, { title: 'Sellers', rows: market?.asks ?? [], tone: 'text-destructive' }] as col (col.title)}
				<div class="space-y-1">
					<p class="text-muted-foreground text-xs font-medium">{col.title}</p>
					{#each col.rows as r (r.price)}
						<div class="flex justify-between gap-2 font-mono">
							<span class={col.tone}>{px(r.price)}</span>
							<span>{formatQuantity(r.shares)}</span>
						</div>
					{:else}
						<p class="text-muted-foreground text-xs">No orders yet</p>
					{/each}
				</div>
			{/each}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Recent trades</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-1 text-sm">
			{#each market?.trades ?? [] as t (t.id)}
				<div class="flex justify-between gap-2 font-mono">
					<span class="text-muted-foreground">{formatTimeAgo(t.createdAt)}</span>
					<span class={t.takerSide === 'BUY' ? 'text-success' : 'text-destructive'}>
						{formatPrice(t.price)}
					</span>
					<span>{formatQuantity(t.shares)}</span>
				</div>
			{:else}
				<p class="text-muted-foreground text-xs">No trades yet</p>
			{/each}
		</Card.Content>
	</Card.Root>

	{#if market?.me}
		<Card.Root>
			<Card.Header>
				<Card.Title>Your open orders</Card.Title>
			</Card.Header>
			<Card.Content class="space-y-2 text-sm">
				{#each market.me.orders as o (o.id)}
					<div class="flex items-center justify-between gap-2">
						<span class="flex items-center gap-2">
							<Badge
								variant="outline"
								class={o.side === 'BUY' ? 'text-success' : 'text-destructive'}
							>
								{o.side === 'BUY' ? 'Buy' : 'Sell'}
							</Badge>
							<span class="font-mono">{formatQuantity(o.shares)} at {px(o.price)}</span>
						</span>
						<Button
							variant="outline"
							size="sm"
							disabled={cancelling === o.id}
							onclick={() => cancel(o.id)}>Cancel</Button
						>
					</div>
				{:else}
					<p class="text-muted-foreground text-xs">No open orders</p>
				{/each}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
