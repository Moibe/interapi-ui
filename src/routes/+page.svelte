<script lang="ts">
	import { animate } from 'animejs';

	interface Box {
		id: number;
		x: number;
		y: number;
	}

	interface Connection {
		fromId: number;
		toId: number;
	}

	let boxes = $state<Box[]>([
		{ id: 1, x: 100, y: 100 },
		{ id: 2, x: 400, y: 100 }
	]);

	let connections = $state<Connection[]>([]);

	// Box dragging
	let draggingId = $state<number | null>(null);
	let offsetX = 0;
	let offsetY = 0;
	let boxEls: Record<number, HTMLDivElement> = {};
	let workspaceEl: HTMLDivElement;

	// Wire dragging
	let wiringFromId = $state<number | null>(null);
	let wireEnd = $state({ x: 0, y: 0 });

	const BOX_SIZE = 120;
	const HALF = BOX_SIZE / 2;
	const DOT_OFFSET = 6;

	function clamp(val: number, min: number, max: number) {
		return Math.max(min, Math.min(max, val));
	}

	function getOutputPos(box: Box) {
		return { x: box.x + BOX_SIZE + DOT_OFFSET, y: box.y + HALF };
	}

	function getInputPos(box: Box) {
		return { x: box.x, y: box.y + HALF };
	}

	function buildCurve(x1: number, y1: number, x2: number, y2: number) {
		const dx = x2 - x1;
		const tension = Math.max(Math.abs(dx) * 0.4, 50);
		return `M ${x1} ${y1} C ${x1 + tension} ${y1}, ${x2 - tension} ${y2}, ${x2} ${y2}`;
	}

	// Box drag handlers
	function onPointerDown(e: PointerEvent, box: Box) {
		if (e.button !== 0) return;
		if (wiringFromId !== null) return;
		draggingId = box.id;
		const target = e.currentTarget as HTMLElement;
		const boxRect = target.getBoundingClientRect();
		offsetX = e.clientX - boxRect.left;
		offsetY = e.clientY - boxRect.top;
		target.setPointerCapture(e.pointerId);

		animate(boxEls[box.id], {
			scale: [1, 1.08],
			boxShadow: [
				'0 4px 20px rgba(0,0,0,0.3)',
				'0 16px 50px rgba(0,0,0,0.6)'
			],
			duration: 250,
			ease: 'outCubic'
		});
	}

	function onPointerMove(e: PointerEvent, box: Box) {
		if (draggingId !== box.id) return;
		const wsRect = workspaceEl.getBoundingClientRect();
		box.x = clamp(e.clientX - wsRect.left - offsetX, 0, wsRect.width - BOX_SIZE);
		box.y = clamp(e.clientY - wsRect.top - offsetY, 0, wsRect.height - BOX_SIZE);
	}

	function onPointerUp(box: Box) {
		if (draggingId !== box.id) return;
		draggingId = null;
		animate(boxEls[box.id], {
			scale: [1.15, 1],
			boxShadow: [
				'0 12px 40px rgba(0,0,0,0.6)',
				'0 4px 20px rgba(0,0,0,0.3)'
			],
			duration: 400,
			ease: 'outElastic(1, 0.5)'
		});
	}

	// Wire drag handlers
	function onOutputPointerDown(e: PointerEvent, box: Box) {
		if (e.button !== 0) return;
		e.stopPropagation();
		wiringFromId = box.id;
		const wsRect = workspaceEl.getBoundingClientRect();
		wireEnd = { x: e.clientX - wsRect.left, y: e.clientY - wsRect.top };
	}

	function onWorkspacePointerMove(e: PointerEvent) {
		if (wiringFromId === null) return;
		const wsRect = workspaceEl.getBoundingClientRect();
		wireEnd = { x: e.clientX - wsRect.left, y: e.clientY - wsRect.top };
	}

	function onInputPointerUp(e: PointerEvent, targetBox: Box) {
		if (wiringFromId === null) return;
		e.stopPropagation();
		if (wiringFromId !== targetBox.id) {
			const exists = connections.some(
				(c) => c.fromId === wiringFromId && c.toId === targetBox.id
			);
			if (!exists) {
				connections.push({ fromId: wiringFromId!, toId: targetBox.id });
			}
		}
		wiringFromId = null;
	}

	function onWorkspacePointerUp() {
		wiringFromId = null;
	}

	let inputDotEls: Record<number, HTMLSpanElement> = {};

	function onInputDotEnter(box: Box) {
		if (wiringFromId === null || wiringFromId === box.id) return;
		animate(inputDotEls[box.id], {
			scale: [1, 1.8],
			boxShadow: ['0 0 6px rgba(76,175,80,0.6)', '0 0 14px rgba(76,175,80,0.9)'],
			duration: 200,
			ease: 'outCubic'
		});
	}

	function onInputDotLeave(box: Box) {
		if (!inputDotEls[box.id]) return;
		animate(inputDotEls[box.id], {
			scale: [1.8, 1],
			boxShadow: ['0 0 14px rgba(76,175,80,0.9)', '0 0 6px rgba(76,175,80,0.6)'],
			duration: 200,
			ease: 'outCubic'
		});
	}

	// Remove connection
	function removeConnection(index: number) {
		connections.splice(index, 1);
	}

	function removeConnectionsForDot(boxId: number, type: 'input' | 'output') {
		for (let i = connections.length - 1; i >= 0; i--) {
			if (type === 'output' && connections[i].fromId === boxId) {
				connections.splice(i, 1);
			} else if (type === 'input' && connections[i].toId === boxId) {
				connections.splice(i, 1);
			}
		}
	}

	// Derived paths
	let connectionPaths = $derived.by(() => {
		return connections.map((conn) => {
			const fromBox = boxes.find((b) => b.id === conn.fromId)!;
			const toBox = boxes.find((b) => b.id === conn.toId)!;
			const from = getOutputPos(fromBox);
			const to = getInputPos(toBox);
			return buildCurve(from.x, from.y, to.x, to.y);
		});
	});

	let draggingWirePath = $derived.by(() => {
		if (wiringFromId === null) return '';
		const fromBox = boxes.find((b) => b.id === wiringFromId)!;
		const from = getOutputPos(fromBox);
		return buildCurve(from.x, from.y, wireEnd.x, wireEnd.y);
	});
</script>

<div
	class="workspace"
	bind:this={workspaceEl}
	onpointermove={onWorkspacePointerMove}
	onpointerup={onWorkspacePointerUp}
	oncontextmenu={(e) => e.preventDefault()}
>
	<svg class="connections">
		{#each connectionPaths as d, i}
			<path {d} fill="none" stroke="transparent" stroke-width="12"
				oncontextmenu={(e) => { e.preventDefault(); removeConnection(i); }} />
			<path {d} fill="none" stroke="white" stroke-width="1.5" pointer-events="none" />
		{/each}
		{#if draggingWirePath}
			<path d={draggingWirePath} fill="none" stroke="white" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.7" />
		{/if}
	</svg>
	{#each boxes as box (box.id)}
		<div
			class="box"
			class:dragging={draggingId === box.id}
			style="left: {box.x}px; top: {box.y}px;"
			bind:this={boxEls[box.id]}
			onpointerdown={(e) => onPointerDown(e, box)}
			onpointermove={(e) => onPointerMove(e, box)}
			onpointerup={() => onPointerUp(box)}
		>
			<span
				class="dot input"
				bind:this={inputDotEls[box.id]}
				onpointerdown={(e) => e.stopPropagation()}
				onpointerup={(e) => onInputPointerUp(e, box)}
				onpointerenter={() => onInputDotEnter(box)}
				onpointerleave={() => onInputDotLeave(box)}
				oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); removeConnectionsForDot(box.id, 'input'); }}
			></span>
			<span
				class="dot output"
				onpointerdown={(e) => onOutputPointerDown(e, box)}
				oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); removeConnectionsForDot(box.id, 'output'); }}
			></span>
		</div>
	{/each}
</div>

<style>
	.workspace {
		position: absolute;
		top: 5%;
		left: 5%;
		width: 90%;
		height: 90%;
		border: 1px solid white;
		border-radius: 16px;
	}

	.connections {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.box {
		position: absolute;
		width: 120px;
		height: 120px;
		background: white;
		border-radius: 12px;
		cursor: grab;
		user-select: none;
		touch-action: none;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}

	.box.dragging {
		cursor: grabbing;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
	}

	.dot {
		position: absolute;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		top: 50%;
		margin-top: -6px;
		cursor: crosshair;
		z-index: 10;
	}

	.dot.input {
		left: -6px;
		background: #4caf50;
		box-shadow: 0 0 6px rgba(76, 175, 80, 0.6);
	}

	.dot.output {
		right: -6px;
		background: #ff9800;
		box-shadow: 0 0 6px rgba(255, 152, 0, 0.6);
	}
</style>
