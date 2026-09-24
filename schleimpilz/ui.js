'use strict'

// Everything the page draws on top of the dish (oat flakes, names, the real
// network, the scale), and the markup of the results panel and the lab log.
// app.js owns the state and calls these; this file owns how they look.

const DishUI = (() => {
	const TAU = Math.PI * 2

	// Colours and fonts for the overlay, from the CSS custom properties.
	function readColors(cs) {
		const css = (name) => cs.getPropertyValue(name).trim()
		return {
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
	}

	// an oat flake: a rolled, slightly irregular oval
	function oatFlake(ctx, c, x, y, r, seed, fed) {
		let s = (seed * 7919) % 233280
		const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280
		ctx.save()
		ctx.translate(x, y)
		ctx.rotate(rnd() * Math.PI)
		ctx.beginPath()
		const n = 11
		for (let i = 0; i <= n; i++) {
			const a = (i / n) * TAU
			const k = 1 + (rnd() - 0.5) * 0.18
			const px = Math.cos(a) * r * 1.25 * k, py = Math.sin(a) * r * 0.85 * k
			i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
		}
		ctx.closePath()
		const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r * 1.3)
		g.addColorStop(0, fed ? c.oatFed : c.oat)
		g.addColorStop(1, c.oatEdge)
		ctx.fillStyle = g
		ctx.fill()
		ctx.lineWidth = 0.8
		ctx.strokeStyle = c.oatEdge
		ctx.stroke()
		ctx.restore()
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
		const z = Math.min(1.3, Math.max(0.7, size / 820))
		const fz = z * Math.min(1.8, Math.sqrt(scene.zoom)) // flakes grow a little when you look closer
		const onScreen = (x, y, m = 24) => x > -m && y > -m && x < size + m && y < size + m
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		ctx.clearRect(0, 0, size, size)

		if (scene.showRail) {
			ctx.save()
			ctx.beginPath()
			ctx.arc(dish.cx, dish.cy, dish.r - 2, 0, TAU)
			ctx.clip()
			ctx.lineCap = 'round'
			ctx.lineJoin = 'round'
			// track the slime built too is solid, the rest dashed
			const cov = scene.railCoverage
			for (const pass of ['U', 'S']) {
				for (const built of [false, true]) {
					ctx.beginPath()
					scene.edges.forEach(([a, b, mode], i) => {
						if (mode !== pass) return
						if (cov ? cov[i] >= 0.5 !== built : !built) return
						ctx.moveTo(...toCss(scene.stations[a].x, scene.stations[a].y))
						ctx.lineTo(...toCss(scene.stations[b].x, scene.stations[b].y))
					})
					ctx.strokeStyle = pass === 'S' ? c.railS : c.railU
					ctx.lineWidth = (pass === 'S' ? 2.2 : 1.5) * z * (built ? 1 : 0.85)
					ctx.globalAlpha = built ? 0.92 : 0.7
					ctx.setLineDash(built ? [] : [4 * z, 3.5 * z])
					ctx.stroke()
				}
			}
			ctx.setLineDash([])
			ctx.globalAlpha = 1
			ctx.fillStyle = c.paper
			ctx.strokeStyle = c.ink
			ctx.lineWidth = 0.9
			for (const st of scene.stations) {
				const [x, y] = toCss(st.x, st.y)
				if (!onScreen(x, y)) continue
				ctx.beginPath()
				ctx.arc(x, y, 1.6 * fz, 0, TAU)
				ctx.fill()
				ctx.stroke()
			}
			ctx.restore()
		}

		const flakeAt = scene.flakes.map((f) => (f.alive ? toCss(f.x, f.y) : null))
		scene.flakes.forEach((f, i) => {
			const at = flakeAt[i]
			if (!at || !onScreen(...at)) return
			const big = f.kind === 'code' ? 1.3 : 1
			oatFlake(ctx, c, at[0], at[1], 4.4 * fz * big, i + 1, scene.reached.has(i) && f.kind !== 'code')
			if (f.kind === 'code') {
				ctx.beginPath()
				ctx.arc(at[0], at[1], 10 * fz, 0, TAU)
				ctx.strokeStyle = c.ink
				ctx.lineWidth = 1.4
				ctx.stroke()
			}
		})

		// names, placed so they sit neither on each other nor on a flake
		const placed = flakeAt.filter(Boolean).map(([x, y]) => [x - 7 * fz, y - 6 * fz, 14 * fz, 12 * fz])
		const fontSize = Math.round(11 * Math.min(1.15, z))
		const label = (text, x, y, strong) => {
			ctx.font = `${strong ? 700 : 600} ${fontSize}px ${c.mono}`
			const w = ctx.measureText(text).width
			const h = fontSize + 2
			const gap = 9 * fz
			for (const [lx, ly] of [
				[x + gap, y - h / 2],
				[x - gap - w, y - h / 2],
				[x - w / 2, y - gap - h],
				[x - w / 2, y + gap],
			]) {
				if (lx < 4 || ly < 4 || lx + w > size - 4 || ly + h > size - 4) continue
				if (Math.hypot(lx + w / 2 - dish.cx, ly + h / 2 - dish.cy) > dish.r - 14) continue
				if (placed.some((r) => lx < r[0] + r[2] && lx + w > r[0] && ly < r[1] + r[3] && ly + h > r[1])) continue
				placed.push([lx - 2, ly - 1, w + 4, h + 2])
				ctx.textBaseline = 'middle'
				ctx.lineWidth = 3
				ctx.lineJoin = 'round'
				ctx.strokeStyle = c.halo
				ctx.strokeText(text, lx, ly + h / 2)
				ctx.fillStyle = strong ? c.ink : c.muted
				ctx.fillText(text, lx, ly + h / 2)
				return
			}
		}
		const start = scene.flakes[0]
		if (start && start.kind === 'code' && flakeAt[0]) label('CODE', flakeAt[0][0] + 5 * fz, flakeAt[0][1], true)
		if (scene.showNames) {
			// the flakes come busiest first, so a small dish names the big ones
			let room = size * scene.zoom > 480 ? Infinity : 10
			scene.flakes.forEach((f, i) => {
				if (f.kind === 'station' && flakeAt[i] && onScreen(...flakeAt[i], 0) && room-- > 0) label(f.name, flakeAt[i][0], flakeAt[i][1], false)
			})
		}

		// north, top right, and a scale, bottom right: on the bench, off the dish
		ctx.fillStyle = c.muted
		ctx.strokeStyle = c.muted
		ctx.textBaseline = 'alphabetic'
		ctx.font = `600 ${fontSize}px ${c.mono}`
		const nx = size - 26 * z, ny = 30 * z
		ctx.beginPath()
		ctx.moveTo(nx, ny - 14 * z)
		ctx.lineTo(nx + 5 * z, ny)
		ctx.lineTo(nx, ny - 3 * z)
		ctx.lineTo(nx - 5 * z, ny)
		ctx.closePath()
		ctx.fill()
		ctx.textAlign = 'center'
		ctx.fillText('N', nx, ny + 14 * z)
		const km = [10, 5, 2, 1, 0.5].find((d) => d * scene.pxPerKm * s <= 150 * z) || 0.5
		const barW = km * scene.pxPerKm * s
		const bx = size - 18 * z - barW, by = size - 20 * z
		ctx.lineWidth = 1.5
		ctx.beginPath()
		ctx.moveTo(bx, by - 4)
		ctx.lineTo(bx, by)
		ctx.lineTo(bx + barW, by)
		ctx.lineTo(bx + barW, by - 4)
		ctx.stroke()
		ctx.fillText(km < 1 ? `${km * 1000} m` : `${km} km`, bx + barW / 2, by - 8 * z)
		ctx.textAlign = 'start'

		if (scene.pointer && scene.tool !== 'food') {
			ctx.beginPath()
			ctx.arc(scene.pointer.x, scene.pointer.y, scene.brush * s, 0, TAU)
			ctx.strokeStyle = c.ink
			ctx.setLineDash([3, 3])
			ctx.lineWidth = 1
			ctx.stroke()
			ctx.setLineDash([])
		}
	}

	// --- Slime against rail ----------------------------------------------------

	const METRIC_ROWS = [
		{key: 'cost', name: 'Track length', note: 'times the shortest network that links every flake', max: 3.5, fmt: (v) => `${v.toFixed(2)}×`},
		{key: 'detour', name: 'Detour', note: 'extra distance between two flakes, against a straight line', max: 1, fmt: (v) => `+${Math.round(v * 100)}%`},
		{key: 'tolerance', name: 'Survives a cut', note: 'chance a single broken link cuts no flake off', max: 1, fmt: (v) => `${Math.round(v * 100)}%`},
	]

	// result: null while there's nothing to measure yet, or NetworkMetrics.compare()'s
	// {slime, rail, mst, overlap: {railBuilt, slimeOnRail}, foot}
	function verdict(box, result) {
		if (!result || !result.slime || !result.rail) {
			const p = document.createElement('p')
			p.className = 'verdict-wait'
			p.textContent = 'The slime needs to reach a few more oat flakes before it can be measured.'
			box.replaceChildren(p)
			return
		}
		const rows = METRIC_ROWS.filter((r) => result.slime[r.key] != null && result.rail[r.key] != null)
		const parts = []
		if (result.overlap) {
			parts.push(
				Object.assign(document.createElement('p'), {
					className: 'verdict-overlap',
					textContent: `The slime built ${Math.round(result.overlap.railBuilt * 100)}% of the real track, and ${Math.round(result.overlap.slimeOnRail * 100)}% of its tubes run along it.`,
				}),
			)
		}
		for (const r of rows) {
			const el = document.createElement('div')
			el.className = 'metric'
			el.dataset.key = r.key
			const bar = (who, label, v) =>
				`<div class="bar bar-${who}"><span>${label}</span><span class="track"><span class="fill" style="--v:${Math.min(1, v / r.max).toFixed(3)}"></span></span><output>${r.fmt(v)}</output></div>`
			el.innerHTML = `<div class="metric-head"><span class="metric-name">${r.name}</span><span class="metric-note">${r.note}</span></div>${bar('slime', 'Slime', result.slime[r.key])}${bar('rail', 'S+U', result.rail[r.key])}`
			parts.push(el)
		}
		parts.push(Object.assign(document.createElement('p'), {className: 'verdict-foot', textContent: result.foot || ''}))
		box.replaceChildren(...parts)
	}

	// --- The lab log -------------------------------------------------------------

	// entry: {time: 'm:ss', text, you: the visitor did it, far: km from the start or null}
	function logItem(entry) {
		const li = document.createElement('li')
		li.className = 'fresh'
		const time = document.createElement('time')
		time.textContent = entry.time
		const what = document.createElement('span')
		what.textContent = entry.text
		if (entry.you) what.className = 'you'
		const dist = document.createElement('span')
		dist.className = 'far'
		dist.textContent = entry.far == null ? '' : `${entry.far.toFixed(1)} km`
		li.append(time, what, dist)
		return li
	}

	return {readColors, drawOverlay, verdict, logItem}
})()
