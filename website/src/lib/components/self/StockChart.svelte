<script lang="ts">
	import {
		createChart,
		ColorType,
		LineSeries,
		type IChartApi,
		type ISeriesApi,
		type UTCTimestamp
	} from 'lightweight-charts';

	let { data }: { data: { time: number; value: number }[] } = $props();

	let container = $state<HTMLDivElement>();
	let chart = $state.raw<IChartApi>();
	let series = $state.raw<ISeriesApi<'Line'>>();

	// the chart is made once per container; polls only swap the data
	$effect(() => {
		if (!container) return;
		const c = createChart(container, {
			layout: {
				textColor: '#666666',
				background: { type: ColorType.Solid, color: 'transparent' },
				attributionLogo: false
			},
			grid: {
				vertLines: { color: '#2B2B43' },
				horzLines: { color: '#2B2B43' }
			},
			rightPriceScale: {
				borderVisible: false,
				scaleMargins: { top: 0.1, bottom: 0.1 },
				alignLabels: true,
				entireTextOnly: false,
				visible: true
			},
			timeScale: {
				borderVisible: false,
				timeVisible: true,
				rightOffset: 5
			},
			crosshair: {
				mode: 1,
				vertLine: { color: '#758696', width: 1, style: 2, visible: true, labelVisible: true },
				horzLine: { color: '#758696', width: 1, style: 2, visible: true, labelVisible: true }
			}
		});
		chart = c;
		series = c.addSeries(LineSeries, {
			color: '#2962FF',
			lineWidth: 3,
			priceFormat: { type: 'price', precision: 6, minMove: 0.000001 }
		});

		const handleResize = () => c.applyOptions({ width: container?.clientWidth });
		window.addEventListener('resize', handleResize);
		handleResize();

		return () => {
			window.removeEventListener('resize', handleResize);
			series = chart = undefined;
			c.remove();
		};
	});

	$effect(() => {
		if (!series || !chart) return;
		series.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
		chart.timeScale().fitContent();
	});
</script>

{#if data.length === 0}
	<div class="text-muted-foreground flex h-[300px] w-full items-center justify-center text-sm">
		No trades yet. The first trade sets the price.
	</div>
{:else}
	<div bind:this={container} class="h-[300px] w-full"></div>
{/if}
