<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { untrack } from 'svelte';
	import { animate } from 'animejs';
	import { parseOpenAPI } from '$lib/openapi';

	import type { OpenAPIEndpoint } from '$lib/openapi';

	interface Box {
		id: number;
		x: number;
		y: number;
		endpoint?: OpenAPIEndpoint;
		inputValues: Record<string, string>;
		specUrl: string;
		builtRequest?: Record<string, unknown>;
		workflowStatus: 'idle' | 'loading' | 'ready' | 'error';
		workflowError?: string;
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
			boxes = (data.boxes ?? []).map((b: Record<string, unknown>) => ({
				...b,
				specUrl: b.specUrl ?? '',
				workflowStatus: b.builtRequest ? 'ready' : 'idle',
				workflowError: undefined
			}));
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
					boxes = (data.boxes ?? []).map((b: Record<string, unknown>) => ({
						...b,
						specUrl: b.specUrl ?? '',
						workflowStatus: b.builtRequest ? 'ready' : 'idle',
						workflowError: undefined
					}));
					connections = data.connections ?? [];
					nextId = data.nextId ?? 1;
					showControls = false;
					boxFiles = {};
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
		boxes.push({ id, x: 80 + offset, y: 80 + offset, inputValues: {}, specUrl: '', workflowStatus: 'idle' });
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
					inputValues: initValues,
					specUrl: testSpecUrl.trim(),
					workflowStatus: 'idle'
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

	const BOX_SIZE = 280;
	const DOT_OFFSET = 6;

	function clamp(val: number, min: number, max: number) {
		return Math.max(min, Math.min(max, val));
	}

	function getOutputPos(box: Box) {
		const el = boxEls[box.id];
		const h = el ? el.offsetHeight : BOX_SIZE;
		return { x: box.x + BOX_SIZE + DOT_OFFSET, y: box.y + h / 2 };
	}

	function getInputPos(box: Box) {
		const el = boxEls[box.id];
		const h = el ? el.offsetHeight : BOX_SIZE;
		return { x: box.x, y: box.y + h / 2 };
	}

	// --- Box file handling (non-persistable) ---
	let boxFiles = $state<Record<number, Record<string, File>>>({});

	function boxHandleFile(boxId: number, paramName: string, e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			if (!boxFiles[boxId]) boxFiles[boxId] = {};
			boxFiles[boxId][paramName] = file;
			const box = boxes.find(b => b.id === boxId);
			if (box) box.inputValues[paramName] = `@${file.name}`;
		}
	}

	function boxRemoveFile(boxId: number, paramName: string) {
		if (boxFiles[boxId]) {
			const { [paramName]: _, ...rest } = boxFiles[boxId];
			boxFiles[boxId] = rest;
		}
		const box = boxes.find(b => b.id === boxId);
		if (box) box.inputValues[paramName] = '';
	}

	async function prepararBox(box: Box) {
		if (!box.endpoint || !box.specUrl) return;
		box.workflowStatus = 'loading';
		box.workflowError = undefined;
		try {
			const resp = await fetch(`${MANIFIESTO_API}/manifiesto`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					openapi_url: box.specUrl,
					endpoint_path: box.endpoint.path,
					method: box.endpoint.method.toUpperCase()
				})
			});
			if (!resp.ok) {
				let detail = `Error ${resp.status}: ${resp.statusText}`;
				try {
					const body = await resp.json();
					if (body.detail) {
						detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail, null, 2);
					}
				} catch {}
				throw new Error(detail);
			}
			box.builtRequest = await resp.json();
			box.workflowStatus = 'ready';
			box.workflowError = undefined;
		} catch (err: any) {
			box.workflowStatus = 'error';
			box.workflowError = err.message || 'Error desconocido';
		}
	}

	function downloadBuiltRequest(box: Box) {
		if (!box.builtRequest) return;
		const blob = new Blob([JSON.stringify(box.builtRequest, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `built-request-${box.id}.json`;
		a.click();
		URL.revokeObjectURL(url);
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
	let pruebasSubtab = $state<'manifiesto' | 'carga' | 'llena' | 'construye' | 'blackbox'>('manifiesto');
	let subtabUnlocked = $state<Record<string, boolean>>({ manifiesto: true, carga: true, construye: true, llena: false, blackbox: false });

	// Subtab flow diagram
	let subtabsWrapperEl: HTMLDivElement;
	let subtabsSvgEl: SVGSVGElement;
	let subtabEls = $state<Record<string, HTMLButtonElement | undefined>>({});

	function drawSubtabLines() {
		if (!subtabsSvgEl) return;
		// Wait until all buttons are mounted
		const keys = ['manifiesto', 'carga', 'llena', 'blackbox', 'construye'];
		if (keys.some(k => !subtabEls[k])) return;

		const svgRect = subtabsSvgEl.getBoundingClientRect();
		subtabsSvgEl.setAttribute('width', String(svgRect.width));
		subtabsSvgEl.setAttribute('height', String(svgRect.height));
		subtabsSvgEl.innerHTML = '';

		// Arrow marker
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
		marker.setAttribute('id', 'subtab-arrow');
		marker.setAttribute('viewBox', '0 0 10 6');
		marker.setAttribute('refX', '9');
		marker.setAttribute('refY', '3');
		marker.setAttribute('markerWidth', '8');
		marker.setAttribute('markerHeight', '6');
		marker.setAttribute('orient', 'auto');
		const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		arrowPath.setAttribute('d', 'M0,0 L10,3 L0,6');
		arrowPath.setAttribute('fill', 'rgba(255,255,255,0.4)');
		marker.appendChild(arrowPath);
		defs.appendChild(marker);
		subtabsSvgEl.appendChild(defs);

		const edges: [string, string][] = [
			['manifiesto', 'llena'],
			['carga', 'llena'],
			['llena', 'blackbox'],
			['construye', 'blackbox']
		];

		const GAP = 10; // px gap before target button so arrowhead stays visible

		for (const [from, to] of edges) {
			const a = subtabEls[from];
			const b = subtabEls[to];
			if (!a || !b) continue;
			const ar = a.getBoundingClientRect();
			const br = b.getBoundingClientRect();
			const x1 = ar.right - svgRect.left;
			const y1 = ar.top + ar.height / 2 - svgRect.top;
			const x2 = br.left - svgRect.left - GAP;
			const y2 = br.top + br.height / 2 - svgRect.top;
			const dx = Math.abs(x2 - x1) * 0.6;
			const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
			path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`);
			path.setAttribute('marker-end', 'url(#subtab-arrow)');
			subtabsSvgEl.appendChild(path);
		}
	}

	$effect(() => {
		// re-run when tab becomes active
		if (activeTab === 'pruebas') {
			// tick to ensure DOM is rendered
			requestAnimationFrame(drawSubtabLines);
		}
	});

	let manifiestoUrl = $state('https://moibe-rad.hf.space/openapi.json');
	let manifiestoPath = $state('');
	let manifiestoMethod = $state('');
	let manifiestoResult = $state<object | null>(null);
	let manifiestoLoading = $state(false);
	let manifiestoError = $state('');

	// --- Pruebas: Carga Manifiesto ---
	let cargaError = $state('');
	let cargaFile = $state<File | null>(null);
	let cargaFileInput: HTMLInputElement;

	function cargarManifiesto(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		cargaError = '';
		cargaFile = file;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const text = reader.result as string;
				const parsed = JSON.parse(text);
				// Validate manifiesto structure
				if (!parsed.url || !parsed.method || !Array.isArray(parsed.parameters)) {
					cargaError = 'El JSON no tiene estructura de manifiesto. Se requieren al menos: url, method y parameters.';
					cargaFile = null;
					return;
				}
				llenaTemplate = text;
				llenaFromCarga = true;
				subtabUnlocked.llena = true;
				pruebasSubtab = 'llena';
			} catch {
				cargaError = 'El archivo no contiene JSON válido.';
				cargaFile = null;
			}
		};
		reader.onerror = () => { cargaError = 'Error al leer el archivo.'; cargaFile = null; };
		reader.readAsText(file);
	}

	function cargaRemoveFile() {
		cargaFile = null;
		cargaError = '';
		if (cargaFileInput) cargaFileInput.value = '';
	}

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
			llenaFromCarga = false;
			// Detect body_type: first from dropdown selection, then from parser
			let detectedCt = pruebasSelectedEp?.content_type;
			if (!detectedCt) {
				try {
					const parsed = await parseOpenAPI(manifiestoUrl.trim(), manifiestoPath.trim(), manifiestoMethod.trim());
					detectedCt = parsed.endpoints[0]?.request_body?.content_type;
				} catch { /* fallback to json */ }
			}
			if (detectedCt) {
				if (detectedCt.includes('multipart')) llenaBodyType = 'multipart';
				else if (detectedCt.includes('form-urlencoded')) llenaBodyType = 'form';
				else llenaBodyType = 'json';
			} else {
				llenaBodyType = 'json';
			}

			// Navigate to Llena subtab
			subtabUnlocked.llena = true;
			pruebasSubtab = 'llena';
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
	interface LlenaParam {
		name: string;
		location: string;
		type: string;
		required: boolean;
		description?: string | null;
	}

	let llenaTemplate = $state('');
	let llenaTemplateEl: HTMLTextAreaElement;
	let llenaFromCarga = $state(false);
	let llenaBodyType = $state('json');
	let llenaParamValues = $state<Record<string, string>>({});
	let llenaFiles = $state<Record<string, File>>({});
	let llenaResult = $state<object | null>(null);
	let llenaLoading = $state(false);
	let llenaError = $state('');

	let llenaParams = $derived.by<LlenaParam[]>(() => {
		if (!llenaTemplate.trim()) return [];
		try {
			const t = JSON.parse(llenaTemplate.trim());
			return Array.isArray(t.parameters) ? t.parameters : [];
		} catch { return []; }
	});

	function isFileParam(param: LlenaParam): boolean {
		return param.type === 'file' ||
			param.type === 'binary' ||
			(param.location === 'body' && llenaBodyType === 'multipart');
	}

	$effect(() => {
		const keys = llenaParams.map((p: LlenaParam) => p.name);
		const prev = untrack(() => llenaParamValues);
		const prevFiles = untrack(() => llenaFiles);
		const next: Record<string, string> = {};
		keys.forEach((k: string) => { next[k] = prev[k] ?? ''; });
		llenaParamValues = next;
		// Clean up files for params that no longer exist
		const paramNames = new Set(keys);
		const cleanedFiles: Record<string, File> = {};
		Object.keys(prevFiles).forEach(k => { if (paramNames.has(k)) cleanedFiles[k] = prevFiles[k]; });
		llenaFiles = cleanedFiles;
	});

	$effect(() => {
		llenaTemplate;
		tick().then(() => { if (llenaTemplateEl) { llenaTemplateEl.style.height = 'auto'; llenaTemplateEl.style.height = (llenaTemplateEl.scrollHeight + 4) + 'px'; } });
	});

	function llenaHandleFile(paramName: string, e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			llenaFiles = { ...llenaFiles, [paramName]: file };
			llenaParamValues[paramName] = `@${file.name}`;
		}
	}

	function llenaRemoveFile(paramName: string) {
		const { [paramName]: _, ...rest } = llenaFiles;
		llenaFiles = rest;
		llenaParamValues[paramName] = '';
	}

	async function ejecutarLlena() {
		if (!llenaTemplate.trim()) {
			llenaError = 'Plantilla vacía.';
			return;
		}
		const missing = llenaParams
			.filter((p: LlenaParam) => p.required && !(llenaParamValues[p.name] ?? '').trim())
			.map((p: LlenaParam) => p.name);
		if (missing.length) {
			llenaError = `Campos obligatorios vacíos: ${missing.join(', ')}`;
			return;
		}
		llenaLoading = true;
		llenaError = '';
		llenaResult = null;
		try {
			const template = JSON.parse(llenaTemplate.trim());
			const values: Record<string, unknown> = {};
			llenaParams.forEach((p: LlenaParam) => {
				const raw = llenaParamValues[p.name] ?? '';
				if (raw === '') return;
				if (p.type === 'integer' || p.type === 'number') values[p.name] = Number(raw);
				else if (p.type === 'boolean') values[p.name] = raw === 'true';
				else values[p.name] = raw;
			});
			const resp = await fetch(`${MANIFIESTO_API}/llena`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ template, body_type: llenaBodyType, values })
			});
			if (!resp.ok) {
				let detail = `Error ${resp.status}: ${resp.statusText}`;
				try {
					const body = await resp.json();
					if (body.detail) {
						detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail, null, 2);
					}
				} catch {}
				throw new Error(detail);
			}
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

	// --- Pruebas: Construye ---
	let construyeUrl = $state('https://moibe-rad.hf.space/openapi.json');
	let construyePath = $state('');
	let construyeMethod = $state('');
	let construyeBodyType = $state('json');
	let construyeTemplate = $state('');  // hidden, fetched silently for param parsing
	let construyeParamValues = $state<Record<string, string>>({});
	let construyeFiles = $state<Record<string, File>>({});
	let construyeResult = $state<object | null>(null);
	let construyeLoading = $state(false);
	let construyeError = $state('');
	let construyeEndpoints = $state<Array<{path: string; method: string; summary?: string; content_type?: string}>>([]);
	let construyeDropdownOpen = $state(false);
	let construyeSelectedEp = $state<{path: string; method: string; summary?: string; content_type?: string} | null>(null);

	let construyeParams = $derived.by<LlenaParam[]>(() => {
		if (!construyeTemplate.trim()) return [];
		try {
			const t = JSON.parse(construyeTemplate.trim());
			return Array.isArray(t.parameters) ? t.parameters : [];
		} catch { return []; }
	});

	function isConstruyeFileParam(param: LlenaParam): boolean {
		return param.type === 'file' ||
			param.type === 'binary' ||
			(param.location === 'body' && construyeBodyType === 'multipart');
	}

	$effect(() => {
		const keys = construyeParams.map((p: LlenaParam) => p.name);
		const prev = untrack(() => construyeParamValues);
		const prevFiles = untrack(() => construyeFiles);
		const next: Record<string, string> = {};
		keys.forEach((k: string) => { next[k] = prev[k] ?? ''; });
		construyeParamValues = next;
		const paramNames = new Set(keys);
		const cleanedFiles: Record<string, File> = {};
		Object.keys(prevFiles).forEach(k => { if (paramNames.has(k)) cleanedFiles[k] = prevFiles[k]; });
		construyeFiles = cleanedFiles;
	});

	function construyeHandleFile(paramName: string, e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			construyeFiles = { ...construyeFiles, [paramName]: file };
			construyeParamValues[paramName] = `@${file.name}`;
		}
	}

	function construyeRemoveFile(paramName: string) {
		const { [paramName]: _, ...rest } = construyeFiles;
		construyeFiles = rest;
		construyeParamValues[paramName] = '';
	}

	async function listarEndpointsConstruye() {
		if (!construyeUrl.trim()) return;
		try {
			const result = await parseOpenAPI(construyeUrl.trim());
			construyeEndpoints = result.endpoints.map(ep => ({ path: ep.path, method: ep.method, summary: ep.summary, content_type: ep.request_body?.content_type }));
			construyePath = '';
			construyeMethod = '';
			construyeSelectedEp = null;
			construyeDropdownOpen = false;
			construyeTemplate = '';
		} catch (error) {
			console.error('Error listando endpoints (construye):', error);
		}
	}

	async function selectConstruyeEndpoint(ep: {path: string; method: string; summary?: string; content_type?: string}) {
		construyeSelectedEp = ep;
		construyePath = ep.path;
		construyeMethod = ep.method;
		construyeDropdownOpen = false;
		// Auto-detect body_type
		if (ep.content_type) {
			if (ep.content_type.includes('multipart')) construyeBodyType = 'multipart';
			else if (ep.content_type.includes('form-urlencoded')) construyeBodyType = 'form';
			else construyeBodyType = 'json';
		}
		// Silently fetch template to get parameter list
		try {
			const resp = await fetch(`${MANIFIESTO_API}/manifiesto`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ openapi_url: construyeUrl.trim(), endpoint_path: ep.path, method: ep.method.toUpperCase() })
			});
			if (resp.ok) {
				const tmpl = await resp.json();
				construyeTemplate = JSON.stringify(tmpl, null, 2);
			}
		} catch (err) {
			console.error('Error obteniendo template para construye:', err);
		}
	}

	async function ejecutarConstruye() {
		if (!construyeUrl.trim() || !construyePath.trim() || !construyeMethod.trim()) {
			construyeError = 'Completa URL, endpoint y método.';
			return;
		}
		const missing = construyeParams
			.filter((p: LlenaParam) => p.required && !(construyeParamValues[p.name] ?? '').trim())
			.map((p: LlenaParam) => p.name);
		if (missing.length) {
			construyeError = `Campos obligatorios vacíos: ${missing.join(', ')}`;
			return;
		}
		construyeLoading = true;
		construyeError = '';
		construyeResult = null;
		try {
			const values: Record<string, unknown> = {};
			construyeParams.forEach((p: LlenaParam) => {
				const raw = construyeParamValues[p.name] ?? '';
				if (raw === '') return;
				if (p.type === 'integer' || p.type === 'number') values[p.name] = Number(raw);
				else if (p.type === 'boolean') values[p.name] = raw === 'true';
				else values[p.name] = raw;
			});
			const payload: Record<string, unknown> = {
				openapi_url: construyeUrl.trim(),
				endpoint_path: construyePath.trim(),
				method: construyeMethod.trim().toUpperCase(),
				body_type: construyeBodyType
			};
			if (Object.keys(values).length > 0) payload.values = values;
			const resp = await fetch(`${MANIFIESTO_API}/construye`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!resp.ok) throw new Error(`Error ${resp.status}: ${resp.statusText}`);
			construyeResult = await resp.json();

			// Auto-populate Api Blackbox
			bbManifiesto = JSON.stringify(construyeResult, null, 2);
			bbFiles = { ...construyeFiles };
		} catch (err: any) {
			construyeError = err.message || 'Error desconocido';
		} finally {
			construyeLoading = false;
		}
	}

	function descargarConstruye() {
		if (!construyeResult) return;
		const blob = new Blob([JSON.stringify(construyeResult, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'manifiesto-construido.json';
		a.click();
		URL.revokeObjectURL(url);
	}

	// --- Pruebas: Api Blackbox ---
	let bbManifiesto = $state('');
	let bbManifiestoEl: HTMLTextAreaElement;
	let bbFiles = $state<Record<string, File>>({});
	let bbResult = $state<object | string | null>(null);
	let bbResultType = $state<'json' | 'image' | 'text'>('json');
	let bbResultImageUrl = $state('');
	let bbLoading = $state(false);
	let bbError = $state('');
	let bbFileInput: HTMLInputElement;

	// Auto-populate from Llena result
	$effect(() => {
		if (llenaResult) {
			bbManifiesto = JSON.stringify(llenaResult, null, 2);
			bbFiles = { ...untrack(() => llenaFiles) };
		}
	});

	$effect(() => {
		bbManifiesto;
		tick().then(() => { if (bbManifiestoEl) { bbManifiestoEl.style.height = 'auto'; bbManifiestoEl.style.height = (bbManifiestoEl.scrollHeight + 4) + 'px'; } });
	});

	function bbHandleFile(fieldName: string, e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (file) {
			bbFiles = { ...bbFiles, [fieldName]: file };
		}
	}

	function bbRemoveFile(fieldName: string) {
		const { [fieldName]: _, ...rest } = bbFiles;
		bbFiles = rest;
	}

	const BLACKBOX_API = 'https://moibe-api-blackbox.hf.space';

	async function bbEjecutar() {
		if (!bbManifiesto.trim()) {
			bbError = 'Pega el manifiesto lleno.';
			return;
		}
		bbLoading = true;
		bbError = '';
		bbResult = null;
		bbResultImageUrl = '';
		try {
			const fd = new FormData();
			fd.append('manifest', bbManifiesto.trim());

			// Add files as 'items'
			const m = JSON.parse(bbManifiesto.trim());
			if (m.files) {
				for (const fref of m.files as Array<{field_name: string; filename: string}>) {
					const file = bbFiles[fref.field_name];
					if (file) {
						fd.append('items', file, fref.filename);
					}
				}
			}

			const resp = await fetch(`${BLACKBOX_API}/procesador`, {
				method: 'POST',
				body: fd
			});

			// Detect response type
			const ct = resp.headers.get('Content-Type') ?? '';
			if (ct.includes('image/')) {
				const blob = await resp.blob();
				bbResultImageUrl = URL.createObjectURL(blob);
				bbResultType = 'image';
				bbResult = { status: resp.status, content_type: ct };
			} else if (ct.includes('application/json')) {
				bbResult = await resp.json();
				bbResultType = 'json';
			} else {
				bbResult = await resp.text();
				bbResultType = 'text';
			}
		} catch (err: any) {
			bbError = err.message || 'Error desconocido';
		} finally {
			bbLoading = false;
		}
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
						<span class="ep-badge method-{selectedEndpoint.method.toLowerCase()}">{selectedEndpoint.method.toUpperCase()}</span><span class="ep-trigger-path">{selectedEndpoint.path}</span>
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
									{#if boxFiles[box.id]?.[`body_${key}`]}
										<!-- svelte-ignore a11y_no_static_element_interactions -->
										<span class="box-file-info" onpointerdown={(e) => e.stopPropagation()}>
											<span class="box-file-name">{boxFiles[box.id][`body_${key}`].name}</span>
											<span class="box-file-size">{(boxFiles[box.id][`body_${key}`].size / 1024).toFixed(1)}KB</span>
											<button class="box-file-remove" onclick={() => boxRemoveFile(box.id, `body_${key}`)} onpointerdown={(e) => e.stopPropagation()}>&times;</button>
										</span>
									{:else}
										<label class="box-file-btn" onpointerdown={(e) => e.stopPropagation()}>
											Archivo
											<input type="file" class="box-file-hidden" onchange={(e) => boxHandleFile(box.id, `body_${key}`, e)} />
										</label>
									{/if}
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

				<button
					class="box-preparar"
					class:loading={box.workflowStatus === 'loading'}
					disabled={box.workflowStatus === 'loading'}
					onclick={() => prepararBox(box)}
					onpointerdown={(e) => e.stopPropagation()}
				>
					{#if box.workflowStatus === 'loading'}
						Preparando…
					{:else}
						Preparar
					{/if}
				</button>
			</div>
		{#if box.workflowStatus === 'ready'}
				<span class="box-status-badge box-status-ready" title="Listo para Api Blackbox">✓</span>
				<button class="box-download-badge" title="Descargar JSON construido" onclick={() => downloadBuiltRequest(box)} onpointerdown={(e) => e.stopPropagation()}>↓</button>
			{:else if box.workflowStatus === 'error'}
				<span class="box-status-badge box-status-error" title={box.workflowError ?? 'Error'}>✗</span>
			{:else if box.workflowStatus === 'loading'}
				<span class="box-status-badge box-status-loading">⟳</span>
			{/if}
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
	<div class="subtabs-wrapper" bind:this={subtabsWrapperEl}>
		<svg class="subtabs-lines" bind:this={subtabsSvgEl}></svg>
		<div class="subtabs-flow">
			<div class="subtab-node-wrapper subtab-grid-manifiesto">
				<button class="subtab-node" class:active={pruebasSubtab === 'manifiesto'} onclick={() => pruebasSubtab = 'manifiesto'} bind:this={subtabEls['manifiesto']}>Crea Manifiesto</button>
				<span class="subtab-info"><span class="subtab-tooltip">Genera una plantilla de manifiesto a partir de una especificación OpenAPI. Selecciona el endpoint y obtén la estructura base para llenar.</span></span>
			</div>
			<div class="subtab-node-wrapper subtab-grid-carga">
				<button class="subtab-node" class:active={pruebasSubtab === 'carga'} onclick={() => pruebasSubtab = 'carga'} bind:this={subtabEls['carga']}>Carga Manifiesto</button>
				<span class="subtab-info"><span class="subtab-tooltip">Carga un manifiesto existente desde un archivo JSON. Útil para reutilizar plantillas previamente generadas.</span></span>
			</div>
			<div class="subtab-node-wrapper subtab-grid-llena">
				<button class="subtab-node" class:active={pruebasSubtab === 'llena'} class:locked={!subtabUnlocked.llena} onclick={() => { if (subtabUnlocked.llena) pruebasSubtab = 'llena'; }} bind:this={subtabEls['llena']}>Llena</button>
				<span class="subtab-info"><span class="subtab-tooltip">Rellena la plantilla con valores reales para cada parámetro. Soporta archivos, texto, números y booleanos.</span></span>
			</div>
			<div class="subtab-node-wrapper subtab-grid-construye">
				<button class="subtab-node" class:active={pruebasSubtab === 'construye'} onclick={() => pruebasSubtab = 'construye'} bind:this={subtabEls['construye']}>Construye</button>
				<span class="subtab-info"><span class="subtab-tooltip">Modo express: combina Crea Manifiesto y Llena en un solo paso. Genera el manifiesto completo directamente desde la especificación.</span></span>
			</div>
			<div class="subtab-node-wrapper subtab-grid-blackbox">
				<button class="subtab-node" class:active={pruebasSubtab === 'blackbox'} class:locked={!subtabUnlocked.blackbox} onclick={() => { if (subtabUnlocked.blackbox) pruebasSubtab = 'blackbox'; }} bind:this={subtabEls['blackbox']}>Api Blackbox</button>
				<span class="subtab-info"><span class="subtab-tooltip">Ejecuta el manifiesto completo contra la API real. Actúa como proxy que procesa la petición y devuelve la respuesta.</span></span>
			</div>
		</div>
	</div>

	<div class="pruebas-content">
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
								<span class="ep-badge method-{pruebasSelectedEp.method.toLowerCase()}">{pruebasSelectedEp.method.toUpperCase()}</span><span class="ep-trigger-path">{pruebasSelectedEp.path}</span>
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

	{#if pruebasSubtab === 'carga'}
	<div class="pruebas-form">
		<div class="llena-params">
			<div class="llena-param-row">
				<div class="llena-param-meta">
					<span class="llena-param-name">manifiesto</span>
					<span class="llena-param-loc">FILE</span>
					<span class="llena-param-type">json</span>
					<span class="llena-param-req">*</span>
				</div>
				<div class="llena-file-area">
					{#if cargaFile}
						<span class="llena-file-info">
							<span class="bb-file-name">{cargaFile.name}</span>
							<span class="bb-file-size">{(cargaFile.size / 1024).toFixed(1)} KB</span>
							<button class="bb-file-remove" onclick={cargaRemoveFile}>&times;</button>
						</span>
					{:else}
						<label class="llena-file-btn">
							Seleccionar archivo
							<input type="file" accept=".json,application/json" class="bb-file-input" bind:this={cargaFileInput} onchange={cargarManifiesto} />
						</label>
					{/if}
				</div>
			</div>
		</div>
		{#if cargaError}
			<div class="pruebas-error">{cargaError}</div>
		{/if}
	</div>
	{/if}

	{#if pruebasSubtab === 'llena'}
	<div class="pruebas-form">
		<div class="pruebas-row">
			<span class="pruebas-label">Plantilla (JSON de /manifiesto)</span>
			<textarea class="pruebas-textarea" bind:this={llenaTemplateEl} bind:value={llenaTemplate} placeholder='Pega aquí el JSON de la plantilla...' rows="4" oninput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = (t.scrollHeight + 4) + 'px'; }}></textarea>
			{#if llenaTemplate.trim() && !llenaFromCarga}
				<button class="btn-io" style="margin-top: 6px;" onclick={() => { const blob = new Blob([llenaTemplate], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'plantilla-manifiesto.json'; a.click(); URL.revokeObjectURL(url); }}>⬇ Descargar Plantilla</button>
			{/if}
		</div>
		<div class="pruebas-row">
			<span class="pruebas-label">Body Type</span>
			<span class="pruebas-badge-bodytype">{llenaBodyType}</span>
		</div>
		{#if llenaParams.length > 0}
		<div class="pruebas-row">
			<span class="pruebas-label">Values</span>
			<div class="llena-params">
				{#each llenaParams as param}
				<div class="llena-param-row">
					<div class="llena-param-meta">
						<span class="llena-param-name">{param.name}</span>
						<span class="llena-param-loc">{param.location}</span>
						<span class="llena-param-type">{param.type}</span>
						{#if param.required}<span class="llena-param-req">*</span>{/if}
					</div>
					{#if param.type === 'boolean'}
						<select class="llena-input" bind:value={llenaParamValues[param.name]}>
							<option value="">—</option>
							<option value="true">true</option>
							<option value="false">false</option>
						</select>
					{:else if param.type === 'integer' || param.type === 'number'}
						<input class="llena-input" type="number" bind:value={llenaParamValues[param.name]} placeholder="0" />
					{:else if isFileParam(param)}
						<div class="llena-file-area">
							{#if llenaFiles[param.name]}
								<span class="llena-file-info">
									<span class="bb-file-name">{llenaFiles[param.name].name}</span>
									<span class="bb-file-size">{(llenaFiles[param.name].size / 1024).toFixed(1)} KB</span>
									<button class="bb-file-remove" onclick={() => llenaRemoveFile(param.name)}>&times;</button>
								</span>
							{:else}
								<label class="llena-file-btn">
									Seleccionar archivo
									<input type="file" class="bb-file-input" onchange={(e) => llenaHandleFile(param.name, e)} />
								</label>
							{/if}
						</div>
					{:else}
						<input class="llena-input" type="text" bind:value={llenaParamValues[param.name]} placeholder={param.description ?? ''} />
					{/if}
				</div>
				{/each}
			</div>
		</div>
		{:else if llenaTemplate.trim()}
		<p class="pruebas-empty">La plantilla no tiene parámetros.</p>
		{/if}
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
			<div class="pruebas-actions">
				<button class="btn-manifiesto" onclick={() => { subtabUnlocked.blackbox = true; pruebasSubtab = 'blackbox'; }}>Enviar a Api Blackbox</button>
			</div>
		{/if}
	</div>
	{/if}

	{#if pruebasSubtab === 'blackbox'}
	<div class="pruebas-form">
		<div class="pruebas-row">
			<span class="pruebas-label">Manifiesto (JSON lleno)</span>
			<textarea class="pruebas-textarea" bind:this={bbManifiestoEl} bind:value={bbManifiesto} placeholder='Pega aquí el manifiesto completo...' rows="4" oninput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = (t.scrollHeight + 4) + 'px'; }}></textarea>
		</div>
		{#if bbManifiesto.trim()}
		{@const parsed = (() => { try { return JSON.parse(bbManifiesto.trim()); } catch { return null; } })()}
		{#if parsed?.files?.length > 0}
		<div class="pruebas-row">
			<span class="pruebas-label">Archivos ({parsed.files.length})</span>
			<div class="llena-params">
				{#each parsed.files as fref}
				<div class="llena-param-row">
					<div class="llena-param-meta">
						<span class="llena-param-name">{fref.field_name}</span>
						<span class="llena-param-loc">file</span>
						<span class="llena-param-type">{fref.filename}</span>
					</div>
					<div class="llena-file-area">
						{#if bbFiles[fref.field_name]}
							<span class="llena-file-info">
								<span class="bb-file-name">{bbFiles[fref.field_name].name}</span>
								<span class="bb-file-size">{(bbFiles[fref.field_name].size / 1024).toFixed(1)} KB</span>
								<button class="bb-file-remove" onclick={() => bbRemoveFile(fref.field_name)}>&times;</button>
							</span>
						{:else}
							<label class="llena-file-btn">
								Seleccionar archivo
								<input type="file" class="bb-file-input" onchange={(e) => bbHandleFile(fref.field_name, e)} />
							</label>
						{/if}
					</div>
				</div>
				{/each}
			</div>
		</div>
		{/if}
		{/if}
		<div class="pruebas-actions">
			<button class="btn-manifiesto" onclick={bbEjecutar} disabled={bbLoading}>
				{bbLoading ? 'Ejecutando...' : 'Ejecutar'}
			</button>
		</div>
		{#if bbError}
			<div class="pruebas-error">{bbError}</div>
		{/if}
		{#if bbResult}
			<span class="pruebas-label" style="margin-top: 16px;">Resultado</span>
		{/if}
		{#if bbResult && bbResultType === 'image'}
			<div class="bb-response-image">
				<img src={bbResultImageUrl} alt="Response" />
			</div>
		{/if}
		{#if bbResult && bbResultType === 'json'}
			<pre class="pruebas-json">{JSON.stringify(bbResult, null, 2)}</pre>
		{/if}
		{#if bbResult && bbResultType === 'text'}
			<pre class="pruebas-json">{bbResult}</pre>
		{/if}
	</div>
	{/if}

	{#if pruebasSubtab === 'construye'}
	<div class="pruebas-form">
		<div class="pruebas-row">
			<span class="pruebas-label">OpenAPI URL</span>
			<input class="pruebas-input" bind:value={construyeUrl} placeholder="https://...openapi.json" />
		</div>
		<div class="pruebas-row">
			<span class="pruebas-label">Endpoint</span>
			<div class="pruebas-endpoint-row">
				<button class="btn-list btn-list--sm" onclick={listarEndpointsConstruye}>Listar</button>
				{#if construyeEndpoints.length > 0}
					<div class="ep-dropdown" class:open={construyeDropdownOpen}>
						<div class="ep-sizer" aria-hidden="true">
							{#each construyeEndpoints as ep}
								<div class="ep-option"><span class="ep-badge">{ep.method.toUpperCase()}</span><span>{ep.path}</span></div>
							{/each}
						</div>
						<button class="ep-trigger" onclick={() => construyeDropdownOpen = !construyeDropdownOpen}>
							{#if construyeSelectedEp}
								<span class="ep-badge method-{construyeSelectedEp.method.toLowerCase()}">{construyeSelectedEp.method.toUpperCase()}</span><span class="ep-trigger-path">{construyeSelectedEp.path}</span>
							{:else}
								<span class="ep-placeholder">— Seleccionar endpoint —</span>
							{/if}
							<span class="ep-arrow">{construyeDropdownOpen ? '▴' : '▾'}</span>
						</button>
						{#if construyeDropdownOpen}
							<div class="ep-list">
								{#each construyeEndpoints as ep}
									<button class="ep-option" onclick={() => selectConstruyeEndpoint(ep)}>
										<span class="ep-badge method-{ep.method.toLowerCase()}">{ep.method.toUpperCase()}</span>
										<span class="ep-option-path">{ep.path}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<input class="pruebas-input pruebas-input--short" bind:value={construyePath} placeholder="/endpoint" />
				{/if}
			</div>
		</div>
		<div class="pruebas-row">
			<span class="pruebas-label">Body Type</span>
			<span class="pruebas-badge-bodytype">{construyeBodyType}</span>
		</div>
		{#if construyeParams.length > 0}
		<div class="pruebas-row">
			<span class="pruebas-label">Values</span>
			<div class="llena-params">
				{#each construyeParams as param}
				<div class="llena-param-row">
					<div class="llena-param-meta">
						<span class="llena-param-name">{param.name}</span>
						<span class="llena-param-loc">{param.location}</span>
						<span class="llena-param-type">{param.type}</span>
						{#if param.required}<span class="llena-param-req">*</span>{/if}
					</div>
					{#if param.type === 'boolean'}
						<select class="llena-input" bind:value={construyeParamValues[param.name]}>
							<option value="">—</option>
							<option value="true">true</option>
							<option value="false">false</option>
						</select>
					{:else if param.type === 'integer' || param.type === 'number'}
						<input class="llena-input" type="number" bind:value={construyeParamValues[param.name]} placeholder="0" />
					{:else if isConstruyeFileParam(param)}
						<div class="llena-file-area">
							{#if construyeFiles[param.name]}
								<span class="llena-file-info">
									<span class="bb-file-name">{construyeFiles[param.name].name}</span>
									<span class="bb-file-size">{(construyeFiles[param.name].size / 1024).toFixed(1)} KB</span>
									<button class="bb-file-remove" onclick={() => construyeRemoveFile(param.name)}>&times;</button>
								</span>
							{:else}
								<label class="llena-file-btn">
									Seleccionar archivo
									<input type="file" class="bb-file-input" onchange={(e) => construyeHandleFile(param.name, e)} />
								</label>
							{/if}
						</div>
					{:else}
						<input class="llena-input" type="text" bind:value={construyeParamValues[param.name]} placeholder={param.description ?? ''} />
					{/if}
				</div>
				{/each}
			</div>
		</div>
		{:else if construyeSelectedEp && !construyeTemplate.trim()}
		<p class="pruebas-empty">Cargando parámetros...</p>
		{:else if construyeSelectedEp && construyeTemplate.trim()}
		<p class="pruebas-empty">El endpoint no tiene parámetros.</p>
		{/if}
		<div class="pruebas-actions">
			<button class="btn-manifiesto" onclick={ejecutarConstruye} disabled={construyeLoading}>
				{construyeLoading ? 'Construyendo...' : 'Construir'}
			</button>
			{#if construyeResult}
				<button class="btn-io" onclick={descargarConstruye}>⬇ Descargar JSON</button>
			{/if}
		</div>
		{#if construyeError}
			<div class="pruebas-error">{construyeError}</div>
		{/if}
		{#if construyeResult}
			<pre class="pruebas-json">{JSON.stringify(construyeResult, null, 2)}</pre>
			<div class="pruebas-actions">
				<button class="btn-manifiesto" onclick={() => { subtabUnlocked.blackbox = true; pruebasSubtab = 'blackbox'; }}>Enviar a Api Blackbox</button>
			</div>
		{/if}
	</div>
	{/if}
	</div>
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
		box-sizing: border-box;
		overflow: visible;
		padding: 30px 40px;
		display: flex;
		flex-direction: column;
	}

	.pruebas-content {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.subtabs-wrapper {
		flex-shrink: 0;
		z-index: 10;
		margin-bottom: 20px;
		width: fit-content;
	}

	.subtabs-flow {
		position: relative;
		display: grid;
		grid-template-columns: auto auto auto;
		grid-template-rows: auto auto auto;
		column-gap: 52px;
		row-gap: 22px;
		align-items: center;
	}

	.subtab-grid-manifiesto {
		grid-column: 1;
		grid-row: 1;
	}

	.subtab-grid-carga {
		grid-column: 1;
		grid-row: 2;
	}

	.subtab-grid-llena {
		grid-column: 2;
		grid-row: 1 / span 2;
		align-self: center;
	}

	.subtab-grid-construye {
		grid-column: 2;
		grid-row: 3;
	}

	.subtab-grid-blackbox {
		grid-column: 3;
		grid-row: 1 / span 3;
		align-self: center;
	}

	.subtabs-lines {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 1;
		overflow: visible;
	}

	.subtabs-lines :global(path) {
		stroke: rgba(255, 255, 255, 0.4);
		stroke-width: 1.5;
		fill: none;
	}

	.subtab-node-wrapper {
		position: relative;
		z-index: 2;
	}

	.subtab-node {
		padding: 6px 18px;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 10px;
		color: rgba(255, 255, 255, 0.5);
		font-family: 'Roboto', sans-serif;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.2s, color 0.2s, border-color 0.2s;
		white-space: nowrap;
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
	}

	.subtab-node:hover {
		background: rgba(255, 255, 255, 0.12);
		color: rgba(255, 255, 255, 0.8);
	}

	.subtab-node.active {
		background: rgba(255, 255, 255, 0.16);
		color: #fff;
		border-color: rgba(255, 255, 255, 0.3);
	}

	.subtab-node.locked {
		opacity: 0.35;
		cursor: not-allowed;
	}

	.subtab-node.locked:hover {
		background: rgba(255, 255, 255, 0.06);
		color: rgba(255, 255, 255, 0.5);
	}

	.subtab-info {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 1px solid rgba(255, 255, 255, 0.3);
		color: rgba(255, 255, 255, 0.4);
		font-size: 9px;
		font-weight: 700;
		position: absolute;
		top: -15px;
		right: -15px;
		cursor: default;
		line-height: 1;
		transition: border-color 0.2s, color 0.2s;
	}

	.subtab-grid-llena > .subtab-info {
		top: -5px;
		right: 0px;
	}

	.subtab-grid-construye > .subtab-info {
		top: -15px;
		right: -15px;
	}

	.subtab-info::before {
		content: 'i';
	}

	.subtab-info:hover {
		border-color: rgba(255, 255, 255, 0.7);
		color: rgba(255, 255, 255, 0.9);
	}

	.subtab-info:hover .subtab-tooltip {
		display: block;
	}

	.subtab-tooltip {
		display: none;
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		background: rgba(30, 15, 60, 0.95);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 8px;
		padding: 8px 12px;
		color: rgba(255, 255, 255, 0.85);
		font-size: 12px;
		font-weight: 400;
		white-space: normal;
		width: 200px;
		z-index: 100;
		line-height: 1.5;
		pointer-events: none;
		backdrop-filter: blur(12px);
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

	.bb-files-area {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.bb-file-input {
		display: none;
	}

	.bb-file-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.bb-file-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 12px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 6px;
	}

	.bb-file-name {
		color: white;
		font-family: 'Roboto', sans-serif;
		font-size: 13px;
		flex: 1;
	}

	.bb-file-size {
		color: rgba(255, 255, 255, 0.5);
		font-size: 11px;
		font-family: 'Roboto', sans-serif;
	}

	.bb-file-remove {
		background: rgba(255, 80, 80, 0.3);
		border: 1px solid rgba(255, 80, 80, 0.5);
		color: white;
		border-radius: 4px;
		width: 22px;
		height: 22px;
		cursor: pointer;
		font-size: 14px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.bb-file-remove:hover {
		background: rgba(255, 80, 80, 0.5);
	}

	.bb-files-empty {
		color: rgba(255, 255, 255, 0.35);
		font-family: 'Roboto', sans-serif;
		font-size: 12px;
		margin: 0;
	}

	.bb-response-image {
		border-radius: 8px;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.15);
		max-width: 100%;
	}

	.bb-response-image img {
		display: block;
		max-width: 100%;
		height: auto;
	}

	.llena-params {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}

	.llena-param-row {
		display: flex;
		align-items: center;
		gap: 10px;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 8px;
		padding: 8px 12px;
	}

	.llena-param-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 200px;
	}

	.llena-param-name {
		font-family: 'Roboto', sans-serif;
		font-size: 13px;
		font-weight: 600;
		color: white;
	}

	.llena-param-loc {
		font-size: 10px;
		font-family: 'Roboto', sans-serif;
		padding: 2px 6px;
		border-radius: 4px;
		background: rgba(100, 150, 255, 0.25);
		color: rgba(180, 200, 255, 0.9);
		text-transform: uppercase;
	}

	.llena-param-type {
		font-size: 10px;
		font-family: 'Roboto Mono', monospace;
		color: rgba(255, 255, 255, 0.4);
	}

	.llena-param-req {
		color: #ff6b6b;
		font-size: 14px;
		font-weight: 700;
	}

	.llena-input {
		flex: 1;
		padding: 6px 10px;
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 6px;
		color: white;
		font-family: 'Roboto', sans-serif;
		font-size: 13px;
		outline: none;
	}

	.llena-input:focus {
		border-color: rgba(255, 255, 255, 0.45);
		background: rgba(255, 255, 255, 0.12);
	}

	.llena-input option {
		background: #2a1a4a;
		color: white;
	}

	.llena-file-area {
		flex: 1;
		display: flex;
		align-items: center;
	}

	.llena-file-btn {
		padding: 6px 14px;
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 6px;
		color: rgba(255, 255, 255, 0.7);
		font-family: 'Roboto', sans-serif;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.2s;
	}

	.llena-file-btn:hover {
		background: rgba(255, 255, 255, 0.18);
		color: white;
	}

	.llena-file-info {
		display: flex;
		align-items: center;
		gap: 8px;
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
		resize: none;
		width: 100%;
		overflow: hidden;
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

	.pruebas-file-input {
		padding: 10px 14px;
		background: rgba(255, 255, 255, 0.08);
		color: white;
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 8px;
		font-size: 14px;
		font-family: 'Roboto', sans-serif;
		cursor: pointer;
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
		max-height: none;
		overflow-y: visible;
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
		width: 280px;
		min-height: 250px;
		height: auto;
		background: white;
		border-radius: 12px;
		cursor: grab;
		user-select: none;
		touch-action: none;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
	}

	.box-content {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: flex-start;
		overflow: hidden;
		overflow-y: auto;
		padding: 10px;
		max-height: 400px;
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

	/* --- Preparar button --- */
	.box-preparar {
		margin-top: 8px;
		width: 100%;
		padding: 6px 0;
		background: #7c3aed;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 11px;
		font-weight: 700;
		font-family: 'Roboto', sans-serif;
		cursor: pointer;
		transition: background 0.2s;
		letter-spacing: 0.3px;
	}

	.box-preparar:hover:not(:disabled) {
		background: #6d28d9;
	}

	.box-preparar:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.box-preparar.loading {
		background: #a78bfa;
		animation: pulse-preparar 1s ease-in-out infinite;
	}

	@keyframes pulse-preparar {
		0%, 100% { opacity: 0.7; }
		50% { opacity: 1; }
	}

	/* --- Status badge --- */
	.box-status-badge {
		position: absolute;
		top: -8px;
		right: 20px;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 700;
		z-index: 20;
		pointer-events: auto;
		border: 2px solid white;
	}

	.box-status-ready {
		background: #4caf50;
		color: white;
	}

	.box-download-badge {
		position: absolute;
		top: -8px;
		right: -6px;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 700;
		z-index: 20;
		background: #fff;
		border: 2px solid #2196f3;
		color: #2196f3;
		cursor: pointer;
		padding: 0;
		line-height: 1;
		transition: transform 0.15s;
	}

	.box-download-badge:hover {
		transform: scale(1.15);
	}

	.box-status-error {
		background: #f44336;
		color: white;
		cursor: help;
	}

	.box-status-loading {
		background: #a78bfa;
		color: white;
		animation: spin-badge 1s linear infinite;
	}

	@keyframes spin-badge {
		0% { transform: rotate(0deg); }
		100% { transform: rotate(360deg); }
	}

	/* --- Box file UI --- */
	.box-file-info {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	.box-file-name {
		font-size: 10px;
		color: #333;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100px;
	}

	.box-file-size {
		font-size: 9px;
		color: #888;
		white-space: nowrap;
	}

	.box-file-remove {
		background: none;
		border: none;
		color: #e53935;
		font-size: 14px;
		cursor: pointer;
		padding: 0 2px;
		line-height: 1;
	}

	.box-file-btn {
		flex: 1;
		font-size: 10px;
		color: #7c3aed;
		cursor: pointer;
		font-family: 'Roboto', sans-serif;
		font-weight: 600;
	}

	.box-file-hidden {
		display: none;
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
