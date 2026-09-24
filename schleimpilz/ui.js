'use strict'

// Everything the page draws on top of the dish (oat flakes, names, the real
// network, the scale), the markup of the results panel and the lab log, and a
// few small behaviours of the page's own controls: the icon on the play
// button, the hairline that shows how far the slime has got, and popovers
// that close when you click elsewhere. app.js owns the state and calls these;
// this file owns how they look.

const DishUI = (() => {
	const TAU = Math.PI * 2

	// Colours and fonts for the overlay, from the CSS custom properties.
	function readColors(cs) {
		const css = (name, fallback) => cs.getPropertyValue(name).trim() || fallback
		return {
			text: css('--text', css('--ink', '#f3f2ee')),
			text2: css('--text-2', css('--muted', '#a3a29c')),
			text3: css('--text-3', '#878680'),
			halo: css('--halo', 'rgba(5, 6, 6, 0.84)'),
			void: css('--void', css('--paper', '#050606')),
			railS: css('--rail-s', '#7b8cff'),
			railU: css('--rail-u', '#56d6e3'),
			slime: css('--slime', '#ffc53d'),
			slimeHot: css('--slime-hot', '#ffebb0'),
			slimeDeep: css('--slime-deep', '#c88a12'),
			mono: css('--font-mono', 'ui-monospace, monospace'),
		}
	}

	// #rrggbb (or #rgb) with an alpha; anything else is passed through
	function rgba(color, a) {
		let h = String(color).trim().replace(/^#/, '')
		if (h.length === 3) h = [...h].map((ch) => ch + ch).join('')
		if (!/^[0-9a-f]{6}$/i.test(h)) return color
		const n = parseInt(h, 16)
		return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
	}

	const spacing = (ctx, px) => {
		if ('letterSpacing' in ctx) ctx.letterSpacing = `${px.toFixed(2)}px`
	}

	function pill(ctx, x, y, w, h) {
		ctx.beginPath()
		if (ctx.roundRect) ctx.roundRect(x, y, w, h, h / 2)
		else ctx.rect(x, y, w, h)
	}

	// --- Markers ---------------------------------------------------------------

	// a dark disc under a marker, so it reads on the agar and on the tubes alike
	function halo(ctx, c, x, y, r, alpha) {
		ctx.beginPath()
		ctx.arc(x, y, r, 0, TAU)
		ctx.globalAlpha = alpha
		ctx.fillStyle = c.halo
		ctx.fill()
		ctx.globalAlpha = 1
	}

	// an oat flake the slime hasn't reached yet: a thin ring round a dot
	function openMarker(ctx, c, x, y, r, bright) {
		const ink = bright ? c.text : c.text2
		halo(ctx, c, x, y, r + 2.4, 0.6)
		ctx.beginPath()
		ctx.arc(x, y, r, 0, TAU)
		ctx.lineWidth = 1.25
		ctx.strokeStyle = ink
		ctx.stroke()
		ctx.beginPath()
		ctx.arc(x, y, Math.max(1.05, r * 0.3), 0, TAU)
		ctx.fillStyle = ink
		ctx.fill()
	}

	// one it has reached: a gold dot with a soft glow
	function fedMarker(ctx, c, x, y, r) {
		const R = r * 3.6
		const glow = ctx.createRadialGradient(x, y, 0, x, y, R)
		glow.addColorStop(0, rgba(c.slime, 0.42))
		glow.addColorStop(0.3, rgba(c.slime, 0.13))
		glow.addColorStop(1, rgba(c.slime, 0))
		ctx.beginPath()
		ctx.arc(x, y, R, 0, TAU)
		ctx.fillStyle = glow
		ctx.fill()
		halo(ctx, c, x, y, r + 1.6, 0.55)
		const dot = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x, y, r)
		dot.addColorStop(0, '#fffdf6')
		dot.addColorStop(0.45, c.slimeHot)
		dot.addColorStop(1, c.slime)
		ctx.beginPath()
		ctx.arc(x, y, r, 0, TAU)
		ctx.fillStyle = dot
		ctx.fill()
	}

	// where the slime was put down: a white ring round a white dot
	function startMarker(ctx, c, x, y, r) {
		halo(ctx, c, x, y, r + 2.6, 0.55)
		ctx.beginPath()
		ctx.arc(x, y, r, 0, TAU)
		ctx.lineWidth = 1.6
		ctx.strokeStyle = c.text
		ctx.stroke()
		ctx.beginPath()
		ctx.arc(x, y, r * 0.36, 0, TAU)
		ctx.fillStyle = c.text
		ctx.fill()
	}

	// --- The scale, in the corner of the dish (or on the canvas if there is no
	// element for it) ---------------------------------------------------------

	let scaleEl
	let scaleShown = ''
	function showScale(text, width) {
		if (scaleEl === undefined) scaleEl = document.getElementById('scale')
		if (!scaleEl) return false
		const key = `${text}|${width.toFixed(1)}`
		if (key !== scaleShown) {
			scaleShown = key
			scaleEl.querySelector('.scale-text').textContent = text
			scaleEl.querySelector('.scale-bar').style.setProperty('--w', `${width.toFixed(1)}px`)
		}
		return true
	}

	// scene: {
	//   size, dpr: css px of the square canvas and device pixels per css px
	//   toCss(x, y) -> [cx, cy]: map px (0..1024) to css px, zoom included
	//   scale: css px per map px, zoom: 1..4, dish: {cx, cy, r} in css px
	//   pxPerKm: map px per km
	//   flakes: [{name, x, y, kind: 'code'|'station'|'yours', alive}], reached: Set of indices
	//   stations: [{name, x, y, modes}], edges: [[a, b, 'S'|'U']], railCoverage: Float32Array|null
	//   showRail, showNames, pointer: {x, y} css|null, tool: 'food'|'light'|'erase', brush: map px
	//   colors: from readColors()
	// }
	function drawOverlay(ctx, scene) {
		const {size, dpr, toCss, scale: s, dish, colors: c} = scene
		const zoomed = scene.zoom > 1.001
		const z = Math.min(1.2, Math.max(0.8, size / 800)) // everything a little smaller on a small dish
		const grow = Math.min(1.6, Math.sqrt(scene.zoom)) // and a little bigger when you look closer
		const fz = z * grow
		const lens = size / 2 // when zoomed, the lens shows a circle this big round the middle
		const onScreen = (x, y, m = 24) => x > -m && y > -m && x < size + m && y < size + m
		const inView = (x, y, m) => Math.hypot(x - dish.cx, y - dish.cy) < dish.r - m && (!zoomed || Math.hypot(x - lens, y - lens) < lens - m)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, size, size)
		ctx.lineCap = 'round'
		ctx.lineJoin = 'round'

		// --- the real S-Bahn and U-Bahn ---
		if (scene.showRail) {
			ctx.save()
			ctx.beginPath()
			ctx.arc(dish.cx, dish.cy, dish.r - 3, 0, TAU)
			ctx.clip()
			const lz = z * Math.min(1.8, scene.zoom ** 0.6)
			const cov = scene.railCoverage
			const path = (mode, built) => {
				ctx.beginPath()
				scene.edges.forEach(([a, b, m], i) => {
					if (mode && m !== mode) return
					// the track the slime built too is solid, the rest dashed
					if (built != null && (cov ? cov[i] >= 0.5 !== built : !built)) return
					ctx.moveTo(...toCss(scene.stations[a].x, scene.stations[a].y))
					ctx.lineTo(...toCss(scene.stations[b].x, scene.stations[b].y))
				})
			}
			// a dark casing under all of it, so the lines read over the glowing tubes
			path(null, null)
			ctx.strokeStyle = c.halo
			ctx.globalAlpha = 0.55
			ctx.lineWidth = 3.8 * lz
			ctx.stroke()
			for (const mode of ['U', 'S']) {
				for (const built of [false, true]) {
					path(mode, built)
					ctx.strokeStyle = mode === 'S' ? c.railS : c.railU
					ctx.lineWidth = (mode === 'S' ? 1.7 : 1.3) * lz
					ctx.globalAlpha = built ? 0.95 : 0.5
					ctx.setLineDash(built ? [] : [3.2 * lz, 3.4 * lz])
					ctx.stroke()
				}
			}
			ctx.setLineDash([])
			ctx.globalAlpha = 1
			const sr = 1.15 * z * grow
			for (const st of scene.stations) {
				const [x, y] = toCss(st.x, st.y)
				if (!onScreen(x, y)) continue
				halo(ctx, c, x, y, sr + 1.1, 0.85)
				ctx.beginPath()
				ctx.arc(x, y, sr, 0, TAU)
				ctx.fillStyle = c.text
				ctx.fill()
			}
			ctx.restore()
		}

		// --- oat flakes ---
		const flakeAt = scene.flakes.map((f) => (f.alive ? toCss(f.x, f.y) : null))
		const R = 4.1 * fz
		scene.flakes.forEach((f, i) => {
			const at = flakeAt[i]
			if (!at || !onScreen(...at)) return
			if (f.kind === 'code') startMarker(ctx, c, at[0], at[1], R * 1.55)
			else if (scene.reached.has(i)) fedMarker(ctx, c, at[0], at[1], R * 0.78)
			else openMarker(ctx, c, at[0], at[1], R, f.kind === 'yours')
		})

		// --- names, placed so they sit neither on each other nor on a flake ---
		const placed = flakeAt.filter(Boolean).map(([x, y]) => [x - R - 2, y - R - 2, 2 * R + 4, 2 * R + 4])
		const fontSize = Math.round(10.5 * Math.min(1.1, Math.max(0.92, z)) * 2) / 2
		const tracking = fontSize * 0.075
		const free = (lx, ly, w, h) =>
			lx > 4 && ly > 4 && lx + w < size - 4 && ly + h < size - 4 && inView(lx + w / 2, ly + h / 2, 12) && inView(lx, ly + h / 2, 6) && inView(lx + w, ly + h / 2, 6) && !placed.some((r) => lx < r[0] + r[2] && lx + w > r[0] && ly < r[1] + r[3] && ly + h > r[1])
		const label = (text, x, y, reached) => {
			ctx.font = `500 ${fontSize}px ${c.mono}`
			spacing(ctx, tracking)
			const w = ctx.measureText(text).width - tracking
			const h = fontSize + 2
			const gap = R + 5 * z
			for (const [lx, ly] of [
				[x + gap, y - h / 2],
				[x - gap - w, y - h / 2],
				[x - w / 2, y - gap - h + 2],
				[x - w / 2, y + gap - 2],
			]) {
				if (!free(lx, ly, w, h)) continue
				placed.push([lx - 3, ly - 1, w + 6, h + 2])
				ctx.textBaseline = 'middle'
				ctx.lineWidth = 3.2
				ctx.strokeStyle = c.halo
				ctx.strokeText(text, lx, ly + h / 2 + 0.5)
				ctx.fillStyle = reached ? c.text : c.text2
				ctx.fillText(text, lx, ly + h / 2 + 0.5)
				return
			}
		}

		// CODE, on a light chip beside its ring
		const start = scene.flakes[0]
		if (start && start.kind === 'code' && flakeAt[0] && onScreen(...flakeAt[0])) {
			const [x, y] = flakeAt[0]
			const cs = Math.max(9, Math.round(9.5 * z * 2) / 2)
			ctx.font = `500 ${cs}px ${c.mono}`
			spacing(ctx, cs * 0.12)
			const tw = ctx.measureText('CODE').width - cs * 0.12
			const h = Math.round(cs + 7), w = tw + h * 0.95
			const gap = R * 1.55 + 5 * z
			const spots = [
				[x + gap, y - h / 2],
				[x - gap - w, y - h / 2],
				[x - w / 2, y - gap - h],
				[x - w / 2, y + gap],
			]
			// CODE always gets its chip: in a free spot if there is one
			const [lx, ly] = spots.find(([sx, sy]) => free(sx, sy, w, h)) || spots[0]
			placed.push([lx - 3, ly - 2, w + 6, h + 4])
			pill(ctx, lx, ly, w, h)
			ctx.fillStyle = c.text
			ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
			ctx.shadowBlur = 8
			ctx.fill()
			ctx.shadowBlur = 0
			ctx.shadowColor = 'transparent'
			ctx.fillStyle = c.void
			ctx.textBaseline = 'middle'
			ctx.fillText('CODE', lx + (w - tw) / 2, ly + h / 2 + 0.5)
		}

		if (scene.showNames) {
			// the flakes come busiest first, so a small dish names the big ones
			let room = size * scene.zoom > 480 ? Infinity : 10
			scene.flakes.forEach((f, i) => {
				if (f.kind !== 'station' || !flakeAt[i] || !onScreen(...flakeAt[i], 0) || room-- <= 0) return
				label(f.name.toUpperCase(), flakeAt[i][0], flakeAt[i][1], scene.reached.has(i))
			})
		}
		spacing(ctx, 0)

		// --- the scale: a round length that fits the corner ---
		const maxBar = size < 480 ? 64 : 96
		const km = [20, 10, 5, 2, 1, 0.5, 0.2].find((d) => d * scene.pxPerKm * s <= maxBar) || 0.2
		const barW = km * scene.pxPerKm * s
		const kmText = km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`
		if (!showScale(kmText, barW)) {
			ctx.fillStyle = c.text3
			ctx.strokeStyle = c.text3
			ctx.font = `500 10px ${c.mono}`
			ctx.textAlign = 'right'
			ctx.textBaseline = 'alphabetic'
			const bx = size - 6, by = size - 6
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.moveTo(bx - barW, by - 4)
			ctx.lineTo(bx - barW, by)
			ctx.lineTo(bx, by)
			ctx.lineTo(bx, by - 4)
			ctx.stroke()
			ctx.fillText(kmText, bx, by - 9)
			ctx.fillText('N', size - 6, 16)
			ctx.textAlign = 'start'
		}

		// --- where the light or the dark would go ---
		if (scene.pointer && scene.tool !== 'food') {
			const {x, y} = scene.pointer
			const r = scene.brush * s
			const light = scene.tool === 'light'
			ctx.beginPath()
			ctx.arc(x, y, r, 0, TAU)
			ctx.fillStyle = light ? 'rgba(200, 215, 255, 0.07)' : 'rgba(0, 0, 0, 0.22)'
			ctx.fill()
			ctx.setLineDash([2.5, 3.5])
			ctx.lineWidth = 1.1
			ctx.strokeStyle = light ? rgba(c.text, 0.8) : rgba(c.text2, 0.7)
			ctx.stroke()
			ctx.setLineDash([])
			ctx.beginPath()
			ctx.moveTo(x - 4, y)
			ctx.lineTo(x + 4, y)
			ctx.moveTo(x, y - 4)
			ctx.lineTo(x, y + 4)
			ctx.lineWidth = 1
			ctx.strokeStyle = rgba(c.text, 0.8)
			ctx.stroke()
		}
	}

	// --- Slime vs S+U ----------------------------------------------------------

	const METRICS = [
		{key: 'cost', name: 'Track length', note: '× the straight-line tree', max: 3.5, fmt: (v) => [v.toFixed(2), '×']},
		{key: 'detour', name: 'Detour', note: 'farther than a straight line', max: 1, fmt: (v) => [`+${Math.round(v * 100)}`, '%']},
		{key: 'tolerance', name: 'Survives a cut', note: 'chance one broken tube strands no flake', max: 1, fmt: (v) => [String(Math.round(v * 100)), '%']},
	]
	const WHO = {slime: 'Slime', rail: 'S+U'}
	const WAITING = 'Once the slime has linked a few oat flakes with tubes, its network is measured here against the S+U.'

	const make = (tag, className, text) => {
		const node = document.createElement(tag)
		if (className) node.className = className
		if (text != null) node.textContent = text
		return node
	}

	const bar = (who) => {
		const track = make('span', `bar bar-${who}`)
		track.setAttribute('aria-hidden', 'true')
		const fill = make('span', 'fill')
		track.append(fill)
		return {track, fill}
	}

	// The panel is built once and then only its numbers change, so the bars
	// can glide from one reading to the next.
	const panels = new WeakMap()
	function build(box) {
		const cells = {}
		const rows = METRICS.map((m) => {
			const row = make('div', 'metric')
			row.dataset.key = m.key
			const label = make('p', 'metric-label')
			label.append(make('span', 'metric-name', m.name), make('span', 'metric-note', m.note))
			const values = [], bars = []
			cells[m.key] = {}
			for (const who of ['slime', 'rail']) {
				const value = make('p', `value value-${who}`)
				const num = make('span', 'num', '–')
				const unit = make('span', 'unit')
				value.append(make('span', 'sr-only', `${WHO[who]}: `), num, unit)
				const b = bar(who)
				values.push(value)
				bars.push(b.track)
				cells[m.key][who] = {num, unit, fill: b.fill}
			}
			row.append(label, ...values, ...bars)
			return row
		})
		const along = make('div', 'along')
		const alongLabel = make('p', 'metric-label')
		alongLabel.append(make('span', 'metric-name', 'Along the rails'))
		const alongText = make('p', 'along-text')
		const alongNum = make('b', 'along-num', '–')
		alongText.append('Built ', alongNum, ' of the real track')
		const alongBar = bar('along')
		along.append(alongLabel, alongText, alongBar.track)
		const foot = make('p', 'verdict-wait', WAITING)
		box.replaceChildren(...rows, along, foot)
		const panel = {first: rows[0], cells, alongNum, alongFill: alongBar.fill, foot}
		panels.set(box, panel)
		return panel
	}

	const clamp01 = (v) => Math.min(1, Math.max(0, v))

	// result: null while there's nothing to measure yet, or NetworkMetrics.compare()'s
	// {slime, rail, mst, overlap: {railBuilt, slimeOnRail}, foot}
	function verdict(box, result) {
		let panel = panels.get(box)
		if (!panel || panel.first.parentNode !== box) panel = build(box)
		const ok = !!(result && result.slime && result.rail)
		box.classList.toggle('is-waiting', !ok)
		for (const m of METRICS) {
			for (const who of ['slime', 'rail']) {
				const cell = panel.cells[m.key][who]
				const v = ok ? result[who][m.key] : null
				const known = typeof v === 'number' && Number.isFinite(v)
				const [num, unit] = known ? m.fmt(v) : ['–', '']
				if (cell.num.textContent !== num) cell.num.textContent = num
				if (cell.unit.textContent !== unit) cell.unit.textContent = unit
				cell.fill.style.setProperty('--v', known ? clamp01(v / m.max).toFixed(3) : '0')
			}
		}
		const built = ok && result.overlap && Number.isFinite(result.overlap.railBuilt) ? result.overlap.railBuilt : null
		panel.alongNum.textContent = built == null ? '–' : `${Math.round(built * 100)}%`
		panel.alongFill.style.setProperty('--v', built == null ? '0' : clamp01(built).toFixed(3))
		// under it all, one plain sentence, or what the panel is waiting for
		const foot = ok ? result.foot || '' : WAITING
		panel.foot.className = ok ? 'verdict-foot' : 'verdict-wait'
		if (panel.foot.textContent !== foot) panel.foot.textContent = foot
	}

	// --- The lab log -------------------------------------------------------------

	// entry: {time: 'm:ss', text, you: the visitor did it, far: km from the start or null}
	function logItem(entry) {
		const li = document.createElement('li')
		li.className = 'fresh'
		li.dataset.kind = entry.you ? 'you' : entry.far != null ? 'reached' : 'note'
		const time = make('time', '', entry.time)
		const what = make('span', entry.you ? 'what you' : 'what', entry.text)
		const dist = make('span', 'far', entry.far == null ? '' : `${entry.far.toFixed(1)} km`)
		li.append(time, what, dist)
		return li
	}

	// --- The page's own controls ------------------------------------------------------

	function wire() {
		const watch = (node, fn) => {
			new MutationObserver(fn).observe(node, {childList: true, characterData: true, subtree: true})
			fn()
		}

		// app.js writes "Pause" or "Play" into #play; the icon and the tip follow
		const play = document.getElementById('play')
		if (play) {
			watch(play, () => {
				const paused = play.textContent.trim().toLowerCase() === 'play'
				const icon = paused ? 'play' : 'pause'
				if (play.dataset.icon !== icon) {
					play.dataset.icon = icon
					play.dataset.tip = paused ? 'Play · Space' : 'Pause · Space'
				}
			})
		}

		// how far the slime has got, as the hairline over the readings
		const reached = document.getElementById('hud-reached')
		const fill = document.querySelector('.progress-fill')
		if (reached && fill) {
			let last = ''
			watch(reached, () => {
				const m = /(\d+)\D+(\d+)/.exec(reached.textContent)
				const p = m && Number(m[2]) > 0 ? clamp01(Number(m[1]) / Number(m[2])).toFixed(3) : '0'
				if (p !== last) fill.style.setProperty('--p', (last = p))
			})
		}

		// popovers: one at a time, and they close on a click elsewhere or Escape
		const pops = [...document.querySelectorAll('details.pop')]
		for (const d of pops) {
			d.addEventListener('toggle', () => {
				if (d.open) for (const other of pops) if (other !== d) other.open = false
			})
		}
		document.addEventListener('pointerdown', (e) => {
			for (const d of pops) if (d.open && !d.contains(e.target)) d.open = false
		})
		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape') return
			for (const d of pops) {
				if (!d.open) continue
				d.open = false
				d.querySelector('summary')?.focus()
			}
		})
	}

	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire)
		else wire()
	}

	return {readColors, drawOverlay, verdict, logItem}
})()
