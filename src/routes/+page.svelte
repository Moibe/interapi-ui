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

	let boxes = $state<Box[]>([]);

	let connections = $state<Connection[]>([]);
	let nextId = 1;

	function createBox() {
		const id = nextId++;
		const offset = (boxes.length % 5) * 30;
		boxes.push({ id, x: 80 + offset, y: 80 + offset });
	}

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

	// Remove box
	let confirmingBox = $state<Box | null>(null);
	let confirmPos = $state({ x: 0, y: 0 });

	function removeBox(e: MouseEvent, box: Box) {
		e.preventDefault();
		e.stopPropagation();
		confirmPos = { x: e.clientX, y: e.clientY };
		confirmingBox = box;
	}

	function confirmRemoveBox() {
		if (!confirmingBox) return;
		for (let i = connections.length - 1; i >= 0; i--) {
			if (connections[i].fromId === confirmingBox.id || connections[i].toId === confirmingBox.id) {
				connections.splice(i, 1);
			}
		}
		const idx = boxes.findIndex((b) => b.id === confirmingBox.id);
		if (idx !== -1) boxes.splice(idx, 1);
		confirmingBox = null;
	}

	function cancelRemoveBox() {
		confirmingBox = null;
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

<button class="btn-create" onclick={createBox}>Crear</button>

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
			style="left: {box.x}px; top: {box.y}px; z-index: {box.id};"
			bind:this={boxEls[box.id]}
			onpointerdown={(e) => onPointerDown(e, box)}
			onpointermove={(e) => onPointerMove(e, box)}
			onpointerup={() => onPointerUp(box)}
			oncontextmenu={(e) => removeBox(e, box)}
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

{#if confirmingBox}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onpointerdown={cancelRemoveBox}>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal" style="left: {confirmPos.x}px; top: {confirmPos.y}px;" onpointerdown={(e) => e.stopPropagation()}>
		<p>¿Eliminar nodo {confirmingBox.id}?</p>
		<div class="modal-actions">
			<button class="modal-btn cancel" onclick={cancelRemoveBox}>Cancelar</button>
			<button class="modal-btn confirm" onclick={confirmRemoveBox}>Eliminar</button>
		</div>
	</div>
</div>
{/if}

<style>
	.btn-create {
		position: absolute;
		top: 1.2%;
		left: 1.2%;
		padding: 8px 22px;
		background: rgba(255, 255, 255, 0.12);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.35);
		border-radius: 8px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition: background 0.2s, border-color 0.2s;
		z-index: 20;
	}

	.btn-create:hover {
		background: rgba(255, 255, 255, 0.22);
		border-color: rgba(255, 255, 255, 0.6);
	}

	.btn-create:active {
		background: rgba(255, 255, 255, 0.3);
	}

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

	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: rgba(0, 0, 0, 0.3);
		z-index: 1000;
	}

	.modal {
		position: fixed;
		transform: translate(10px, 10px);
		background: rgba(30, 30, 30, 0.95);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 12px;
		width: 140px;
		height: 140px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 14px;
		box-shadow: 0 16px 50px rgba(0, 0, 0, 0.6);
		backdrop-filter: blur(8px);
	}

	.modal p {
		color: white;
		font-size: 13px;
		margin: 0;
	}

	.modal-actions {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.modal-btn {
		padding: 5px 14px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s, border-color 0.2s;
	}

	.modal-btn.cancel {
		background: rgba(255, 255, 255, 0.1);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.3);
	}

	.modal-btn.cancel:hover {
		background: rgba(255, 255, 255, 0.2);
	}

	.modal-btn.confirm {
		background: rgba(220, 60, 60, 0.8);
		color: white;
		border: 1px solid rgba(220, 60, 60, 0.6);
	}

	.modal-btn.confirm:hover {
		background: rgba(220, 60, 60, 1);
	}
</style>
