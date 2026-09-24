'use strict'

;(() => {
	const $ = (id) => document.getElementById(id)
	const TAU = Math.PI * 2

	// The map is a square 1024 px across; the dish is the circle inside it.
	const SIM = 1024
	const PX_PER_KM = SIM / BERLIN.km[0]
	const CITY_KM = 0.5 // closer than this to a stop is city
	const EXTENT_KM = 1.6 // farther than this from every stop is outside Berlin
	const MESH_KM = SlimeNetwork.SPACING_KM || 0.4
	const BRUSH = 1 * PX_PER_KM // a kilometre
	const BUDGET_MS = 10 // model time per frame

	const query = new URLSearchParams(location.search)
	const coarse = matchMedia('(pointer: coarse)').matches
	const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
	const MANUAL = query.has('manual') // tests drive the steps themselves

	const stations = BERLIN.stations.map(([name, u, v, modes, inBerlin]) => ({
		name,
		x: u * SIM,
		y: v * SIM,
		modes,
		inBerlin: inBerlin === 1,
	}))

	const SETUPS = {
		hubs: () => BERLIN.hubs.map((i) => stations[i]),
		ring: () => BERLIN.ring.map((i) => stations[i]),
		none: () => [],
	}

	const HINTS = {
		food: coarse
			? 'Tap the dish to put down an oat flake. Tap a flake to take it away.'
			: 'Click the dish to put down an oat flake. Click a flake to take it away.',
		light: 'Drag across the dish to shine light on it. The slime keeps away, and tubes in the light wither.',
		erase: 'Drag across the dish to switch the light off again.',
	}

	const state = {
		setup: 'hubs',
		tool: 'food',
		running: true,
		speed: 3,
		showRail: false,
		showNames: true,
		flakes: [],
		reached: new Set(),
		allReached: false,
		steps: 0,
		clock: 0, // seconds the dish has been running
		pointer: null,
		painting: null,
		paintNoted: false,
		overlayDirty: true,
		frame: 0,
		colors: null,
		verdictAt: 0,
		railCoverage: null,
	}

	const glCanvas = $('gl')
	const overlay = $('overlay')
	const octx = overlay.getContext('2d')

	function fail(message) {
		const box = $('error')
		box.textContent = message
		box.hidden = false
	}

	// --- The ground ----------------------------------------------------------

	// Box blur, once across and once down.
	function blur(src, r) {
		const w = SIM, h = SIM, n = 2 * r + 1
		const tmp = new Float32Array(w * h), out = new Uint8Array(w * h)
		for (let y = 0; y < h; y++) {
			let acc = 0
			for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]
			for (let x = 0; x < w; x++) {
				tmp[y * w + x] = acc / n
				acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)]
			}
		}
		for (let x = 0; x < w; x++) {
			let acc = 0
			for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
			for (let y = 0; y < h; y++) {
				out[y * w + x] = Math.round(acc / n)
				acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]
			}
		}
		return out
	}

	// Every bus, tram and train stop in Berlin, stamped as a disc. Near a stop
	// is city, a bit farther is parkland, and beyond that the city ends.
	const ground = (() => {
		const bin = atob(BERLIN.city)
		const bytes = new Uint8Array(bin.length)
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
		const pts = new Uint16Array(bytes.buffer)
		const c = document.createElement('canvas')
		c.width = SIM
		c.height = SIM
		const ctx = c.getContext('2d', {willReadFrequently: true})
		const stamp = (km) => {
			const r = km * PX_PER_KM
			ctx.clearRect(0, 0, SIM, SIM)
			ctx.fillStyle = '#fff'
			ctx.beginPath()
			for (let i = 0; i < pts.length; i += 2) {
				const x = (pts[i] / 65535) * SIM
				const y = (pts[i + 1] / 65535) * SIM
				ctx.moveTo(x + r, y)
				ctx.arc(x, y, r, 0, TAU)
			}
			ctx.fill()
			const img = ctx.getImageData(0, 0, SIM, SIM).data
			const out = new Uint8Array(SIM * SIM)
			for (let i = 0; i < out.length; i++) out[i] = img[i * 4 + 3]
			return blur(blur(out, 4), 4)
		}
		return {city: stamp(CITY_KM), extent: stamp(EXTENT_KM)}
	})()

	const maskAt = (mask, x, y) =>
		mask[Math.min(SIM - 1, Math.max(0, Math.floor(y))) * SIM + Math.min(SIM - 1, Math.max(0, Math.floor(x)))] / 255
	const inside = (x, y) => maskAt(ground.extent, x, y) > 0.5
	const parkland = (x, y) => maskAt(ground.extent, x, y) * (1 - maskAt(ground.city, x, y))

	// --- The model and the pictures -------------------------------------------

	let renderer
	try {
		renderer = new DishRenderer(glCanvas, {width: SIM, height: SIM})
	} catch (err) {
		fail(`This dish needs WebGL2, which this browser doesn’t offer. A recent Chrome, Firefox or Safari will do. (${err.message})`)
		return
	}
	glCanvas.addEventListener('webglcontextlost', (e) => {
		e.preventDefault()
		state.running = false
		fail('The graphics card dropped this page. Reload to start again.')
	})

	const net = new SlimeNetwork({width: SIM, height: SIM, spacing: MESH_KM * PX_PER_KM, inside, park: parkland})
	renderer.setGround(ground.city, ground.extent)
	renderer.setMesh(net)

	// edges by where their middle is, so light can find them quickly
	const EDGE_CELL = 16
	const edgeCols = Math.ceil(SIM / EDGE_CELL)
	const edgeCells = Array.from({length: edgeCols * edgeCols}, () => [])
	for (let e = 0; e < net.edgeCount; e++) {
		const mx = (net.x[net.a[e]] + net.x[net.b[e]]) / 2
		const my = (net.y[net.a[e]] + net.y[net.b[e]]) / 2
		edgeCells[Math.floor(my / EDGE_CELL) * edgeCols + Math.floor(mx / EDGE_CELL)].push(e)
	}
	function relight(cx, cy, r) {
		const x0 = Math.max(0, Math.floor((cx - r) / EDGE_CELL)), x1 = Math.min(edgeCols - 1, Math.floor((cx + r) / EDGE_CELL))
		const y0 = Math.max(0, Math.floor((cy - r) / EDGE_CELL)), y1 = Math.min(edgeCols - 1, Math.floor((cy + r) / EDGE_CELL))
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				for (const e of edgeCells[y * edgeCols + x]) {
					net.light[e] = renderer.lightAt((net.x[net.a[e]] + net.x[net.b[e]]) / 2, (net.y[net.a[e]] + net.y[net.b[e]]) / 2)
				}
			}
		}
	}

	// --- Oat flakes ----------------------------------------------------------

	const codeFlake = () => ({
		name: 'CODE University',
		x: BERLIN.code[1] * SIM,
		y: BERLIN.code[2] * SIM,
		kind: 'code',
		alive: true,
	})

	const nearestStation = (x, y) => {
		let best = null, bestD = Infinity
		for (const s of stations) {
			const d = Math.hypot(s.x - x, s.y - y)
			if (d < bestD) (best = s), (bestD = d)
		}
		return {station: best, km: bestD / PX_PER_KM}
	}

	const placeName = (x, y) => {
		const {station, km} = nearestStation(x, y)
		return km < 1.5 ? station.name : null
	}

	const kmFromStart = (f) => Math.hypot(f.x - state.flakes[0].x, f.y - state.flakes[0].y) / PX_PER_KM

	function syncFlakes() {
		net.setFlakes(state.flakes)
		renderer.setFlakes?.(state.flakes)
		state.overlayDirty = true
	}

	function startOver() {
		state.flakes = [codeFlake(), ...SETUPS[state.setup]().map((s) => ({name: s.name, x: s.x, y: s.y, kind: 'station', alive: true}))]
		state.reached = new Set([0])
		state.allReached = false
		state.steps = 0
		state.clock = 0
		state.verdictAt = 0
		syncFlakes()
		net.inoculate(0)
		$('journal').replaceChildren()
		note('Put down on CODE University in Neukölln')
		showVerdict(null)
		updateHud()
	}

	function toggleFlakeAt(x, y) {
		const radius = 12 / scale()
		let hit = -1, hitD = radius
		state.flakes.forEach((f, i) => {
			if (!f.alive) return
			const d = Math.hypot(f.x - x, f.y - y)
			if (d < hitD) (hit = i), (hitD = d)
		})
		if (hit >= 0) {
			const f = state.flakes[hit]
			f.alive = false
			state.reached.delete(hit)
			note(`You took away the oat flake at ${f.name}`, true)
			syncFlakes()
			return
		}
		const node = net.nearestNode(x, y)
		if (node < 0 || Math.hypot(net.x[node] - x, net.y[node] - y) > 0.6 * PX_PER_KM) {
			flash('The slime only grows inside the city. Put the oat flake somewhere in Berlin.')
			return
		}
		const near = placeName(x, y)
		const flake = {name: near ? `near ${near}` : 'Your oat flake', x, y, kind: 'yours', alive: true}
		const slot = state.flakes.findIndex((f) => !f.alive)
		if (slot >= 0) state.flakes[slot] = flake
		else if (state.flakes.length < 64) state.flakes.push(flake)
		else return flash('The dish is full. Take a flake away first.')
		note(near ? `You put down an oat flake near ${near}` : 'You put down an oat flake', true)
		syncFlakes()
	}

	// --- The lab log -----------------------------------------------------------

	const clockText = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

	function note(text, you = false, far = null) {
		const list = $('journal')
		list.prepend(DishUI.logItem({time: clockText(state.clock), text, you, far}))
		while (list.children.length > 60) list.lastChild.remove()
	}

	const aliveCount = () => state.flakes.filter((f) => f.alive).length
	const reachedCount = () => [...state.reached].filter((i) => state.flakes[i] && state.flakes[i].alive).length

	function checkReached() {
		for (const i of net.reachedFlakes()) {
			if (state.reached.has(i)) continue
			state.reached.add(i)
			const f = state.flakes[i]
			if (f && f.kind !== 'code') note(`Reached ${f.name}`, false, kmFromStart(f))
			state.overlayDirty = true
		}
		const alive = aliveCount(), reached = reachedCount()
		if (reached === alive && alive > 1 && !state.allReached) {
			state.allReached = true
			note(`All ${alive} oat flakes reached`)
		}
		if (reached < alive) state.allReached = false
	}

	function updateHud() {
		$('hud-clock').textContent = clockText(state.clock)
		const alive = aliveCount()
		$('hud-reached').textContent = `${reachedCount()} of ${alive} oat flake${alive === 1 ? '' : 's'}`
	}

	// --- Slime against rail ----------------------------------------------------

	const showVerdict = (result) => DishUI.verdict($('verdict'), result)

	function updateVerdict() {
		if (typeof NetworkMetrics === 'undefined' || !NetworkMetrics.compare) return
		if (reachedCount() < 3) {
			state.railCoverage = null
			return showVerdict(null)
		}
		let result
		try {
			// with only a few flakes, or a ring of them, compare against the rail's
			// shortest routes, not the whole web of track in the middle
			const options = state.setup === 'hubs' ? {} : {railMode: 'shortest'}
			result = NetworkMetrics.compare({net, flakes: state.flakes, stations, edges: BERLIN.edges, pxPerKm: PX_PER_KM, options})
		} catch (err) {
			console.warn(err)
			return
		}
		state.railCoverage = result.railCoverage || null
		if (state.showRail) state.overlayDirty = true
		showVerdict(result.forming ? null : result)
	}

	// --- Colours --------------------------------------------------------------

	function readPalette() {
		const cs = getComputedStyle(document.documentElement)
		const css = (name) => cs.getPropertyValue(name).trim()
		const rgb = (name) => {
			let h = css(name).replace('#', '')
			if (h.length === 3) h = [...h].map((c) => c + c).join('')
			const n = parseInt(h, 16)
			return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
		}
		const theme = document.documentElement.dataset.theme
		const scheme = css('--scheme')
		const dark = scheme ? scheme === 'dark' : theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
		renderer.setPalette({
			dark,
			bench: rgb('--bench'),
			rim: rgb('--rim'),
			dish: rgb('--dish'),
			park: rgb('--park'),
			outside: rgb('--outside'),
			light: rgb('--light'),
			trace: rgb('--trace'),
			slime: rgb('--slime'),
			core: rgb('--core'),
		})
		state.colors = DishUI.readColors(cs)
		state.overlayDirty = true
	}
	readPalette()
	document.fonts?.ready.then(() => (state.overlayDirty = true))
	matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readPalette)
	new MutationObserver(readPalette).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']})

	// --- Size -----------------------------------------------------------------

	const dish = $('dish')
	const bench = $('bench')
	let cssSize = 1

	function layout() {
		const cs = getComputedStyle(bench)
		const availW = bench.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
		const stacked = matchMedia('(max-width: 860px)').matches
		const availH = stacked ? Infinity : bench.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
		const size = Math.max(1, Math.floor(Math.min(availW, availH)))
		dish.style.width = size + 'px'
		dish.style.height = size + 'px'
		cssSize = size
		const dpr = Math.min(window.devicePixelRatio || 1, 2)
		glCanvas.width = overlay.width = Math.round(size * dpr)
		glCanvas.height = overlay.height = Math.round(size * dpr)
		state.overlayDirty = true
		renderer.update(net)
		renderer.render(performance.now() / 1000, {still: reducedMotion, view})
	}
	new ResizeObserver(layout).observe(bench)

	// --- The view: the whole dish, or a closer look -----------------------------

	const MAX_ZOOM = 4
	const view = {x: SIM / 2, y: SIM / 2, zoom: 1}
	const scale = () => (cssSize / SIM) * view.zoom
	const toCss = (x, y) => [(x - view.x) * scale() + cssSize / 2, (y - view.y) * scale() + cssSize / 2]
	const fromCss = (cx, cy) => [(cx - cssSize / 2) / scale() + view.x, (cy - cssSize / 2) / scale() + view.y]

	const fit = document.createElement('button')
	fit.type = 'button'
	fit.id = 'fit'
	fit.className = 'fit'
	fit.textContent = 'Whole dish'
	fit.hidden = true
	dish.append(fit)

	function clampView() {
		view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom))
		const half = SIM / (2 * view.zoom)
		view.x = Math.min(SIM - half, Math.max(half, view.x))
		view.y = Math.min(SIM - half, Math.max(half, view.y))
		const zoomed = view.zoom > 1.001
		dish.classList.toggle('is-zoomed', zoomed)
		fit.hidden = !zoomed
		state.overlayDirty = true
	}

	// zoom by factor, keeping the point under (cx, cy) where it is
	function zoomAt(cx, cy, factor) {
		const [px, py] = fromCss(cx, cy)
		view.zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor))
		view.x = px - (cx - cssSize / 2) / scale()
		view.y = py - (cy - cssSize / 2) / scale()
		clampView()
	}

	function resetView() {
		view.x = SIM / 2
		view.y = SIM / 2
		view.zoom = 1
		clampView()
	}
	fit.addEventListener('click', resetView)

	// --- The overlay: oat flakes, names, the real network (drawn by ui.js) ------

	function drawOverlay() {
		const s = scale()
		const [cx, cy] = toCss(SIM / 2, SIM / 2)
		DishUI.drawOverlay(octx, {
			size: cssSize,
			dpr: overlay.width / cssSize,
			toCss,
			scale: s,
			zoom: view.zoom,
			dish: {cx, cy, r: (SIM / 2) * s},
			pxPerKm: PX_PER_KM,
			flakes: state.flakes,
			reached: state.reached,
			stations,
			edges: BERLIN.edges,
			railCoverage: state.railCoverage,
			showRail: state.showRail,
			showNames: state.showNames,
			pointer: state.pointer,
			tool: state.tool,
			brush: BRUSH,
			colors: state.colors,
		})
		state.overlayDirty = false
	}

	// --- Hands on the dish ----------------------------------------------------

	const tip = $('tip')

	const toSim = (e) => {
		const r = overlay.getBoundingClientRect()
		const cx = e.clientX - r.left, cy = e.clientY - r.top
		const [x, y] = fromCss(cx, cy)
		return {cx, cy, x, y}
	}

	function paint(from, to) {
		const amount = state.tool === 'light' ? 0.35 : -0.6
		const d = Math.hypot(to.x - from.x, to.y - from.y)
		const n = Math.max(1, Math.ceil(d / 5))
		for (let i = 1; i <= n; i++) {
			const t = i / n
			const x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t
			renderer.paintLight(x, y, BRUSH, amount)
			relight(x, y, BRUSH)
		}
		if (!state.paintNoted) {
			state.paintNoted = true
			const near = placeName(to.x, to.y)
			const where = near ? ` near ${near}` : ''
			note(state.tool === 'light' ? `You shone a light${where}` : `You switched the light off${where}`, true)
		}
	}

	// One finger or the mouse: the tool. With the oat flake tool a tap puts
	// down or takes away a flake and a drag pans. Two fingers zoom and pan.
	const pointers = new Map()
	let pinch = null
	let drag = null

	const pinchNow = () => {
		const [a, b] = [...pointers.values()]
		return {dist: Math.hypot(a.cx - b.cx, a.cy - b.cy), cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2}
	}

	overlay.addEventListener('pointerdown', (e) => {
		if (e.button !== 0 && e.pointerType === 'mouse') return
		overlay.setPointerCapture(e.pointerId)
		const p = toSim(e)
		pointers.set(e.pointerId, {cx: p.cx, cy: p.cy})
		if (pointers.size === 2) {
			state.painting = null
			drag = null
			pinch = pinchNow()
			return
		}
		if (pointers.size > 2) return
		if (state.tool === 'food') {
			drag = {cx: p.cx, cy: p.cy, at: p, moved: false}
		} else {
			state.painting = p
			state.paintNoted = false
			paint(p, p)
		}
	})

	overlay.addEventListener('pointermove', (e) => {
		const p = toSim(e)
		if (pointers.has(e.pointerId)) pointers.set(e.pointerId, {cx: p.cx, cy: p.cy})
		state.pointer = {x: p.cx, y: p.cy}
		if (pinch && pointers.size >= 2) {
			const now = pinchNow()
			zoomAt(now.cx, now.cy, now.dist / Math.max(1, pinch.dist))
			view.x -= (now.cx - pinch.cx) / scale()
			view.y -= (now.cy - pinch.cy) / scale()
			clampView()
			pinch = now
			return
		}
		if (drag) {
			const dx = p.cx - drag.cx, dy = p.cy - drag.cy
			if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true
			if (drag.moved && view.zoom > 1.001) {
				view.x -= dx / scale()
				view.y -= dy / scale()
				clampView()
				drag.cx = p.cx
				drag.cy = p.cy
			}
			return
		}
		if (state.painting) {
			paint(state.painting, p)
			state.painting = p
		}
		if (state.tool !== 'food') state.overlayDirty = true
		showTip(p)
	})

	function release(e) {
		pointers.delete(e.pointerId)
		if (pinch) {
			if (pointers.size < 2) pinch = null
			return
		}
		if (drag && e.type === 'pointerup' && !drag.moved) toggleFlakeAt(drag.at.x, drag.at.y)
		drag = null
		state.painting = null
	}
	overlay.addEventListener('pointerup', release)
	overlay.addEventListener('pointercancel', release)
	overlay.addEventListener('pointerleave', () => {
		state.pointer = null
		tip.hidden = true
		state.overlayDirty = true
	})

	overlay.addEventListener(
		'wheel',
		(e) => {
			// on a phone-sized layout the page scrolls, so only a pinch (ctrl) zooms
			if (matchMedia('(max-width: 860px)').matches && !e.ctrlKey) return
			e.preventDefault()
			const r = overlay.getBoundingClientRect()
			const speed = e.deltaMode === 1 ? 0.05 : 0.0018
			zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * speed))
		},
		{passive: false},
	)

	function showTip(p) {
		if (coarse) return
		const radius = 12 / scale()
		let hit = null, hitD = radius, hitI = -1
		state.flakes.forEach((f, i) => {
			if (!f.alive) return
			const d = Math.hypot(f.x - p.x, f.y - p.y)
			if (d < hitD) (hit = f), (hitD = d), (hitI = i)
		})
		if (!hit) {
			tip.hidden = true
			return
		}
		const status = hit.kind === 'code' ? 'the slime started here' : state.reached.has(hitI) ? 'reached' : 'not reached yet'
		tip.textContent = `${hit.name} · ${status}`
		const [x, y] = toCss(hit.x, hit.y)
		tip.style.left = x + 'px'
		tip.style.top = y + 'px'
		tip.hidden = false
	}

	let flashTimer = 0
	function flash(text) {
		const hint = $('hint')
		hint.textContent = text
		clearTimeout(flashTimer)
		flashTimer = setTimeout(() => (hint.textContent = HINTS[state.tool]), 3000)
	}

	// --- Controls --------------------------------------------------------------

	for (const input of document.querySelectorAll('input[name="setup"]')) {
		input.addEventListener('change', () => {
			state.setup = input.value
			startOver()
		})
	}

	const setTool = (tool) => {
		state.tool = tool
		$('tool-' + tool).checked = true
		$('hint').textContent = HINTS[tool]
		overlay.style.cursor = tool === 'food' ? 'crosshair' : 'none'
		state.overlayDirty = true
	}
	for (const input of document.querySelectorAll('input[name="tool"]')) {
		input.addEventListener('change', () => setTool(input.value))
	}

	const setRunning = (on) => {
		state.running = on
		$('play').textContent = on ? 'Pause' : 'Play'
	}
	$('play').addEventListener('click', () => setRunning(!state.running))
	$('restart').addEventListener('click', () => {
		renderer.clearLight()
		net.light.fill(0)
		startOver()
		setRunning(true)
	})
	$('speed').addEventListener('input', (e) => (state.speed = Number(e.target.value)))

	const setShowRail = (on) => {
		state.showRail = on
		$('show-rail').checked = on
		for (const li of document.querySelectorAll('.rail-key')) li.hidden = !on
		state.overlayDirty = true
	}
	$('show-rail').addEventListener('change', (e) => setShowRail(e.target.checked))
	$('show-names').addEventListener('change', (e) => {
		state.showNames = e.target.checked
		state.overlayDirty = true
	})

	// lab settings: the knobs of the model that change what it builds
	const LAB = [
		{key: 'mu', name: 'How hard tubes compete', hint: 'Higher makes a leaner network, lower keeps more loops.', min: 1, max: 3, step: 0.05, fmt: (v) => `μ ${v.toFixed(2)}`},
		{key: 'flow', name: 'How much protoplasm flows', hint: 'More flow keeps more side tubes alive.', min: 2, max: 30, step: 0.5, fmt: (v) => v.toFixed(1)},
		{key: 'decay', name: 'How fast idle tubes wither', min: 0.3, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`},
		{key: 'growth', name: 'How fast the slime spreads', min: 2, max: 30, step: 0.5, fmt: (v) => v.toFixed(1)},
	].filter((s) => typeof net.params[s.key] === 'number')
	const DEFAULT_PARAMS = {...net.params}
	const sliders = $('sliders')
	for (const s of LAB) {
		const label = document.createElement('label')
		label.htmlFor = 'p-' + s.key
		label.innerHTML = `<span>${s.name}</span><output id="o-${s.key}"></output>`
		const input = Object.assign(document.createElement('input'), {type: 'range', id: 'p-' + s.key, min: s.min, max: s.max, step: s.step})
		input.addEventListener('input', () => {
			net.params[s.key] = Number(input.value)
			$('o-' + s.key).textContent = s.fmt(net.params[s.key])
		})
		sliders.append(label)
		if (s.hint) sliders.append(Object.assign(document.createElement('small'), {textContent: s.hint}))
		sliders.append(input)
	}
	const syncLab = () => {
		for (const s of LAB) {
			$('p-' + s.key).value = net.params[s.key]
			$('o-' + s.key).textContent = s.fmt(net.params[s.key])
		}
	}
	$('reset-lab').addEventListener('click', () => {
		Object.assign(net.params, DEFAULT_PARAMS)
		syncLab()
	})
	syncLab()

	document.addEventListener('keydown', (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return
		if (e.key === ' ' && e.target.closest('input, button, summary, a, label')) return
		switch (e.key) {
			case ' ':
				e.preventDefault()
				setRunning(!state.running)
				break
			case 'r':
			case 'R':
				$('restart').click()
				break
			case 'n':
			case 'N':
				setShowRail(!state.showRail)
				break
			case '1':
				setTool('food')
				break
			case '2':
				setTool('light')
				break
			case '3':
				setTool('erase')
				break
			case '+':
			case '=':
				zoomAt(cssSize / 2, cssSize / 2, 1.3)
				break
			case '-':
				zoomAt(cssSize / 2, cssSize / 2, 1 / 1.3)
				break
			case '0':
				resetView()
				break
		}
	})

	// the date on the dish, the way it would be written on a real one
	const today = new Date()
	const dated = $('dish-date')
	if (dated) dated.textContent = `Berlin, ${today.getDate()}.${today.getMonth() + 1}.${String(today.getFullYear()).slice(2)}`

	// --- Run -------------------------------------------------------------------

	function advance(maxSteps) {
		const t0 = performance.now()
		let n = 0
		while (n < maxSteps && performance.now() - t0 < BUDGET_MS) {
			net.step()
			n++
		}
		state.steps += n
	}

	let last = performance.now()
	function frame(now) {
		const dt = Math.min(0.1, (now - last) / 1000)
		last = now
		if (state.running && !MANUAL) {
			advance(state.speed)
			state.clock += dt
		}
		// in tests the steps come from window.schleimpilz.step(), which draws too
		if (!MANUAL) {
			renderer.update(net)
			renderer.render(now / 1000, {still: reducedMotion, view})
		}
		state.frame++
		if (state.frame % 12 === 0) {
			checkReached()
			updateHud()
		}
		if (now - state.verdictAt > 1500) {
			state.verdictAt = now
			updateVerdict()
		}
		if (state.overlayDirty) drawOverlay()
		requestAnimationFrame(frame)
	}

	startOver()
	layout()
	requestAnimationFrame(frame)

	// hooks for tests/smoke.mjs
	window.schleimpilz = {
		net,
		renderer,
		state,
		step(n) {
			for (let i = 0; i < n; i++) net.step()
			state.steps += n
			state.clock += n / 60
			renderer.update(net)
			renderer.render(performance.now() / 1000, {still: true, view})
			checkReached()
			updateHud()
			updateVerdict()
			drawOverlay()
			return state.steps
		},
		setShowRail,
		setTool,
		view,
		zoomAt,
		resetView,
	}
})()
