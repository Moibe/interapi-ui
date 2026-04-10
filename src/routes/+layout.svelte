<script lang="ts">
	let { children } = $props();
</script>

<div class="app">
	{@render children()}
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		width: 100%;
		height: 100%;
	}

	.app {
		width: 100%;
		min-height: 100vh;
		background: linear-gradient(135deg, #2d0a5f 0%, #5020a0 50%, #6b40b0 100%);
	}
</style>
