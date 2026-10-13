<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import * as Card from '$lib/components/ui/card';
	import * as Table from '$lib/components/ui/table';
	import { USER_DATA } from '$lib/stores/user-data';
	import { toast } from 'svelte-sonner';

	type Bot = {
		archetype: string;
		username: string;
		cash: number;
		orderCash: number;
		stockValue: number;
		coinValue: number;
	};
	type Decision = {
		id: number;
		market: string;
		symbol: string;
		archetype: string;
		source: string;
		buy: number;
		sell: number;
		hold: number;
		createdAt: string;
	};

	let enabled = $state(true);
	let coinsEnabled = $state(false);
	let coinPool = $state(100000);
	let llm = $state<{ configured: boolean; model: string } | null>(null);
	let bots = $state<Bot[]>([]);
	let lastHour = $state({ llm: 0, heuristic: 0 });
	let recent = $state<Decision[]>([]);
	let loading = $state(false);
	let saving = $state(false);
	let ticking = $state(false);
	let loaded = false;

	const money = (n: number) =>
		'$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const pct = (n: number) => Math.round(n * 100) + '%';

	async function api(method: string, path = '', body?: object) {
		const response = await fetch('/api/admin/crowd' + path, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body && JSON.stringify(body)
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.message ?? 'Request failed');
		return data;
	}

	async function load() {
		loading = true;
		try {
			const data = await api('GET');
			({ enabled, coinsEnabled, coinPool } = data.settings);
			({ llm, bots, lastHour, recent } = data);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to load');
		} finally {
			loading = false;
		}
	}

	async function save() {
		saving = true;
		try {
			await api('PUT', '', { enabled, coinsEnabled, coinPool });
			toast.success('Saved');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Failed to save');
		} finally {
			saving = false;
		}
	}

	async function tick(force: boolean) {
		ticking = true;
		try {
			const { result } = await api('POST', '/tick', { force });
			if (result.skipped) toast.info('A tick is already running');
			else
				toast.success(
					`${result.assets} markets, ${result.stockOrders} orders, ${result.invests} invests, ${result.coinTrades} coin trades, ${result.errors} errors`
				);
			await load();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Tick failed');
		} finally {
			ticking = false;
		}
	}

	$effect(() => {
		if ($USER_DATA?.isAdmin && !loaded) {
			loaded = true;
			load();
		}
	});
</script>

<svelte:head>
	<title>AI crowd - Admin | Rugplay</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if !$USER_DATA || !$USER_DATA.isAdmin}
	<div class="flex h-screen items-center justify-center">
		<div class="text-center">
			<h1 class="text-2xl font-bold">Access Denied</h1>
			<p class="text-muted-foreground">You don't have permission to access this page.</p>
		</div>
	</div>
{:else}
	<div class="container mx-auto max-w-3xl space-y-4 p-4">
		<div>
			<h1 class="text-2xl font-bold">AI crowd</h1>
			<p class="text-muted-foreground text-sm">Bots that trade stocks and coins.</p>
		</div>

		<Card.Root>
			<Card.Header>
				<Card.Title>Settings</Card.Title>
				<Card.Description>
					{#if !llm}
						Loading…
					{:else if llm.configured}
						Model: {llm.model}. Last hour: {lastHour.llm} AI, {lastHour.heuristic} rules.
					{:else}
						No model set (CROWD_LLM_URL). Using rules only. Last hour: {lastHour.heuristic} rules.
					{/if}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					class="space-y-4"
					onsubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<div class="flex items-center justify-between">
						<Label for="crowd-enabled">Crowd on</Label>
						<Switch id="crowd-enabled" bind:checked={enabled} disabled={loading || saving} />
					</div>
					<div class="flex items-center justify-between">
						<Label for="crowd-coins">Trade coins</Label>
						<Switch id="crowd-coins" bind:checked={coinsEnabled} disabled={loading || saving} />
					</div>
					<div class="space-y-2">
						<Label for="crowd-pool">Coin pool ($)</Label>
						<Input
							id="crowd-pool"
							type="number"
							min={0}
							max={1000000000}
							step="any"
							bind:value={coinPool}
							disabled={loading || saving}
						/>
					</div>
					<div class="flex flex-wrap gap-2">
						<Button type="submit" disabled={loading || saving}>
							{saving ? 'Saving…' : 'Save'}
						</Button>
						<Button type="button" variant="outline" disabled={ticking} onclick={() => tick(false)}>
							Run tick
						</Button>
						<Button type="button" variant="outline" disabled={ticking} onclick={() => tick(true)}>
							Force tick
						</Button>
					</div>
				</form>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Bots</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if bots.length}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Bot</Table.Head>
								<Table.Head class="text-right">Cash</Table.Head>
								<Table.Head class="text-right">In orders</Table.Head>
								<Table.Head class="text-right">Stocks</Table.Head>
								<Table.Head class="text-right">Coins</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each bots as bot (bot.username)}
								<Table.Row>
									<Table.Cell>{bot.username}</Table.Cell>
									<Table.Cell class="text-right">{money(bot.cash)}</Table.Cell>
									<Table.Cell class="text-right">{money(bot.orderCash)}</Table.Cell>
									<Table.Cell class="text-right">{money(bot.stockValue)}</Table.Cell>
									<Table.Cell class="text-right">{money(bot.coinValue)}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{:else}
					<p class="text-muted-foreground text-sm">
						No bots yet. They appear after the first tick.
					</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>Recent decisions</Card.Title>
			</Card.Header>
			<Card.Content>
				{#if recent.length}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Time</Table.Head>
								<Table.Head>Asset</Table.Head>
								<Table.Head>Who</Table.Head>
								<Table.Head>By</Table.Head>
								<Table.Head class="text-right">Buy / sell / hold</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each recent as d (d.id)}
								<Table.Row>
									<Table.Cell>{new Date(d.createdAt).toLocaleTimeString()}</Table.Cell>
									<Table.Cell>{d.symbol}</Table.Cell>
									<Table.Cell>{d.archetype.toLowerCase()}</Table.Cell>
									<Table.Cell>{d.source === 'llm' ? 'AI' : 'rules'}</Table.Cell>
									<Table.Cell class="text-right">
										{pct(d.buy)} / {pct(d.sell)} / {pct(d.hold)}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{:else}
					<p class="text-muted-foreground text-sm">Nothing yet.</p>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
{/if}
