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
		const li = document.createElement('li')
		li.className = 'fresh'
		const time = document.createElement('time')
		time.textContent = clockText(state.clock)
		const what = document.createElement('span')
		what.textContent = text
		if (you) what.className = 'you'
		const dist = document.createElement('span')
		dist.className = 'far'
		dist.textContent = far == null ? '' : `${far.toFixed(1)} km`
		li.append(time, what, dist)
		const list = $('journal')
		list.prepend(li)
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

	const METRIC_ROWS = [
		{key: 'cost', name: 'Track length', note: 'times the shortest network that links every flake', max: 3.5, fmt: (v) => `${v.toFixed(2)}×`},
		{key: 'detour', name: 'Detour', note: 'extra distance between two flakes, against a straight line', max: 1, fmt: (v) => `+${Math.round(v * 100)}%`},
		{key: 'tolerance', name: 'Survives a cut', note: 'chance a single broken link cuts no flake off', max: 1, fmt: (v) => `${Math.round(v * 100)}%`},
	]

	function showVerdict(result) {
		const box = $('verdict')
		if (!result) {
			const p = document.createElement('p')
			p.className = 'verdict-wait'
			p.textContent = 'The slime needs to reach a few more oat flakes before it can be measured.'
			box.replaceChildren(p)
			return
		}
		const rows = METRIC_ROWS.filter((r) => result.slime[r.key] != null && result.rail[r.key] != null)
		const overlap = result.overlap
			? Object.assign(document.createElement('p'), {
					className: 'verdict-overlap',
					textContent: `The slime built ${Math.round(result.overlap.railBuilt * 100)}% of the real track, and ${Math.round(result.overlap.slimeOnRail * 100)}% of its tubes run along it.`,
				})
			: ''
		box.replaceChildren(
			...(overlap ? [overlap] : []),
			...rows.map((r) => {
				const el = document.createElement('div')
				el.className = 'metric'
				const bar = (who, label, v) =>
					`<div class="bar bar-${who}"><span>${label}</span><span class="track"><span class="fill" style="--v:${Math.min(1, v / r.max).toFixed(3)}"></span></span><output>${r.fmt(v)}</output></div>`
				el.innerHTML = `<div class="metric-head"><span class="metric-name">${r.name}</span><span class="metric-note">${r.note}</span></div>${bar('slime', 'Slime', result.slime[r.key])}${bar('rail', 'S+U', result.rail[r.key])}`
				return el
			}),
			Object.assign(document.createElement('p'), {className: 'verdict-foot', textContent: result.foot || ''}),
		)
	}

	function updateVerdict() {
		if (typeof NetworkMetrics === 'undefined' || !NetworkMetrics.compare) return
		if (reachedCount() < 3) {
			state.railCoverage = null
			return showVerdict(null)
		}
		let result
		try {
			result = NetworkMetrics.compare({net, flakes: state.flakes, stations, edges: BERLIN.edges, pxPerKm: PX_PER_KM})
		} catch (err) {
			console.warn(err)
			return
		}
		state.railCoverage = result.railCoverage || null
		if (state.showRail) state.overlayDirty = true
		showVerdict(result)
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
		const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
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
		state.colors = {
			ink: css('--ink'),
			muted: css('--muted'),
			paper: css('--paper'),
			halo: css('--halo'),
			railS: css('--rail-s'),
			railU: css('--rail-u'),
			oat: css('--oat'),
			oatEdge: css('--oat-edge'),
			oatFed: css('--oat-fed'),
			mono: css('--font-mono'),
		}
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

	// --- The overlay: oat flakes, names, the real network -----------------------

	// an oat flake: a rolled, slightly irregular oval
	function oatFlake(x, y, r, seed, fed) {
		const c = state.colors
		let s = (seed * 7919) % 233280
		const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280
		octx.save()
		octx.translate(x, y)
		octx.rotate(rnd() * Math.PI)
		octx.beginPath()
		const n = 11
		for (let i = 0; i <= n; i++) {
			const a = (i / n) * TAU
			const k = 1 + (rnd() - 0.5) * 0.18
			const px = Math.cos(a) * r * 1.25 * k, py = Math.sin(a) * r * 0.85 * k
			i === 0 ? octx.moveTo(px, py) : octx.lineTo(px, py)
		}
		octx.closePath()
		const g = octx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r * 1.3)
		g.addColorStop(0, fed ? c.oatFed : c.oat)
		g.addColorStop(1, c.oatEdge)
		octx.fillStyle = g
		octx.fill()
		octx.lineWidth = 0.8
		octx.strokeStyle = c.oatEdge
		octx.stroke()
		octx.beginPath()
		octx.moveTo(-r * 0.7, r * 0.1)
		octx.quadraticCurveTo(0, -r * 0.2, r * 0.7, r * 0.05)
		octx.globalAlpha = 0.45
		octx.stroke()
		octx.restore()
	}

	function drawOverlay() {
		const c = state.colors
		const dpr = overlay.width / cssSize
		const s = scale()
		const z = Math.min(1.3, Math.max(0.7, cssSize / 820))
		const fz = z * Math.min(1.8, Math.sqrt(view.zoom)) // flakes grow a little when you look closer
		const [dcx, dcy] = toCss(SIM / 2, SIM / 2)
		const dr = (SIM / 2) * s
		const onScreen = (x, y, m = 24) => x > -m && y > -m && x < cssSize + m && y < cssSize + m
		octx.setTransform(dpr, 0, 0, dpr, 0, 0)
		octx.clearRect(0, 0, cssSize, cssSize)

		if (state.showRail) {
			octx.save()
			octx.beginPath()
			octx.arc(dcx, dcy, dr - 2, 0, TAU)
			octx.clip()
			octx.lineCap = 'round'
			octx.lineJoin = 'round'
			// track the slime built too is solid, the rest dashed
			const cov = state.railCoverage
			for (const pass of ['U', 'S']) {
				for (const built of [false, true]) {
					octx.beginPath()
					BERLIN.edges.forEach(([a, b, mode], i) => {
						if (mode !== pass) return
						if (cov ? cov[i] >= 0.5 !== built : !built) return
						octx.moveTo(...toCss(stations[a].x, stations[a].y))
						octx.lineTo(...toCss(stations[b].x, stations[b].y))
					})
					octx.strokeStyle = pass === 'S' ? c.railS : c.railU
					octx.lineWidth = (pass === 'S' ? 2.2 : 1.5) * z * (built ? 1 : 0.85)
					octx.globalAlpha = built ? 0.92 : 0.7
					octx.setLineDash(built ? [] : [4 * z, 3.5 * z])
					octx.stroke()
				}
			}
			octx.setLineDash([])
			octx.globalAlpha = 1
			octx.fillStyle = c.paper
			octx.strokeStyle = c.ink
			octx.lineWidth = 0.9
			for (const st of stations) {
				const [x, y] = toCss(st.x, st.y)
				if (!onScreen(x, y)) continue
				octx.beginPath()
				octx.arc(x, y, 1.6 * fz, 0, TAU)
				octx.fill()
				octx.stroke()
			}
			octx.restore()
		}

		const flakeAt = state.flakes.map((f) => (f.alive ? toCss(f.x, f.y) : null))
		state.flakes.forEach((f, i) => {
			const at = flakeAt[i]
			if (!at || !onScreen(...at)) return
			const big = f.kind === 'code' ? 1.3 : 1
			oatFlake(at[0], at[1], 4.4 * fz * big, i + 1, state.reached.has(i) && f.kind !== 'code')
			if (f.kind === 'code') {
				octx.beginPath()
				octx.arc(at[0], at[1], 10 * fz, 0, TAU)
				octx.strokeStyle = c.ink
				octx.lineWidth = 1.4
				octx.stroke()
			}
		})

		// names, placed so they sit neither on each other nor on a flake
		const placed = flakeAt.filter(Boolean).map(([x, y]) => [x - 7 * fz, y - 6 * fz, 14 * fz, 12 * fz])
		const fontSize = Math.round(11 * Math.min(1.15, z))
		const label = (text, x, y, strong) => {
			octx.font = `${strong ? 700 : 600} ${fontSize}px ${c.mono}`
			const w = octx.measureText(text).width
			const h = fontSize + 2
			const gap = 9 * fz
			for (const [lx, ly] of [
				[x + gap, y - h / 2],
				[x - gap - w, y - h / 2],
				[x - w / 2, y - gap - h],
				[x - w / 2, y + gap],
			]) {
				if (lx < 4 || ly < 4 || lx + w > cssSize - 4 || ly + h > cssSize - 4) continue
				if (Math.hypot(lx + w / 2 - dcx, ly + h / 2 - dcy) > dr - 14) continue
				if (placed.some((r) => lx < r[0] + r[2] && lx + w > r[0] && ly < r[1] + r[3] && ly + h > r[1])) continue
				placed.push([lx - 2, ly - 1, w + 4, h + 2])
				octx.textBaseline = 'middle'
				octx.lineWidth = 3
				octx.lineJoin = 'round'
				octx.strokeStyle = c.halo
				octx.strokeText(text, lx, ly + h / 2)
				octx.fillStyle = strong ? c.ink : c.muted
				octx.fillText(text, lx, ly + h / 2)
				return
			}
		}
		const start = state.flakes[0]
		if (start && start.kind === 'code' && flakeAt[0]) label('CODE', flakeAt[0][0] + 5 * fz, flakeAt[0][1], true)
		if (state.showNames) {
			// the flakes come busiest first, so a small dish names the big ones
			let room = cssSize * view.zoom > 480 ? Infinity : 10
			state.flakes.forEach((f, i) => {
				if (f.kind === 'station' && flakeAt[i] && onScreen(...flakeAt[i], 0) && room-- > 0) label(f.name, flakeAt[i][0], flakeAt[i][1], false)
			})
		}

		// north, top right, and a scale, bottom right: on the bench, off the dish
		octx.fillStyle = c.muted
		octx.strokeStyle = c.muted
		octx.textBaseline = 'alphabetic'
		octx.font = `600 ${fontSize}px ${c.mono}`
		const nx = cssSize - 26 * z, ny = 30 * z
		octx.beginPath()
		octx.moveTo(nx, ny - 14 * z)
		octx.lineTo(nx + 5 * z, ny)
		octx.lineTo(nx, ny - 3 * z)
		octx.lineTo(nx - 5 * z, ny)
		octx.closePath()
		octx.fill()
		octx.textAlign = 'center'
		octx.fillText('N', nx, ny + 14 * z)
		const km = [10, 5, 2, 1, 0.5].find((d) => d * PX_PER_KM * s <= 150 * z) || 0.5
		const barW = km * PX_PER_KM * s
		const bx = cssSize - 18 * z - barW, by = cssSize - 20 * z
		octx.lineWidth = 1.5
		octx.beginPath()
		octx.moveTo(bx, by - 4)
		octx.lineTo(bx, by)
		octx.lineTo(bx + barW, by)
		octx.lineTo(bx + barW, by - 4)
		octx.stroke()
		octx.fillText(km < 1 ? `${km * 1000} m` : `${km} km`, bx + barW / 2, by - 8 * z)
		octx.textAlign = 'start'

		if (state.pointer && state.tool !== 'food') {
			octx.beginPath()
			octx.arc(state.pointer.x, state.pointer.y, BRUSH * s, 0, TAU)
			octx.strokeStyle = c.ink
			octx.setLineDash([3, 3])
			octx.lineWidth = 1
			octx.stroke()
			octx.setLineDash([])
		}
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
		{key: 'mu', name: 'How hard tubes compete', hint: 'Higher makes a leaner network, lower a meshier one.', min: 1, max: 3, step: 0.05, fmt: (v) => `μ ${v.toFixed(2)}`},
		{key: 'flow', name: 'How much protoplasm flows', hint: 'More flow keeps more side tubes alive.', min: 0.3, max: 6, step: 0.1, fmt: (v) => v.toFixed(1)},
		{key: 'decay', name: 'How fast idle tubes wither', min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×`},
		{key: 'growth', name: 'How fast the slime spreads', min: 0.3, max: 5, step: 0.1, fmt: (v) => `${v.toFixed(1)}×`},
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
	$('dish-date').textContent = `Berlin, ${today.getDate()}.${today.getMonth() + 1}.${String(today.getFullYear()).slice(2)}`

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
		renderer.update(net)
		renderer.render(now / 1000, {still: reducedMotion, view})
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
