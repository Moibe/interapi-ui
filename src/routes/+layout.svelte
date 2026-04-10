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
		background: linear-gradient(135deg, #1a0a4b 0%, #2b1aad 20%, #1565c0 40%, #6a1b9a 60%, #0d8db5 80%, #0d3b66 100%);
	}
</style>
