<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Card, CardContent, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Separator } from '$lib/components/ui/separator';
	import { HugeiconsIcon } from '@hugeicons/svelte';
	import { InformationCircleIcon, Loading03Icon, Building03Icon } from '@hugeicons/core-free-icons';
	import { PORTFOLIO_SUMMARY, fetchPortfolioSummary } from '$lib/stores/portfolio-data';
	import { onMount } from 'svelte';
	import {
		COMPANY_CREATION_FEE,
		COMPANY_TOTAL_SHARES,
		COMPANY_MIN_VALUATION,
		COMPANY_MAX_VALUATION,
		COMPANY_MIN_OFFER_PERCENT,
		COMPANY_MAX_OFFER_PERCENT,
		COMPANY_ROUND_DURATION_MS,
		COMPANY_SECTORS
	} from '$lib/data/constants';
	import { formatValue, formatPrice } from '$lib/utils';
	import { toast } from 'svelte-sonner';
	import SEO from '$lib/components/self/SEO.svelte';
	import SignInConfirmDialog from '$lib/components/self/SignInConfirmDialog.svelte';
	import { haptic } from '$lib/stores/haptics';

	let name = $state('');
	let symbol = $state('');
	let sector = $state<string>('');
	let pitch = $state('');
	let valuationInput = $state('');
	let offerInput = $state('10');
	let isSubmitting = $state(false);
	let shouldSignIn = $state(false);

	onMount(() => {
		fetchPortfolioSummary();
	});

	let valuation = $derived(Number(valuationInput));
	let offerPercent = $derived(Number(offerInput));
	let validNumbers = $derived(
		Number.isInteger(valuation) &&
			valuation >= COMPANY_MIN_VALUATION &&
			valuation <= COMPANY_MAX_VALUATION &&
			Number.isInteger(offerPercent) &&
			offerPercent >= COMPANY_MIN_OFFER_PERCENT &&
			offerPercent <= COMPANY_MAX_OFFER_PERCENT
	);

	let nameError = $derived(
		name.length > 0 && !/^[a-zA-Z0-9]+( [a-zA-Z0-9]+)*$/.test(name.trim())
			? 'Use letters, numbers and single spaces'
			: name.length > 0 && (name.trim().length < 2 || name.trim().length > 40)
				? 'Name must be 2-40 characters'
				: ''
	);
	let symbolError = $derived(
		symbol.length > 0 && !/^[A-Za-z]{2,5}$/.test(symbol.trim()) ? 'Ticker must be 2-5 letters' : ''
	);
	let pitchError = $derived(
		pitch.length > 0 && (pitch.trim().length < 20 || pitch.trim().length > 1000)
			? 'Pitch must be 20-1000 characters'
			: ''
	);
	let valuationError = $derived(
		valuationInput !== '' &&
			(!Number.isInteger(valuation) ||
				valuation < COMPANY_MIN_VALUATION ||
				valuation > COMPANY_MAX_VALUATION)
			? `Pick a whole number from ${formatValue(COMPANY_MIN_VALUATION)} to ${formatValue(COMPANY_MAX_VALUATION)}`
			: ''
	);
	let offerError = $derived(
		offerInput !== '' &&
			(!Number.isInteger(offerPercent) ||
				offerPercent < COMPANY_MIN_OFFER_PERCENT ||
				offerPercent > COMPANY_MAX_OFFER_PERCENT)
			? `Pick a whole number from ${COMPANY_MIN_OFFER_PERCENT} to ${COMPANY_MAX_OFFER_PERCENT}`
			: ''
	);

	let isFormValid = $derived(
		name.trim().length >= 2 &&
			symbol.trim().length >= 2 &&
			sector !== '' &&
			pitch.trim().length >= 20 &&
			validNumbers &&
			!nameError &&
			!symbolError &&
			!pitchError
	);
	let hasEnoughFunds = $derived(
		$PORTFOLIO_SUMMARY ? $PORTFOLIO_SUMMARY.baseCurrencyBalance >= COMPANY_CREATION_FEE : false
	);
	let canSubmit = $derived(isFormValid && hasEnoughFunds && !isSubmitting);

	let sharePrice = $derived(validNumbers ? valuation / COMPANY_TOTAL_SHARES : 0);
	let roundShares = $derived(validNumbers ? (COMPANY_TOTAL_SHARES * offerPercent) / 100 : 0);
	let raising = $derived(validNumbers ? (valuation * offerPercent) / 100 : 0);
	let roundDays = COMPANY_ROUND_DURATION_MS / (24 * 60 * 60 * 1000);

	async function handleSubmit(event: { preventDefault: () => void }) {
		event.preventDefault();
		if (!canSubmit) return;

		isSubmitting = true;
		try {
			const response = await fetch('/api/companies', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					symbol,
					sector,
					pitch,
					valuation: Number(valuationInput),
					offerPercent: Number(offerInput)
				})
			});
			const result = await response.json();
			if (!response.ok)
				throw new Error(result.message || result.error || 'Failed to create company');

			await fetchPortfolioSummary();
			haptic.trigger('success');
			goto(`/companies/${result.company.symbol}`);
		} catch (e) {
			haptic.trigger('error');
			toast.error('Failed to create company', { description: (e as Error).message });
		} finally {
			isSubmitting = false;
		}
	}
</script>

<SEO
	title="Found a Company - Rugplay"
	description="Start your own company in Rugplay and raise money from other players."
/>

<SignInConfirmDialog bind:open={shouldSignIn} />

<div class="container mx-auto max-w-5xl px-4 py-6">
	{#if !$PORTFOLIO_SUMMARY}
		<div class="flex h-96 items-center justify-center">
			<div class="text-center">
				<div class="text-muted-foreground mb-4 text-xl">Sign in to found a company</div>
				<p class="text-muted-foreground mb-4 text-sm">You need an account to start a company.</p>
				<Button onclick={() => (shouldSignIn = true)} class="w-fit">Sign in to continue</Button>
			</div>
		</div>
	{:else}
		<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
			<div class="lg:col-span-2">
				<Card>
					<CardHeader>
						<CardTitle class="text-lg">Company Details</CardTitle>
					</CardHeader>
					<CardContent>
						<form onsubmit={handleSubmit} class="space-y-6">
							<div class="space-y-2">
								<Label for="name">Company Name</Label>
								<Input
									id="name"
									type="text"
									bind:value={name}
									placeholder="e.g., Pixel Pizza"
									required
								/>
								{#if nameError}
									<p class="text-destructive text-xs">{nameError}</p>
								{/if}
							</div>

							<div class="space-y-2">
								<Label for="symbol">Ticker</Label>
								<Input
									id="symbol"
									type="text"
									bind:value={symbol}
									placeholder="PIZZA"
									class="uppercase"
									maxlength={5}
									required
								/>
								{#if symbolError}
									<p class="text-destructive text-xs">{symbolError}</p>
								{:else}
									<p class="text-muted-foreground text-sm">2-5 letters</p>
								{/if}
							</div>

							<div class="space-y-2">
								<Label>Sector</Label>
								<Select.Root type="single" bind:value={sector}>
									<Select.Trigger class="w-full">
										{sector || 'Pick a sector'}
									</Select.Trigger>
									<Select.Content>
										<Select.Group>
											{#each COMPANY_SECTORS as s}
												<Select.Item value={s} label={s}>{s}</Select.Item>
											{/each}
										</Select.Group>
									</Select.Content>
								</Select.Root>
							</div>

							<div class="space-y-2">
								<Label for="pitch">Pitch</Label>
								<Textarea
									id="pitch"
									bind:value={pitch}
									placeholder="Tell investors why they should back you"
									rows={5}
									maxlength={1000}
									required
								/>
								<div class="flex justify-between text-xs">
									<span class="text-destructive">{pitchError}</span>
									<span class="text-muted-foreground">{pitch.length}/1000</span>
								</div>
							</div>

							<div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
								<div class="space-y-2">
									<Label for="valuation">Company value ($)</Label>
									<Input
										id="valuation"
										type="number"
										min={COMPANY_MIN_VALUATION}
										max={COMPANY_MAX_VALUATION}
										step="1"
										bind:value={valuationInput}
										placeholder="100000"
										required
									/>
									{#if valuationError}
										<p class="text-destructive text-xs">{valuationError}</p>
									{:else}
										<p class="text-muted-foreground text-sm">
											{formatValue(COMPANY_MIN_VALUATION)} to {formatValue(COMPANY_MAX_VALUATION)}
										</p>
									{/if}
								</div>
								<div class="space-y-2">
									<Label for="offer">Shares for sale (%)</Label>
									<Input
										id="offer"
										type="number"
										min={COMPANY_MIN_OFFER_PERCENT}
										max={COMPANY_MAX_OFFER_PERCENT}
										step="1"
										bind:value={offerInput}
										required
									/>
									{#if offerError}
										<p class="text-destructive text-xs">{offerError}</p>
									{:else}
										<p class="text-muted-foreground text-sm">
											{COMPANY_MIN_OFFER_PERCENT} to {COMPANY_MAX_OFFER_PERCENT}
										</p>
									{/if}
								</div>
							</div>

							<Alert variant="default" class="bg-muted/50">
								<HugeiconsIcon icon={InformationCircleIcon} class="h-4 w-4" />
								<AlertDescription class="text-muted-foreground text-sm">
									Other players can buy the shares you put up for sale. Their money goes to your
									company. Shares nobody buys are never created.
								</AlertDescription>
							</Alert>

							{#if !hasEnoughFunds}
								<p class="text-destructive text-sm">
									You need {formatValue(COMPANY_CREATION_FEE)} to found a company.
								</p>
							{/if}

							<Button type="submit" disabled={!canSubmit} class="w-full" size="lg">
								{#if isSubmitting}
									<HugeiconsIcon icon={Loading03Icon} class="h-4 w-4 animate-spin" />
									Creating...
								{:else}
									<HugeiconsIcon icon={Building03Icon} class="h-4 w-4" />
									Found Company ({formatValue(COMPANY_CREATION_FEE)})
								{/if}
							</Button>
						</form>
					</CardContent>
				</Card>
			</div>

			<div class="space-y-4">
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-base">Summary</CardTitle>
					</CardHeader>
					<CardContent class="space-y-2">
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Creation fee</span>
							<span>{formatValue(COMPANY_CREATION_FEE)}</span>
						</div>
						<Separator class="my-2" />
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Price / share</span>
							<span>{validNumbers ? `$${formatPrice(sharePrice)}` : '-'}</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Shares for sale</span>
							<span>{validNumbers ? roundShares.toLocaleString() : '-'}</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">Raising up to</span>
							<span class="text-primary">{validNumbers ? formatValue(raising) : '-'}</span>
						</div>
						<div class="flex justify-between text-sm">
							<span class="text-muted-foreground">You keep</span>
							<span>{validNumbers ? `${100 - offerPercent}%` : '-'}</span>
						</div>
						<p class="text-muted-foreground pt-2 text-xs">
							Round lasts {roundDays} days. The fee is not refunded.
						</p>
					</CardContent>
				</Card>
			</div>
		</div>
	{/if}
</div>
