#!/usr/bin/env node
// Runs the tube network without a browser and writes PNG snapshots, a
// contact sheet of them, some numbers on the network and how long each step
// took, for tuning the model quickly.
//
//   node tools/preview.mjs [steps=3000] [every=250] [out=tests/output/model/<setup>]
//   SETUP=ring node tools/preview.mjs           the 27 Ringbahn stations
//   SETUP=none node tools/preview.mjs           only CODE
//   PARAMS='{"mu":1.5}' node tools/preview.mjs  other model settings
//   SPACING_KM=0.5 node tools/preview.mjs       a coarser mesh
//   ADAPT=1 node tools/preview.mjs              take a flake away, add one, shine a light
//   NET=path/to/network.js                      another version of the model
//
// With ADAPT=1 the hand comes in three times: at REMOVE (default 2000) the
// best connected oat flake is taken away, at ADD (2600) a new one goes down
// on ground the slime has covered, away from its tubes, and at LIGHT (3200)
// a lamp is put over a busy tube. Steps default to 3800 then.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {deflateSync} from 'node:zlib'
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {performance} from 'node:perf_hooks'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const SlimeNetwork = require(process.env.NET ? resolve(process.env.NET) : '../network.js')
const root = new URL('..', import.meta.url)
const ctx = {}
vm.runInNewContext(readFileSync(new URL('data/berlin.js', root), 'utf8') + ';this.BERLIN = BERLIN', ctx)
const B = ctx.BERLIN

const ADAPT = !!process.env.ADAPT
const SETUP = process.env.SETUP || 'hubs'
const STEPS = Number(process.argv[2]) || (ADAPT ? 3800 : 3000)
const EVERY = Number(process.argv[3]) || 250
const OUT = process.argv[4] || new URL(`tests/output/model/${SETUP}${ADAPT ? '-adapt' : ''}`, root).pathname
const EVENTS = {remove: Number(process.env.REMOVE) || 2000, add: Number(process.env.ADD) || 2600, light: Number(process.env.LIGHT) || 3200}
mkdirSync(OUT, {recursive: true})

const W = 1024, H = Math.round((W * B.km[1]) / B.km[0])
const PX_PER_KM = W / B.km[0]

// the same ground as the page: near a stop is city, a bit farther parkland
export function groundMasks() {
	const bytes = Buffer.from(B.city, 'base64')
	const pts = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
	const dist = new Float32Array(W * H).fill(1e9)
	const R = Math.ceil(1.7 * PX_PER_KM)
	for (let i = 0; i < pts.length; i += 2) {
		const x = (pts[i] / 65535) * W, y = (pts[i + 1] / 65535) * H
		for (let yy = Math.max(0, Math.floor(y - R)); yy <= Math.min(H - 1, Math.ceil(y + R)); yy++)
			for (let xx = Math.max(0, Math.floor(x - R)); xx <= Math.min(W - 1, Math.ceil(x + R)); xx++) {
				const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / PX_PER_KM
				const k = yy * W + xx
				if (d < dist[k]) dist[k] = d
			}
	}
	return dist
}
const dist = groundMasks()
const at = (x, y) => dist[Math.min(H - 1, Math.max(0, Math.floor(y))) * W + Math.min(W - 1, Math.max(0, Math.floor(x)))]
const inside = (x, y) => at(x, y) < 1.6
const park = (x, y) => Math.min(1, Math.max(0, (at(x, y) - 0.4) / 0.3))

const spacingKm = Number(process.env.SPACING_KM) || 0.4
const t0 = Date.now()
const net = new SlimeNetwork({width: W, height: H, spacing: spacingKm * PX_PER_KM, inside, park})
Object.assign(net.params, JSON.parse(process.env.PARAMS || '{}'))
console.log(`mesh: ${net.nodeCount} nodes, ${net.edgeCount} edges, ${spacingKm} km apart (${Date.now() - t0} ms)`)

const st = (i) => ({x: B.stations[i][1] * W, y: B.stations[i][2] * H, name: B.stations[i][0]})
const list = SETUP === 'ring' ? B.ring : SETUP === 'none' ? [] : B.hubs
const flakes = [{x: B.code[1] * W, y: B.code[2] * H, name: B.code[0], alive: true}, ...list.map((i) => ({...st(i), alive: true}))]
const setFlakes = () => net.setFlakes(flakes.map(({x, y, alive}) => ({x, y, alive})))
setFlakes()
net.inoculate(0)
let lamp = null // {x, y, r} while the light is on

// --- tiny PNG writer ---
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc = (buf) => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
function png(path, img, w = W, h = H) {
	const raw = Buffer.alloc((w * 3 + 1) * h)
	for (let y = 0; y < h; y++) img.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
	writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

// a 3x5 pixel font for the step number on the pictures
const GLYPH = {0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7], 4: [5, 5, 7, 1, 1], 5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 1, 1, 1], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7]}

// the far end of edge e from node i
const other = (e, i) => (net.a[e] === i ? net.b[e] : net.a[e])

// Strong tubes as a graph, and what it says about the network.
function measure() {
	const {D, a, b, alive, length} = net
	let dmax = 0
	const ds = []
	for (let e = 0; e < net.edgeCount; e++) if (alive[a[e]] && alive[b[e]] && D[e] > 2 * net.params.minD) ds.push(D[e])
	ds.sort((p, q) => p - q)
	dmax = ds.length ? ds[Math.floor(0.995 * (ds.length - 1))] : 0
	const ref = Math.max(dmax, 0.05)
	const tube = new Uint8Array(net.edgeCount)
	let km = 0, faint = 0
	for (let e = 0; e < net.edgeCount; e++) {
		if (!alive[a[e]] || !alive[b[e]]) continue
		if (D[e] >= 0.1 * ref) (tube[e] = 1), (km += length[e] / PX_PER_KM)
		else if (D[e] >= 0.02 * ref) faint += length[e] / PX_PER_KM
	}
	// components, degrees
	const N = net.nodeCount
	const deg = new Int32Array(N)
	for (let e = 0; e < net.edgeCount; e++) if (tube[e]) deg[a[e]]++, deg[b[e]]++
	const comp = new Int32Array(N).fill(-1)
	let nc = 0, nodes = 0, edges = 0
	for (let s = 0; s < N; s++) {
		if (comp[s] >= 0 || !deg[s]) continue
		const stack = [s]
		comp[s] = nc
		while (stack.length) {
			const i = stack.pop()
			nodes++
			for (let k = net.adjStart[i]; k < net.adjStart[i + 1]; k++) {
				const e = net.adjEdge[k]
				if (!tube[e]) continue
				const j = other(net.adjEdge[k], i)
				if (comp[j] < 0) (comp[j] = nc), stack.push(j)
			}
		}
		nc++
	}
	for (let e = 0; e < net.edgeCount; e++) edges += tube[e]
	// bridges: tubes whose loss would cut the network in two (Tarjan)
	const disc = new Int32Array(N).fill(-1), low = new Int32Array(N)
	let clock = 0, bridgeKm = 0
	for (let s = 0; s < N; s++) {
		if (!deg[s] || disc[s] >= 0) continue
		const stack = [[s, -1, net.adjStart[s]]]
		disc[s] = low[s] = clock++
		while (stack.length) {
			const top = stack[stack.length - 1]
			const [i, via] = top
			if (top[2] < net.adjStart[i + 1]) {
				const k = top[2]++
				const e = net.adjEdge[k]
				if (!tube[e] || e === via) continue
				const j = other(net.adjEdge[k], i)
				if (disc[j] < 0) {
					disc[j] = low[j] = clock++
					stack.push([j, e, net.adjStart[j]])
				} else low[i] = Math.min(low[i], disc[j])
			} else {
				stack.pop()
				if (stack.length) {
					const p = stack[stack.length - 1][0]
					low[p] = Math.min(low[p], low[i])
					if (low[i] > disc[p]) bridgeKm += length[via] / PX_PER_KM
				}
			}
		}
	}
	const flakeNodes = new Set(net.flakes.filter((f) => f.alive && f.node >= 0).map((f) => f.node))
	let deadEnds = 0
	for (let i = 0; i < N; i++) if (deg[i] === 1 && !flakeNodes.has(i)) deadEnds++
	// which flakes hang on the main network
	const sizes = new Int32Array(nc)
	for (let i = 0; i < N; i++) if (comp[i] >= 0) sizes[comp[i]]++
	let main = -1
	for (const f of net.flakes) if (f.alive && f.node >= 0 && comp[f.node] >= 0 && (main < 0 || sizes[comp[f.node]] > sizes[main])) main = comp[f.node]
	const living = net.flakes.filter((f) => f.alive && f.node >= 0)
	const connected = living.filter((f) => comp[f.node] === main && main >= 0).length
	// how far out of the way the network runs between neighbouring flakes
	let detour = 0, pairs = 0
	if (main >= 0) {
		const nodesOf = living.filter((f) => comp[f.node] === main).map((f) => f.node)
		for (const s of nodesOf) {
			const d = new Float64Array(N).fill(Infinity)
			d[s] = 0
			const heap = [[0, s]]
			while (heap.length) {
				heap.sort((p, q) => q[0] - p[0])
				const [dd, i] = heap.pop()
				if (dd > d[i]) continue
				for (let k = net.adjStart[i]; k < net.adjStart[i + 1]; k++) {
					const e = net.adjEdge[k]
					if (!tube[e]) continue
					const j = other(net.adjEdge[k], i), nd = dd + length[e]
					if (nd < d[j]) (d[j] = nd), heap.push([nd, j])
				}
			}
			const near = nodesOf.filter((t) => t !== s).map((t) => ({t, e: Math.hypot(net.x[t] - net.x[s], net.y[t] - net.y[s])})).sort((p, q) => p.e - q.e).slice(0, 3)
			for (const {t, e} of near) if (isFinite(d[t]) && e > 0) (detour += d[t] / e), pairs++
		}
	}
	// braids: tubes running right alongside another tube, one mesh cell away
	const cell = net.spacing, grid = new Map()
	const mid = (e) => [(net.x[a[e]] + net.x[b[e]]) / 2, (net.y[a[e]] + net.y[b[e]]) / 2]
	for (let e = 0; e < net.edgeCount; e++) {
		if (!tube[e]) continue
		const [mx, my] = mid(e), key = Math.floor(my / cell) * 4096 + Math.floor(mx / cell)
		if (!grid.has(key)) grid.set(key, [])
		grid.get(key).push(e)
	}
	let braidKm = 0
	for (let e = 0; e < net.edgeCount; e++) {
		if (!tube[e]) continue
		const [mx, my] = mid(e), cx = Math.floor(mx / cell), cy = Math.floor(my / cell)
		const ux = (net.x[b[e]] - net.x[a[e]]) / length[e], uy = (net.y[b[e]] - net.y[a[e]]) / length[e]
		let found = false
		for (let yy = cy - 1; yy <= cy + 1 && !found; yy++)
			for (let xx = cx - 1; xx <= cx + 1 && !found; xx++)
				for (const f of grid.get(yy * 4096 + xx) || []) {
					if (f === e || a[f] === a[e] || a[f] === b[e] || b[f] === a[e] || b[f] === b[e]) continue
					const [fx, fy] = mid(f)
					if ((fx - mx) ** 2 + (fy - my) ** 2 > (1.3 * cell) ** 2) continue
					const vx = (net.x[b[f]] - net.x[a[f]]) / length[f], vy = (net.y[b[f]] - net.y[a[f]]) / length[f]
					if (Math.abs(ux * vx + uy * vy) > 0.8) found = true
				}
		if (found) braidKm += length[e] / PX_PER_KM
	}
	return {
		tube, ref, tubeKm: km, faintKm: faint, braided: km ? braidKm / km : 0, edges, nodes, components: nc, loops: edges - nodes + nc, deadEnds,
		bridged: km ? bridgeKm / km : 0, connected, alive: living.length, detour: pairs ? detour / pairs : 0,
		p50: ds.length ? ds[Math.floor(0.5 * (ds.length - 1))] : 0, p90: ds.length ? ds[Math.floor(0.9 * (ds.length - 1))] : 0,
	}
}

function snapshot(name, label) {
	const img = Buffer.alloc(W * H * 3)
	for (let k = 0; k < W * H; k++) {
		const d = dist[k]
		img.set(d < 0.5 ? [242, 243, 235] : d < 1.6 ? [221, 227, 208] : [205, 212, 191], k * 3)
	}
	const blend = (x, y, c, a) => {
		x = Math.round(x); y = Math.round(y)
		if (x < 0 || y < 0 || x >= W || y >= H) return
		const k = (y * W + x) * 3
		for (let i = 0; i < 3; i++) img[k + i] = img[k + i] * (1 - a) + c[i] * a
	}
	const disc = (x, y, r, c, a) => {
		for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
			for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
				if (dx * dx + dy * dy <= r * r + 0.25) blend(x + dx, y + dy, c, a)
	}
	if (lamp) for (let dy = -lamp.r; dy <= lamp.r; dy++) for (let dx = -lamp.r; dx <= lamp.r; dx++) if (dx * dx + dy * dy <= lamp.r * lamp.r) blend(lamp.x + dx, lamp.y + dy, [255, 250, 150], 0.5)
	// where the slime has been
	for (let i = 0; i < net.nodeCount; i++) if (net.alive[i]) disc(net.x[i], net.y[i], 2.2, [236, 226, 160], 0.35)
	const m = measure()
	for (let e = 0; e < net.edgeCount; e++) {
		const a = net.a[e], b = net.b[e]
		if (!net.alive[a] || !net.alive[b]) continue
		const rel = Math.min(1, net.D[e] / m.ref)
		if (rel < 0.01) continue
		const width = 0.6 + 5.4 * Math.sqrt(rel)
		const alpha = Math.min(1, 0.12 + 1.1 * Math.sqrt(rel))
		const x0 = net.x[a], y0 = net.y[a], x1 = net.x[b], y1 = net.y[b]
		const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
		const col = rel > 0.3 ? [201, 129, 0] : [239, 185, 0]
		for (let s = 0; s <= n; s++) disc(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, width / 2, col, alpha)
	}
	net.flakes.forEach((f, i) => {
		const g = flakes[i]
		if (!g) return
		if (!f.alive) {
			for (let d = -5; d <= 5; d++) blend(g.x + d, g.y + d, [200, 30, 30], 1), blend(g.x + d, g.y - d, [200, 30, 30], 1)
			return
		}
		disc(g.x, g.y, 3.5, g.added ? [30, 90, 200] : [90, 60, 30], 1)
	})
	// label: step number, top left, 4x pixels
	const text = String(label ?? name)
	let cx = 12
	for (const ch of text) {
		const g = GLYPH[ch]
		if (g) for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r] & (4 >> c)) for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) blend(cx + c * 4 + xx, 12 + r * 4 + yy, [60, 60, 60], 1)
		cx += 16
	}
	png(`${OUT}/${name}.png`, img)
	return img
}

// When the growing edge gets where: bands of 50 steps each, from the time
// the slime is put down.
function fronts() {
	const img = Buffer.alloc(W * H * 3)
	for (let k = 0; k < W * H; k++) img.set(dist[k] < 1.6 ? [236, 238, 228] : [205, 212, 191], k * 3)
	const band = 50 * net.params.growth * net.spacing * net.params.dt
	for (let i = 0; i < net.nodeCount; i++) {
		const t = net.arrival[i] / band
		if (!isFinite(t)) continue
		const c = Math.floor(t) & 1 ? [214, 160, 40] : [240, 200, 110]
		const r = Math.ceil(net.spacing * 0.6)
		for (let dy = -r; dy <= r; dy++)
			for (let dx = -r; dx <= r; dx++) {
				const x = Math.round(net.x[i] + dx), y = Math.round(net.y[i] + dy)
				if (x >= 0 && y >= 0 && x < W && y < H && dx * dx + dy * dy <= r * r) img.set(c, (y * W + x) * 3)
			}
	}
	for (const f of flakes) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9) img.set([90, 60, 30], (Math.round(f.y + dy) * W + Math.round(f.x + dx)) * 3)
	png(`${OUT}/fronts.png`, img)
}

// a contact sheet: every snapshot at a third of the size, in rows of four
function sheet(images) {
	const s = 3, w = Math.floor(W / s), h = Math.floor(H / s), cols = 4, rows = Math.ceil(images.length / cols)
	const out = Buffer.alloc(cols * w * rows * h * 3, 255)
	images.forEach((img, n) => {
		const ox = (n % cols) * w, oy = Math.floor(n / cols) * h
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++)
				for (let c = 0; c < 3; c++) {
					let sum = 0
					for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s; xx++) sum += img[((y * s + yy) * W + x * s + xx) * 3 + c]
					out[((oy + y) * cols * w + ox + x) * 3 + c] = sum / (s * s)
				}
	})
	png(`${OUT}/sheet.png`, out, cols * w, rows * h)
}

// how much of the tube network is the same as at the last snapshot, and how
// much the tube at each flake swells and shrinks as the flakes take turns
let lastTubes = null
const swing = new Map() // flake node -> [min, max] of its thickest tube lately
const trackSwing = () => {
	for (const f of net.flakes) {
		if (!f.alive || f.node < 0) continue
		let d = 0
		for (let k = net.adjStart[f.node]; k < net.adjStart[f.node + 1]; k++) d = Math.max(d, net.D[net.adjEdge[k]])
		const w = swing.get(f.node)
		if (w) (w[0] = Math.min(w[0], d)), (w[1] = Math.max(w[1], d))
		else swing.set(f.node, [d, d])
	}
}
const settle = (m) => {
	let same = 0, either = 0
	if (lastTubes) for (let e = 0; e < net.edgeCount; e++) (same += lastTubes[e] & m.tube[e]), (either += lastTubes[e] | m.tube[e])
	lastTubes = m.tube
	const ratios = [...swing.values()].filter(([lo]) => lo > 0).map(([lo, hi]) => hi / lo).sort((p, q) => p - q)
	swing.clear()
	return {same: either ? same / either : 1, swing: ratios.length ? ratios[ratios.length >> 1] : 1}
}
const fmt = (m) =>
	`flakes on the network ${m.connected}/${m.alive}, tubes ${m.tubeKm.toFixed(0)} km (+${m.faintKm.toFixed(0)} km faint), ` +
	`loops ${m.loops}, ${(100 * m.bridged).toFixed(0)}% of it tree-like, ${(100 * m.braided).toFixed(0)}% braided, dead ends ${m.deadEnds}, pieces ${m.components}, ` +
	`detour ${m.detour.toFixed(2)}, D median ${m.p50.toFixed(3)} p90 ${m.p90.toFixed(3)} top ${m.ref.toFixed(3)}, ` +
	`${(100 * m.same).toFixed(0)}% same as before, flake tubes swing ${m.swing.toFixed(2)}x`

// --- the hand, for ADAPT ---
const nearTube = (x, y, r) => {
	// strongest tube within r px of a point
	let best = 0
	const m = measure()
	for (let e = 0; e < net.edgeCount; e++) {
		const mx = (net.x[net.a[e]] + net.x[net.b[e]]) / 2, my = (net.y[net.a[e]] + net.y[net.b[e]]) / 2
		if ((mx - x) ** 2 + (my - y) ** 2 <= r * r) best = Math.max(best, net.D[e] / m.ref)
	}
	return best
}
const watch = [] // things to report on as time goes by
function removeFlake() {
	// the flake with the most tube around it, but not where the slime started
	let best = -1, score = 0
	net.flakes.forEach((f, i) => {
		if (i === 0 || !f.alive || f.node < 0) return
		let s = 0
		for (let k = net.adjStart[f.node]; k < net.adjStart[f.node + 1]; k++) s += net.D[net.adjEdge[k]]
		if (s > score) (score = s), (best = i)
	})
	const f = flakes[best]
	f.alive = false
	setFlakes()
	console.log(`  took away ${f.name}`)
	watch.push({what: `tubes at ${f.name}`, test: () => nearTube(f.x, f.y, 0.8 * PX_PER_KM), goal: (v) => v < 0.1, since: net.steps})
}
function addFlake() {
	// a station the slime has covered, as far from its tubes as can be
	const names = ['Tegel', 'Marzahn', 'Rathaus Steglitz', 'Tempelhof', 'Lichtenberg', 'Westend', 'Treptower Park', 'Hauptbahnhof', 'Wedding', 'Alexanderplatz']
	let best = null, bestD = 0
	const m = measure()
	for (const name of names) {
		const i = B.stations.findIndex((s) => s[0] === name)
		if (i < 0 || flakes.some((f) => f.name === name)) continue
		const p = st(i), node = net.nearestNode(p.x, p.y)
		if (node < 0 || !net.alive[node]) continue
		let d = Infinity
		for (let e = 0; e < net.edgeCount; e++) {
			if (net.D[e] < 0.1 * m.ref) continue
			const mx = (net.x[net.a[e]] + net.x[net.b[e]]) / 2, my = (net.y[net.a[e]] + net.y[net.b[e]]) / 2
			d = Math.min(d, Math.hypot(mx - p.x, my - p.y))
		}
		if (d > bestD && d < 5 * PX_PER_KM) (bestD = d), (best = p)
	}
	if (!best) return console.log('  no place for a new flake')
	flakes.push({...best, alive: true, added: true})
	setFlakes()
	console.log(`  put down ${best.name}, ${(bestD / PX_PER_KM).toFixed(1)} km from the nearest tube`)
	const idx = flakes.length - 1
	watch.push({
		what: `tube to ${best.name}`,
		test: () => {
			const mm = measure()
			const node = net.flakes[idx].node
			let s = 0
			for (let k = net.adjStart[node]; k < net.adjStart[node + 1]; k++) s = Math.max(s, net.D[net.adjEdge[k]] / mm.ref)
			return mm.connected === mm.alive ? s : 0
		},
		goal: (v) => v >= 0.1,
		since: net.steps,
	})
}
function shineLight() {
	// over the busiest tube that is well away from every flake
	const r = 2 * PX_PER_KM
	let best = -1, score = 0
	for (let e = 0; e < net.edgeCount; e++) {
		const mx = (net.x[net.a[e]] + net.x[net.b[e]]) / 2, my = (net.y[net.a[e]] + net.y[net.b[e]]) / 2
		if (net.flakes.some((f) => f.alive && f.node >= 0 && Math.hypot(net.x[f.node] - mx, net.y[f.node] - my) < r + 1.2 * PX_PER_KM)) continue
		const s = net.D[e] * net.flow[e]
		if (s > score) (score = s), (best = e)
	}
	if (best < 0) return console.log('  nowhere to shine a light')
	lamp = {x: (net.x[net.a[best]] + net.x[net.b[best]]) / 2, y: (net.y[net.a[best]] + net.y[net.b[best]]) / 2, r: Math.round(r)}
	for (let e = 0; e < net.edgeCount; e++) {
		const mx = (net.x[net.a[e]] + net.x[net.b[e]]) / 2, my = (net.y[net.a[e]] + net.y[net.b[e]]) / 2
		if ((mx - lamp.x) ** 2 + (my - lamp.y) ** 2 <= r * r) net.light[e] = 1
	}
	console.log(`  light on at ${(lamp.x / PX_PER_KM).toFixed(1)}, ${(lamp.y / PX_PER_KM).toFixed(1)} km`)
	watch.push({what: 'tubes under the light', test: () => nearTube(lamp.x, lamp.y, r), goal: (v) => v < 0.1, since: net.steps})
}

// --- run ---
fronts()
const times = new Float64Array(STEPS)
const images = []
let t = performance.now(), iters = 0, maxIters = 0
for (let s = 1; s <= STEPS; s++) {
	if (ADAPT && s === EVENTS.remove) images.push(snapshot(`net-${String(s - 1).padStart(5, '0')}-before`, s - 1)), removeFlake()
	if (ADAPT && s === EVENTS.add) images.push(snapshot(`net-${String(s - 1).padStart(5, '0')}-before`, s - 1)), addFlake()
	if (ADAPT && s === EVENTS.light) images.push(snapshot(`net-${String(s - 1).padStart(5, '0')}-before`, s - 1)), shineLight()
	const ts = performance.now()
	net.step()
	times[s - 1] = performance.now() - ts
	iters += net.solverIterations
	maxIters = Math.max(maxIters, net.solverIterations)
	trackSwing()
	for (const w of watch) {
		if (w.done || (net.steps - w.since) % 10) continue
		if (w.goal(w.test())) (w.done = true), console.log(`  ${w.what}: done after ${net.steps - w.since} steps`)
	}
	if (s % EVERY === 0) {
		const m = measure()
		Object.assign(m, settle(m))
		console.log(`step ${s}: reached ${net.reachedFlakes().length}/${net.flakes.filter((f) => f.alive).length}, ${fmt(m)}, ${((performance.now() - t) / EVERY).toFixed(2)} ms/step, ${(iters / EVERY).toFixed(1)} solver iterations/step (max ${maxIters})`)
		images.push(snapshot(`net-${String(s).padStart(5, '0')}`, s))
		t = performance.now(); iters = 0; maxIters = 0
	}
}
for (const w of watch) if (!w.done) console.log(`  ${w.what}: not done after ${net.steps - w.since} steps (${w.test().toFixed(3)})`)
sheet(images)
const sorted = Array.from(times).sort((p, q) => p - q)
const pick = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]
const mean = times.reduce((p, q) => p + q, 0) / times.length
console.log(`ms per step over ${STEPS} steps: median ${pick(0.5).toFixed(2)}, mean ${mean.toFixed(2)}, p95 ${pick(0.95).toFixed(2)}, p99 ${pick(0.99).toFixed(2)}, max ${sorted.at(-1).toFixed(2)}`)
console.log(`pictures in ${OUT}`)
