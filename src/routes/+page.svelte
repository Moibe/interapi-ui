<script lang="ts">
	import { onMount } from 'svelte';
	import { animate } from 'animejs';
	import { parseOpenAPI } from '$lib/openapi';

	import type { OpenAPIEndpoint } from '$lib/openapi';

	interface Box {
		id: number;
		x: number;
		y: number;
		endpoint?: OpenAPIEndpoint;
		inputValues: Record<string, string>;
	}

	interface Connection {
		fromId: number;
		toId: number;
	}

	const STORAGE_KEY = 'interapi-workflow';

	let boxes = $state<Box[]>([]);
	let connections = $state<Connection[]>([]);
	let nextId = 1;
	let showControls = $state(false);
	let activeTab = $state<'workspace' | 'pruebas'>('workspace');

	// --- Persistence ---
	function saveWorkflow() {
		const data = { boxes, connections, nextId };
		localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
	}

	function loadWorkflow() {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		try {
			const data = JSON.parse(raw);
			boxes = data.boxes ?? [];
			connections = data.connections ?? [];
			nextId = data.nextId ?? 1;
		} catch { /* corrupted data, start fresh */ }
	}

	function exportWorkflow() {
		const data = { boxes, connections, nextId };
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'workflow.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	function importWorkflow() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;
			const reader = new FileReader();
			reader.onload = () => {
				try {
					const data = JSON.parse(reader.result as string);
					boxes = data.boxes ?? [];
					connections = data.connections ?? [];
					nextId = data.nextId ?? 1;
					saveWorkflow();
				} catch { console.error('JSON inválido'); }
			};
			reader.readAsText(file);
		};
		input.click();
	}

	onMount(() => { loadWorkflow(); });

	$effect(() => {
		// Track changes to trigger save
		boxes.length; connections.length;
		JSON.stringify(boxes);
		JSON.stringify(connections);
		saveWorkflow();
	});

	function createBox() {
		const id = nextId++;
		const offset = (boxes.length % 5) * 30;
		boxes.push({ id, x: 80 + offset, y: 80 + offset, inputValues: {} });
	}

	// Test OpenAPI Parser
	let testSpecUrl = $state('https://moibe-rad.hf.space/openapi.json');
	let testPath = $state('');
	let testMethod = $state('');
	let availableEndpoints = $state<Array<{path: string; method: string; summary?: string}>>([]);
	let dropdownOpen = $state(false);
	let selectedEndpoint = $state<{path: string; method: string; summary?: string} | null>(null);

	function selectEndpoint(ep: {path: string; method: string; summary?: string}) {
		selectedEndpoint = ep;
		testPath = ep.path;
		testMethod = ep.method;
		dropdownOpen = false;
	}

	async function testOpenAPIParser() {
		if (!testSpecUrl.trim()) { console.warn('[OpenAPI] Ingresa una URL de spec.'); return; }
		console.log('Testing OpenAPI Parser...');
		try {
			const result = await parseOpenAPI(
				testSpecUrl.trim(),
				testPath.trim() || undefined,
				testMethod.trim() || undefined
			);
			console.log('Parsed endpoints:', result.endpoints.length);
			result.endpoints.forEach((ep, i) => {
				const id = nextId++;
				const offset = boxes.length % 10;
				const initValues: Record<string, string> = {};
				ep.parameters.forEach(p => initValues[`param_${p.name}`] = '');
				if (ep.request_body) {
					Object.keys(ep.request_body.fields).forEach(k => initValues[`body_${k}`] = '');
				}
				boxes.push({
					id,
					x: 80 + offset * 30,
					y: 80 + offset * 30,
					endpoint: ep,
					inputValues: initValues
				});
			});
		} catch (error) {
			console.error('Test failed:', error);
		}
	}

	async function listEndpoints() {
		if (!testSpecUrl.trim()) { console.warn('[OpenAPI] Ingresa una URL de spec.'); return; }
		try {
			const result = await parseOpenAPI(testSpecUrl.trim());
			availableEndpoints = result.endpoints.map((ep) => ({
				path: ep.path,
				method: ep.method,
				summary: ep.summary
			}));
			testPath = '';
			testMethod = '';
			selectedEndpoint = null;
			dropdownOpen = false;
		} catch (error) {
			console.error('Error listando endpoints:', error);
		}
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

	const BOX_SIZE = 250;
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
		const tag = (e.target as HTMLElement).tagName;
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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

	// --- Pruebas: Manifiesto ---
	const MANIFIESTO_API = 'https://moibe-blackbox-manifiesto.hf.space';
	let pruebasSubtab = $state<'manifiesto' | 'llena' | 'construye'>('manifiesto');
	let manifiestoUrl = $state('https://moibe-rad.hf.space/openapi.json');
	let manifiestoPath = $state('');
	let manifiestoMethod = $state('');
	let manifiestoResult = $state<object | null>(null);
	let manifiestoLoading = $state(false);
	let manifiestoError = $state('');

	// Reuse endpoint listing for Pruebas tab
	let pruebasEndpoints = $state<Array<{path: string; method: string; summary?: string; content_type?: string}>>([]);
	let pruebasDropdownOpen = $state(false);
	let pruebasSelectedEp = $state<{path: string; method: string; summary?: string; content_type?: string} | null>(null);

	async function listarEndpointsPruebas() {
		if (!manifiestoUrl.trim()) return;
		try {
			const result = await parseOpenAPI(manifiestoUrl.trim());
			pruebasEndpoints = result.endpoints.map(ep => ({ path: ep.path, method: ep.method, summary: ep.summary, content_type: ep.request_body?.content_type }));
			manifiestoPath = '';
			manifiestoMethod = '';
			pruebasSelectedEp = null;
			pruebasDropdownOpen = false;
		} catch (error) {
			console.error('Error listando endpoints (pruebas):', error);
		}
	}

	function selectPruebasEndpoint(ep: {path: string; method: string; summary?: string; content_type?: string}) {
		pruebasSelectedEp = ep;
		manifiestoPath = ep.path;
		manifiestoMethod = ep.method;
		pruebasDropdownOpen = false;
	}

	async function crearManifiesto() {
		if (!manifiestoUrl.trim() || !manifiestoPath.trim() || !manifiestoMethod.trim()) {
			manifiestoError = 'Completa los 3 campos.';
			return;
		}
		manifiestoLoading = true;
		manifiestoError = '';
		manifiestoResult = null;
		try {
			const resp = await fetch(`${MANIFIESTO_API}/manifiesto`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					openapi_url: manifiestoUrl.trim(),
					endpoint_path: manifiestoPath.trim(),
					method: manifiestoMethod.trim().toUpperCase()
				})
			});
			if (!resp.ok) throw new Error(`Error ${resp.status}: ${resp.statusText}`);
			manifiestoResult = await resp.json();

			// Auto-populate Llena subtab
			llenaTemplate = JSON.stringify(manifiestoResult, null, 2);
			if (pruebasSelectedEp?.content_type) {
				const ct = pruebasSelectedEp.content_type;
				if (ct.includes('multipart')) llenaBodyType = 'multipart';
				else if (ct.includes('form-urlencoded')) llenaBodyType = 'form';
				else llenaBodyType = 'json';
			}
		} catch (err: any) {
			manifiestoError = err.message || 'Error desconocido';
		} finally {
			manifiestoLoading = false;
		}
	}

	function descargarManifiesto() {
		if (!manifiestoResult) return;
		const blob = new Blob([JSON.stringify(manifiestoResult, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'manifiesto.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	// --- Pruebas: Llena ---
	let llenaTemplate = $state('');
	let llenaBodyType = $state('json');
	let llenaValues = $state('');
	let llenaResult = $state<object | null>(null);
	let llenaLoading = $state(false);
	let llenaError = $state('');

	async function ejecutarLlena() {
		if (!llenaTemplate.trim()) {
			llenaError = 'Pega la plantilla (JSON del manifiesto).';
			return;
		}
		llenaLoading = true;
		llenaError = '';
		llenaResult = null;
		try {
			const template = JSON.parse(llenaTemplate.trim());
			const values = llenaValues.trim() ? JSON.parse(llenaValues.trim()) : {};
			const resp = await fetch(`${MANIFIESTO_API}/llena`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ template, body_type: llenaBodyType, values })
			});
			if (!resp.ok) throw new Error(`Error ${resp.status}: ${resp.statusText}`);
			llenaResult = await resp.json();
		} catch (err: any) {
			llenaError = err.message || 'Error desconocido';
		} finally {
			llenaLoading = false;
		}
	}

	function descargarLlena() {
		if (!llenaResult) return;
		const blob = new Blob([JSON.stringify(llenaResult, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'manifiesto-lleno.json';
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<nav class="tabs-bar">
	<button class="tab" class:active={activeTab === 'workspace'} onclick={() => activeTab = 'workspace'}>Workspace</button>
	<button class="tab" class:active={activeTab === 'pruebas'} onclick={() => activeTab = 'pruebas'}>Pruebas</button>
</nav>

{#if activeTab === 'workspace'}
<div class="api-panel">
	<button class="btn-create" onclick={() => showControls = !showControls}>{showControls ? 'Cerrar' : 'Crear'}</button>
	{#if showControls}
		<input class="api-input" bind:value={testSpecUrl} placeholder="URL openapi.json" />
		<button class="btn-list" onclick={listEndpoints}>Listar Endpoints</button>
		{#if availableEndpoints.length > 0}
			<div class="ep-dropdown" class:open={dropdownOpen}>
				<!-- hidden sizer: forces container to be as wide as the longest option -->
				<div class="ep-sizer" aria-hidden="true">
					{#each availableEndpoints as ep}
						<div class="ep-option">
							<span class="ep-badge">{ep.method.toUpperCase()}</span>
							<span>{ep.path}</span>
						</div>
					{/each}
				</div>
				<button class="ep-trigger" onclick={() => dropdownOpen = !dropdownOpen}>
					{#if selectedEndpoint}
						<span class="ep-trigger-path">{selectedEndpoint.path}</span>
					{:else}
						<span class="ep-placeholder">— Seleccionar endpoint —</span>
					{/if}
					<span class="ep-arrow">{dropdownOpen ? '▴' : '▾'}</span>
				</button>
				{#if dropdownOpen}
					<div class="ep-list">
						{#each availableEndpoints as ep}
							<button class="ep-option" onclick={() => selectEndpoint(ep)}>
								<span class="ep-badge method-{ep.method.toLowerCase()}">{ep.method.toUpperCase()}</span>
								<span class="ep-option-path">{ep.path}</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<button class="btn-create" onclick={testOpenAPIParser}>Agregar Endpoint</button>
		{/if}
	{/if}
	<div class="toolbar-spacer"></div>
	<button class="btn-io" onclick={exportWorkflow} title="Exportar workflow">⬇ Exportar</button>
	<button class="btn-io" onclick={importWorkflow} title="Importar workflow">⬆ Importar</button>
</div>

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
			{#if box.endpoint}
			<div class="box-content">
				<div class="box-title-row">
					<span class="box-method method-{box.endpoint.method.toLowerCase()}">{box.endpoint.method.toUpperCase()}</span>
					<span class="box-path">{box.endpoint.path}</span>
				</div>
				{#if box.endpoint.summary}
					<span class="box-summary">{box.endpoint.summary}</span>
				{/if}

				<div class="box-section">
					<span class="section-label">IN</span>
					{#if box.endpoint.parameters.length === 0 && !box.endpoint.request_body}
						<span class="param-empty">—</span>
					{:else}
						{#each box.endpoint.parameters as param}
							<div class="param-row">
								<span class="param-label" class:param-required={param.required}>{param.name}</span>
								{#if param.type === 'boolean'}
									<input type="checkbox" class="param-checkbox" checked={box.inputValues[`param_${param.name}`] === 'true'} onchange={(e) => box.inputValues[`param_${param.name}`] = String(e.currentTarget.checked)} onpointerdown={(e) => e.stopPropagation()} />
								{:else if param.type === 'integer' || param.type === 'number'}
									<input type="number" class="param-input" placeholder="{param.type}" bind:value={box.inputValues[`param_${param.name}`]} onpointerdown={(e) => e.stopPropagation()} />
								{:else}
									<input type="text" class="param-input" placeholder="{param.type}" bind:value={box.inputValues[`param_${param.name}`]} onpointerdown={(e) => e.stopPropagation()} />
								{/if}
							</div>
						{/each}
						{#if box.endpoint.request_body}
							<span class="param-content-type">{box.endpoint.request_body.content_type}</span>
							{#each Object.entries(box.endpoint.request_body.fields) as [key, type]}
								<div class="param-row">
									<span class="param-label">{key}</span>
									{#if type === 'boolean'}
										<input type="checkbox" class="param-checkbox" checked={box.inputValues[`body_${key}`] === 'true'} onchange={(e) => box.inputValues[`body_${key}`] = String(e.currentTarget.checked)} onpointerdown={(e) => e.stopPropagation()} />
									{:else if type.includes('binary') || type.includes('file')}
										<input type="file" class="param-file" onpointerdown={(e) => e.stopPropagation()} />
									{:else if type === 'integer' || type === 'number'}
										<input type="number" class="param-input" placeholder="{type}" bind:value={box.inputValues[`body_${key}`]} onpointerdown={(e) => e.stopPropagation()} />
									{:else}
										<input type="text" class="param-input" placeholder="{type}" bind:value={box.inputValues[`body_${key}`]} onpointerdown={(e) => e.stopPropagation()} />
									{/if}
								</div>
							{/each}
						{/if}
					{/if}
				</div>

				<div class="box-section">
					<span class="section-label">OUT</span>
					{#each box.endpoint.responses as resp}
						<div class="box-response">
							<span class="resp-status">{resp.status_code}</span>
							{#if resp.content_type}
								<span class="resp-type">{resp.content_type}</span>
							{/if}
							{#if Object.keys(resp.fields).length > 0}
								{#each Object.entries(resp.fields) as [key, type]}
									<span class="resp-field">{key}: {type}</span>
								{/each}
							{/if}
						</div>
					{/each}
				</div>
			</div>
			{/if}
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

{/if}

{#if activeTab === 'pruebas'}
<div class="pruebas-workspace">
	<nav class="subtabs-bar">
		<button class="subtab" class:active={pruebasSubtab === 'manifiesto'} onclick={() => pruebasSubtab = 'manifiesto'}>Crea Manifiesto</button>
		<button class="subtab" class:active={pruebasSubtab === 'llena'} onclick={() => pruebasSubtab = 'llena'}>Llena</button>
		<button class="subtab" class:active={pruebasSubtab === 'construye'} onclick={() => pruebasSubtab = 'construye'}>Construye</button>
	</nav>

	{#if pruebasSubtab === 'manifiesto'}
	<div class="pruebas-form">
		<div class="pruebas-row">
			<span class="pruebas-label">OpenAPI URL</span>
			<input class="pruebas-input" bind:value={manifiestoUrl} placeholder="https://...openapi.json" />
		</div>
		<div class="pruebas-row">
			<span class="pruebas-label">Endpoint</span>
			<div class="pruebas-endpoint-row">
				<button class="btn-list btn-list--sm" onclick={listarEndpointsPruebas}>Listar</button>
				{#if pruebasEndpoints.length > 0}
					<div class="ep-dropdown" class:open={pruebasDropdownOpen}>
						<div class="ep-sizer" aria-hidden="true">
							{#each pruebasEndpoints as ep}
								<div class="ep-option"><span class="ep-badge">{ep.method.toUpperCase()}</span><span>{ep.path}</span></div>
							{/each}
						</div>
						<button class="ep-trigger" onclick={() => pruebasDropdownOpen = !pruebasDropdownOpen}>
							{#if pruebasSelectedEp}
								<span class="ep-trigger-path">{pruebasSelectedEp.method.toUpperCase()} {pruebasSelectedEp.path}</span>
							{:else}
								<span class="ep-placeholder">— Seleccionar endpoint —</span>
							{/if}
							<span class="ep-arrow">{pruebasDropdownOpen ? '▴' : '▾'}</span>
						</button>
						{#if pruebasDropdownOpen}
							<div class="ep-list">
								{#each pruebasEndpoints as ep}
									<button class="ep-option" onclick={() => selectPruebasEndpoint(ep)}>
										<span class="ep-badge method-{ep.method.toLowerCase()}">{ep.method.toUpperCase()}</span>
										<span class="ep-option-path">{ep.path}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<input class="pruebas-input pruebas-input--short" bind:value={manifiestoPath} placeholder="/endpoint" />
					<input class="pruebas-input pruebas-input--method" bind:value={manifiestoMethod} placeholder="POST" />
				{/if}
			</div>
		</div>
		<div class="pruebas-actions">
			<button class="btn-manifiesto" onclick={crearManifiesto} disabled={manifiestoLoading}>
				{manifiestoLoading ? 'Creando...' : 'Crear Manifiesto'}
			</button>
			{#if manifiestoResult}
				<button class="btn-io" onclick={descargarManifiesto}>⬇ Descargar JSON</button>
			{/if}
		</div>
		{#if manifiestoError}
			<div class="pruebas-error">{manifiestoError}</div>
		{/if}
		{#if manifiestoResult}
			<pre class="pruebas-json">{JSON.stringify(manifiestoResult, null, 2)}</pre>
		{/if}
	</div>
	{/if}

	{#if pruebasSubtab === 'llena'}
	<div class="pruebas-form">
		<div class="pruebas-row">
			<span class="pruebas-label">Plantilla (JSON de /manifiesto)</span>
			<textarea class="pruebas-textarea" bind:value={llenaTemplate} placeholder='Pega aquí el JSON de la plantilla...' rows="8"></textarea>
		</div>
		<div class="pruebas-row">
			<span class="pruebas-label">Body Type</span>
			<span class="pruebas-badge-bodytype">{llenaBodyType}</span>
		</div>
		<div class="pruebas-row">
			<span class="pruebas-label">Values (JSON con los valores)</span>
			<textarea class="pruebas-textarea" bind:value={llenaValues} placeholder={'{"param1": "valor1", "param2": "valor2"}'} rows="4"></textarea>
		</div>
		<div class="pruebas-actions">
			<button class="btn-manifiesto" onclick={ejecutarLlena} disabled={llenaLoading}>
				{llenaLoading ? 'Llenando...' : 'Llenar Manifiesto'}
			</button>
			{#if llenaResult}
				<button class="btn-io" onclick={descargarLlena}>⬇ Descargar JSON</button>
			{/if}
		</div>
		{#if llenaError}
			<div class="pruebas-error">{llenaError}</div>
		{/if}
		{#if llenaResult}
			<pre class="pruebas-json">{JSON.stringify(llenaResult, null, 2)}</pre>
		{/if}
	</div>
	{/if}

	{#if pruebasSubtab === 'construye'}
	<div class="pruebas-form">
		<p class="pruebas-empty">Próximamente...</p>
	</div>
	{/if}
</div>
{/if}

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
	@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');

	:global(body) {
		font-family: 'Roboto', sans-serif;
	}

	.btn-create {
		padding: 10px 26px;
		background: rgba(255, 255, 255, 0.12);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.35);
		border-radius: 8px;
		font-size: 16px;
		font-weight: 700;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition: background 0.2s, border-color 0.2s;
		font-family: 'Roboto', sans-serif;
	}

	.btn-create--inline {
		position: absolute;
		top: 1.2%;
		left: 1.2%;
		z-index: 20;
	}

	.btn-create:hover {
		background: rgba(255, 255, 255, 0.22);
		border-color: rgba(255, 255, 255, 0.6);
	}

	.btn-create:active {
		background: rgba(255, 255, 255, 0.3);
	}

	.toolbar-spacer {
		flex: 1;
	}

	.btn-io {
		padding: 6px 14px;
		background: rgba(255, 255, 255, 0.08);
		color: rgba(255, 255, 255, 0.7);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 6px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition: background 0.2s, color 0.2s;
		font-family: 'Roboto', sans-serif;
		white-space: nowrap;
	}

	.btn-io:hover {
		background: rgba(255, 255, 255, 0.18);
		color: white;
	}

	.btn-list {
		padding: 10px 26px;
		background: rgba(76, 175, 80, 0.9);
		color: white;
		border: 1px solid rgba(76, 175, 80, 0.8);
		border-radius: 8px;
		font-size: 16px;
		font-weight: 700;
		cursor: pointer;
		backdrop-filter: blur(8px);
		transition: background 0.2s, border-color 0.2s;
		font-family: 'Roboto', sans-serif;
	}

	.btn-list:hover {
		background: rgba(76, 175, 80, 1);
		border-color: rgba(76, 175, 80, 1);
	}

	.btn-list:active {
		background: rgba(56, 142, 60, 0.9);
	}

	.tabs-bar {
		position: absolute;
		top: 12px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: 4px;
		background: rgba(255, 255, 255, 0.08);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 12px;
		padding: 4px;
		z-index: 30;
	}

	.tab {
		padding: 7px 22px;
		background: none;
		border: none;
		border-radius: 8px;
		color: rgba(255, 255, 255, 0.55);
		font-family: 'Roboto', sans-serif;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
		white-space: nowrap;
	}

	.tab:hover {
		color: rgba(255, 255, 255, 0.85);
	}

	.tab.active {
		background: rgba(255, 255, 255, 0.18);
		color: white;
	}

	.api-panel {
		position: absolute;
		top: 70px;
		left: 5%;
		right: 5%;
		display: flex;
		gap: 8px;
		align-items: center;
		z-index: 20;
		max-width: calc(90% - 10px);
	}

	.api-input {
		padding: 8px 14px;
		background: rgba(255, 255, 255, 0.1);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.3);
		border-radius: 8px;
		font-size: 15px;
		width: 280px;
		backdrop-filter: blur(8px);
		outline: none;
		transition: border-color 0.2s;
		font-family: 'Roboto', sans-serif;
	}

	.api-input--short {
		width: 140px;
	}

	.ep-dropdown {
		position: relative;
		display: inline-flex;
		flex-direction: column;
	}

	.ep-sizer {
		visibility: hidden;
		height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		pointer-events: none;
	}

	.ep-trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		background: rgba(255, 255, 255, 0.08);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 8px;
		font-size: 13px;
		font-family: 'Roboto', sans-serif;
		width: 100%;
		cursor: pointer;
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		transition: border-color 0.2s;
		min-height: 36px;
	}

	.ep-dropdown.open .ep-trigger {
		border-color: rgba(255, 255, 255, 0.7);
		border-bottom-left-radius: 0;
		border-bottom-right-radius: 0;
	}

	.ep-trigger-path {
		flex: 1;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ep-placeholder {
		flex: 1;
		text-align: left;
		color: rgba(255, 255, 255, 0.4);
	}

	.ep-arrow {
		font-size: 11px;
		opacity: 0.6;
		margin-left: auto;
		flex-shrink: 0;
	}

	.ep-list {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-top: none;
		border-bottom-left-radius: 8px;
		border-bottom-right-radius: 8px;
		max-height: 260px;
		overflow-y: auto;
		z-index: 100;
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
	}

	.ep-option {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		background: none;
		border: none;
		color: white;
		font-family: 'Roboto', sans-serif;
		font-size: 13px;
		cursor: pointer;
		text-align: left;
		transition: background 0.15s;
	}

	.ep-option:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.ep-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 2px 7px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 700;
		font-family: 'Roboto', sans-serif;
		color: white;
		min-width: unset;
		text-align: center;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.ep-option-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.ep-option-path {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.ep-option-summary {
		font-size: 11px;
		color: rgba(255, 255, 255, 0.5);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.api-input::placeholder {
		color: rgba(255, 255, 255, 0.4);
	}

	.api-input:focus {
		border-color: rgba(255, 255, 255, 0.7);
	}

	.workspace, .pruebas-workspace {
		position: absolute;
		top: 128px;
		left: 5%;
		width: 90%;
		height: calc(100% - 140px);
		border: 1px solid white;
		border-radius: 16px;
	}

	.pruebas-workspace {
		overflow-y: auto;
		padding: 20px 40px;
		display: flex;
		flex-direction: column;
	}

	.subtabs-bar {
		display: flex;
		gap: 4px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 10px;
		padding: 3px;
		width: fit-content;
		margin-bottom: 20px;
	}

	.subtab {
		padding: 6px 18px;
		background: none;
		border: none;
		border-radius: 7px;
		color: rgba(255, 255, 255, 0.5);
		font-family: 'Roboto', sans-serif;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
		white-space: nowrap;
	}

	.subtab:hover {
		color: rgba(255, 255, 255, 0.8);
	}

	.subtab.active {
		background: rgba(255, 255, 255, 0.15);
		color: white;
	}

	.subtab-option {
		padding: 5px 14px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 6px;
		color: rgba(255, 255, 255, 0.5);
		font-family: 'Roboto', sans-serif;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, color 0.2s;
	}

	.subtab-option:hover {
		color: rgba(255, 255, 255, 0.8);
	}

	.subtab-option.active {
		background: rgba(255, 255, 255, 0.18);
		color: white;
		border-color: rgba(255, 255, 255, 0.4);
	}

	.pruebas-badge-bodytype {
		display: inline-block;
		padding: 4px 12px;
		background: rgba(255, 255, 255, 0.12);
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 6px;
		color: white;
		font-family: 'Roboto', sans-serif;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
	}

	.pruebas-textarea {
		padding: 10px 14px;
		background: rgba(255, 255, 255, 0.08);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 8px;
		font-size: 13px;
		font-family: 'Roboto Mono', monospace;
		outline: none;
		backdrop-filter: blur(8px);
		transition: border-color 0.2s;
		resize: vertical;
		width: 100%;
	}

	.pruebas-textarea:focus {
		border-color: rgba(255, 255, 255, 0.7);
	}

	.pruebas-textarea::placeholder {
		color: rgba(255, 255, 255, 0.3);
	}

	.pruebas-empty {
		color: rgba(255, 255, 255, 0.4);
		font-family: 'Roboto', sans-serif;
		font-size: 14px;
		font-style: italic;
	}

	.pruebas-form {
		display: flex;
		flex-direction: column;
		gap: 18px;
		max-width: 650px;
	}

	.pruebas-title {
		font-family: 'Roboto', sans-serif;
		font-size: 20px;
		font-weight: 700;
		color: white;
		margin: 0;
	}

	.pruebas-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.pruebas-label {
		font-family: 'Roboto', sans-serif;
		font-size: 12px;
		font-weight: 600;
		color: rgba(255, 255, 255, 0.6);
		text-transform: uppercase;
		letter-spacing: 0.8px;
	}

	.pruebas-input {
		padding: 10px 14px;
		background: rgba(255, 255, 255, 0.08);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 8px;
		font-size: 14px;
		font-family: 'Roboto', sans-serif;
		outline: none;
		backdrop-filter: blur(8px);
		transition: border-color 0.2s;
	}

	.pruebas-input:focus {
		border-color: rgba(255, 255, 255, 0.7);
	}

	.pruebas-input::placeholder {
		color: rgba(255, 255, 255, 0.3);
	}

	.pruebas-input--short {
		flex: 1;
	}

	.pruebas-input--method {
		width: 90px;
		text-transform: uppercase;
	}

	.pruebas-endpoint-row {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}

	.btn-list--sm {
		padding: 8px 16px;
		font-size: 13px;
	}

	.pruebas-actions {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.btn-manifiesto {
		padding: 10px 28px;
		background: rgba(76, 175, 80, 0.85);
		color: white;
		border: 1px solid rgba(76, 175, 80, 0.5);
		border-radius: 8px;
		font-size: 15px;
		font-weight: 700;
		font-family: 'Roboto', sans-serif;
		cursor: pointer;
		transition: background 0.2s;
	}

	.btn-manifiesto:hover {
		background: rgba(76, 175, 80, 1);
	}

	.btn-manifiesto:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.pruebas-error {
		color: #f93e3e;
		font-size: 13px;
		font-family: 'Roboto', sans-serif;
		font-weight: 500;
	}

	.pruebas-json {
		background: rgba(0, 0, 0, 0.4);
		color: #e0e0e0;
		padding: 16px;
		border-radius: 8px;
		font-size: 12px;
		font-family: 'Roboto Mono', monospace;
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
		border: 1px solid rgba(255, 255, 255, 0.1);
		max-height: 400px;
		overflow-y: auto;
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
		width: 250px;
		height: 250px;
		background: white;
		border-radius: 12px;
		cursor: grab;
		user-select: none;
		touch-action: none;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}

	.box-content {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: flex-start;
		overflow: hidden;
		overflow-y: auto;
		padding: 10px;
	}

	.box-method {
		font-size: 13px;
		font-weight: 700;
		color: white;
		padding: 4px 12px;
		border-radius: 4px;
		letter-spacing: 0.5px;
		text-transform: uppercase;
	}

	.method-get {
		background: #61affe;
	}

	.method-post {
		background: #49cc90;
	}

	.method-put {
		background: #fca130;
	}

	.method-delete {
		background: #f93e3e;
	}

	.method-patch {
		background: #50e3c2;
	}

	.method-options, .method-head {
		background: #9012fe;
	}

	.box-title-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.box-path {
		font-size: 13px;
		color: #333;
		font-weight: 700;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 160px;
	}

	.box-summary {
		font-size: 11px;
		color: #666;
		font-weight: 500;
		margin-top: 2px;
		display: block;
		word-break: break-word;
	}

	.box-section {
		margin-top: 6px;
		width: 100%;
		padding: 0;
	}

	.section-label {
		font-size: 10px;
		font-weight: 700;
		color: #999;
		letter-spacing: 1px;
		text-transform: uppercase;
		display: block;
		margin-bottom: 2px;
	}

	.param-empty {
		font-size: 11px;
		color: #999;
		font-weight: 500;
	}

	.param-row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 3px;
		width: 100%;
	}

	.param-label {
		font-size: 11px;
		font-weight: 700;
		color: #333;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex-shrink: 0;
		max-width: 45%;
	}

	.param-label.param-required {
		color: #e53935;
	}

	.param-input {
		flex: 1;
		min-width: 0;
		padding: 2px 6px;
		font-size: 11px;
		font-family: 'Roboto', sans-serif;
		border: 1px solid #ccc;
		border-radius: 4px;
		background: #f9f9f9;
		color: #333;
		outline: none;
		transition: border-color 0.2s;
	}

	.param-input:focus {
		border-color: #61affe;
	}

	.param-input::placeholder {
		color: #bbb;
		font-size: 10px;
		font-style: italic;
	}

	.param-checkbox {
		accent-color: #49cc90;
		width: 14px;
		height: 14px;
		cursor: pointer;
	}

	.param-file {
		flex: 1;
		min-width: 0;
		font-size: 10px;
		font-family: 'Roboto', sans-serif;
		color: #333;
	}

	.param-field {
		display: flex;
		gap: 6px;
		font-size: 11px;
		padding: 1px 0;
	}

	.param-name {
		color: #333;
		font-weight: 700;
	}

	.param-name.param-required {
		color: #e53935;
	}

	.param-type {
		color: #888;
		font-family: monospace;
		font-size: 10px;
	}

	.param-content-type {
		font-size: 10px;
		color: #aaa;
		display: block;
		margin-bottom: 2px;
	}

	.box-responses {
		margin-top: 8px;
		width: 100%;
		padding: 0;
	}

	.box-response {
		background: #f4f4f4;
		border-radius: 4px;
		padding: 4px 8px;
		margin-top: 4px;
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
	}

	.resp-status {
		font-size: 11px;
		font-weight: 700;
		color: #49cc90;
	}

	.resp-type {
		font-size: 10px;
		color: #888;
	}

	.resp-field {
		font-size: 10px;
		color: #555;
		font-family: monospace;
		width: 100%;
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
		font-size: 15px;
		margin: 0;
		font-weight: 700;
	}

	.modal-actions {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.modal-btn {
		padding: 7px 16px;
		border-radius: 8px;
		font-size: 14px;
		font-weight: 700;
		cursor: pointer;
		transition: background 0.2s, border-color 0.2s;
		font-family: 'Roboto', sans-serif;
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
