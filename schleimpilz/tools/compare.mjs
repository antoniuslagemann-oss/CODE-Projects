#!/usr/bin/env node
// Measures the slime's network against the real S-Bahn and U-Bahn the way
// Tero et al. (2010) compared Physarum with the Tokyo rail network, after
// checking the measures on small networks whose answers are known.
//
//   node tools/compare.mjs [steps=3000]
//   SETUP=ring node tools/compare.mjs             the 27 Ringbahn stations
//   PARAMS='{"mu":1.5}' node tools/compare.mjs    other model settings
//   PNG=tests/output/compare.png node tools/compare.mjs   also draw what is measured
//   CHECKS=only node tools/compare.mjs            just the checks, no model run

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {dirname} from 'node:path'
import {deflateSync} from 'node:zlib'
import {createRequire} from 'node:module'
import {performance} from 'node:perf_hooks'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const SlimeNetwork = require('../network.js')
const M = require('../metrics.js')
const root = new URL('..', import.meta.url)
const ctx = {}
vm.runInNewContext(readFileSync(new URL('data/berlin.js', root), 'utf8') + ';this.BERLIN = BERLIN', ctx)
const B = ctx.BERLIN

const STEPS = Number(process.argv[2]) || 3000
const SETUP = process.env.SETUP || 'hubs'
const hyp = (ax, ay, bx, by) => Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2)

// --- Checks on networks whose answers are known ---------------------------------

let failed = 0
function check(name, got, want, tol = 1e-9) {
	const ok = got != null && Math.abs(got - want) <= tol
	if (!ok) failed++
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${got == null ? 'null' : got.toFixed(4)}  (want ${want.toFixed(4)}${tol > 1e-9 ? ` ± ${tol}` : ''})`)
}

// a graph from points (km) and links [u, v] or [u, v, len, track]
function toy(pts, links) {
	const g = M.graph(Float64Array.from(pts, (p) => p[0]), Float64Array.from(pts, (p) => p[1]))
	for (const [u, v, len, track] of links) {
		const d = len ?? hyp(pts[u][0], pts[u][1], pts[v][0], pts[v][1])
		M.link(g, u, v, d, track ?? d)
	}
	return M.index(g)
}
function measure(pts, links, flakes) {
	const g = toy(pts, links)
	const px = flakes.map((i) => pts[i][0]), py = flakes.map((i) => pts[i][1])
	return M.measureGraph(g, flakes, px, py).result
}

function toyChecks() {
	const h = Math.sqrt(3) / 2
	console.log('\nchecks on toy networks')

	// a line A-B-C: the network is its own MST
	let r = measure([[0, 0], [1, 0], [2, 0]], [[0, 1], [1, 2]], [0, 1, 2])
	check('line: TL/MST', r.cost, 1)
	check('line: detour', r.detour, 0)
	check('line: MD/MST', r.mdMST, 1)
	check('line: tolerance (every link a bridge)', r.tolerance, 0)

	// a triangle, all three sides: 3 against an MST of 2, no bridges
	r = measure([[0, 0], [1, 0], [0.5, h]], [[0, 1], [1, 2], [2, 0]], [0, 1, 2])
	check('triangle: TL/MST', r.cost, 1.5)
	check('triangle: detour', r.detour, 0)
	check('triangle: MD/MST (3 against 1+1+2)', r.mdMST, 0.75)
	check('triangle: tolerance', r.tolerance, 1)

	// the Steiner tree of the triangle: a junction in the middle
	r = measure([[0, 0], [1, 0], [0.5, h], [0.5, h / 3]], [[0, 3], [1, 3], [2, 3]], [0, 1, 2])
	check('Steiner star: TL/MST (sqrt 3 / 2)', r.cost, Math.sqrt(3) / 2)
	check('Steiner star: detour (2/sqrt 3 - 1)', r.detour, 2 / Math.sqrt(3) - 1)
	check('Steiner star: tolerance', r.tolerance, 0)
	check('Steiner star: links after contraction', r.links, 3)

	// a square ring: 4 against an MST of 3; diagonal trips go round
	r = measure([[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 1], [1, 2], [2, 3], [3, 0]], [0, 1, 2, 3])
	check('square ring: TL/MST', r.cost, 4 / 3)
	check('square ring: detour', r.detour, 8 / (4 + 2 * Math.SQRT2) - 1)
	check('square ring: MD/MST (8 against 10)', r.mdMST, 0.8)
	check('square ring: tolerance', r.tolerance, 1)

	// a tree with a tail: A-B-C plus B-D, D a flake too; mixed lengths
	r = measure([[0, 0], [2, 0], [4, 0], [2, 1]], [[0, 1], [1, 2], [1, 3]], [0, 1, 2, 3])
	check('tree: TL/MST', r.cost, 1)
	check('tree: tolerance', r.tolerance, 0)

	// what serves the flakes: a loop hanging off B and a spur to nowhere go,
	// and so do the nodes along A-B, which merge into one link
	r = measure(
		[[0, 0], [1, 0], [1.5, 0.5], [1.5, -0.5], [-1, 0], [0.5, 0]],
		[[0, 5], [5, 1], [1, 2], [2, 3], [3, 1], [0, 4]],
		[0, 1],
	)
	check('dangling loop and spur: length', r.lengthKm, 1)
	check('dangling loop and spur: links', r.links, 1)
	check('dangling loop and spur: tolerance', r.tolerance, 0)

	// a loop between two flakes that is on a route stays: A and B, joined
	// directly and around through C
	r = measure([[0, 0], [2, 0], [1, 1]], [[0, 1], [0, 2], [2, 1]], [0, 1])
	check('loop between flakes: tolerance', r.tolerance, 1)
	check('loop between flakes: TL/MST', r.cost, 1 + Math.SQRT2)

	// two tracks side by side between the same flakes are two links
	r = measure([[0, 0], [1, 0]], [[0, 1], [0, 1]], [0, 1])
	check('parallel tracks: tolerance', r.tolerance, 1)
	check('parallel tracks: TL/MST', r.cost, 2)

	// by length: a ring of 3 km with a 1 km tail to a fourth flake
	r = measure([[0, 0], [1, 0], [0.5, h], [0.5, h + 1]], [[0, 1], [1, 2], [2, 0], [2, 3]], [0, 1, 3])
	check('ring with tail: tolerance by count (1 of 4 cuts)', r.tolerance, 0.75)
	check('ring with tail: tolerance by length (1 of 4 km)', r.toleranceByLength, 0.75)

	// a walk to the station counts in trips, not in track, and cannot break
	r = measure([[0, 0], [3, 0], [3, 0.5]], [[0, 1], [1, 2, 0.5, 0]], [0, 2])
	check('walk: length is track only', r.lengthKm, 3)
	check('walk: trip includes the walk (detour)', r.detour, 3.5 / Math.hypot(3, 0.5) - 1)
	check('walk: only track links can break', r.links, 1)
}

// Slime drawn by hand onto a real mesh: tubes along mesh paths between flakes.
function meshChecks() {
	console.log('\nchecks on tubes drawn onto a mesh (0.4 km spacing)')
	const pxPerKm = 20
	const net = new SlimeNetwork({width: 400, height: 400, spacing: 0.4 * pxPerKm, inside: () => true})
	const P = net.params
	const reset = () => {
		net.alive.fill(1)
		net.D.fill(P.minD)
		net.born.fill(0)
		net.time = 1000
	}
	// the shortest mesh path between two points, avoiding some nodes
	const path = (x0, y0, x1, y1, avoid = new Set()) => {
		const s = net.nearestNode(x0, y0), t = net.nearestNode(x1, y1)
		const d = new Float64Array(net.nodeCount).fill(Infinity), via = new Int32Array(net.nodeCount).fill(-1)
		d[s] = 0
		const queue = [[0, s]]
		while (queue.length) {
			queue.sort((p, q) => q[0] - p[0])
			const [dd, i] = queue.pop()
			if (dd > d[i]) continue
			if (i === t) break
			for (let k = net.adjStart[i]; k < net.adjStart[i + 1]; k++) {
				const e = net.adjEdge[k], j = net.a[e] === i ? net.b[e] : net.a[e]
				if (avoid.has(j)) continue
				if (dd + net.length[e] < d[j]) (d[j] = dd + net.length[e]), (via[j] = e), queue.push([d[j], j])
			}
		}
		const edges = [], nodes = [t]
		for (let i = t; i !== s; i = net.a[via[i]] === i ? net.b[via[i]] : net.a[via[i]]) edges.push(via[i]), nodes.push(net.a[via[i]] === i ? net.b[via[i]] : net.a[via[i]])
		return {edges, nodes}
	}
	const tube = (p, D = 0.3) => p.edges.forEach((e) => (net.D[e] = D))
	const run = (pts) => {
		net.setFlakes(pts.map(([x, y]) => ({x, y, alive: true})))
		const flakes = pts.map(([x, y]) => ({x, y, alive: true}))
		const s = M.measureSlime(net, flakes, pxPerKm)
		const px = s.flakes.map((i) => pts[i][0] / pxPerKm), py = s.flakes.map((i) => pts[i][1] / pxPerKm)
		return {s, r: s.graph && s.flakes.length >= 2 ? M.evaluate(s.graph, s.termOf, px, py) : null}
	}
	const A = [80, 300], Bp = [320, 300], C = [200, 300 - 240 * (Math.sqrt(3) / 2)]
	const mid = [(A[0] + Bp[0] + C[0]) / 3, (A[1] + Bp[1] + C[1]) / 3]

	reset()
	tube(path(...A, ...Bp)), tube(path(...Bp, ...C)), tube(path(...C, ...A))
	let {s, r} = run([A, Bp, C])
	check('triangle of tubes: flakes linked', s.flakes.length, 3)
	check('triangle of tubes: tolerance', r.tolerance, 1)
	check('triangle of tubes: TL/MST (1.5, a little mesh left)', r.cost, 1.5, 0.06)
	check('triangle of tubes: detour', r.detour, 0, 0.04)

	reset()
	tube(path(...A, ...mid)), tube(path(...Bp, ...mid)), tube(path(...C, ...mid))
	;({s, r} = run([A, Bp, C]))
	// these tubes run at 30 degrees to the mesh rows, the worst direction:
	// a few percent of zig-zag is left after smoothing
	check('Steiner star of tubes: TL/MST (0.866)', r.cost, Math.sqrt(3) / 2, 0.05)
	check('Steiner star of tubes: tolerance', r.tolerance, 0)

	// one tube braided into two strands a mesh row apart is still one tube
	reset()
	const p1 = path(...A, ...Bp)
	tube(p1, 0.3)
	tube(path(...A, ...Bp, new Set(p1.nodes.slice(1, -1))), 0.1)
	;({s, r} = run([A, Bp]))
	check('braided tube: tolerance (one tube, not two)', r.tolerance, 0)
	check('braided tube: TL/MST', r.cost, 1, 0.05)
	check('braided tube: braids taken out', s.braids >= 1 ? 1 : 0, 1)

	// a real second route, 3 km off to the side, stays
	reset()
	const direct = path(...A, ...Bp)
	tube(direct)
	const w = [200, 300 - 3 * pxPerKm], away = new Set(direct.nodes.slice(1, -1))
	tube(path(...A, ...w, away)), tube(path(...w, ...Bp, away))
	;({s, r} = run([A, Bp]))
	check('two routes 3 km apart: tolerance', r.tolerance, 1)
	check('two routes 3 km apart: braids taken out', s.braids, 0)

	// a side branch that leads to no flake withers from the count
	reset()
	tube(path(...A, ...Bp))
	tube(path(200, 300, 200, 300 - 4 * pxPerKm))
	;({s, r} = run([A, Bp]))
	check('dead-end branch: TL/MST', r.cost, 1, 0.05)

	// a flake the tubes don't reach is not linked
	reset()
	tube(path(...A, ...Bp))
	;({s, r} = run([A, Bp, C]))
	check('unreached flake: flakes linked', s.flakes.length, 2)

	// the threshold: tubes at the floor are not tubes
	reset()
	tube(path(...A, ...Bp), 3 * P.minD)
	;({s} = run([A, Bp]))
	check('withered tube: flakes linked', s.flakes.length, 1)
}

toyChecks()
meshChecks()
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks pass')
if (process.env.CHECKS === 'only') process.exit(failed ? 1 : 0)

// --- The slime on Berlin, as tools/preview.mjs runs it -----------------------------

const W = 1024, H = Math.round((W * B.km[1]) / B.km[0])
const PX_PER_KM = W / B.km[0]

// the same ground as the page: near a stop is city, a bit farther parkland
function groundMasks() {
	const bytes = Buffer.from(B.city, 'base64')
	const pts = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
	const d = new Float32Array(W * H).fill(1e9)
	const R = Math.ceil(1.7 * PX_PER_KM)
	for (let i = 0; i < pts.length; i += 2) {
		const x = (pts[i] / 65535) * W, y = (pts[i + 1] / 65535) * H
		for (let yy = Math.max(0, Math.floor(y - R)); yy <= Math.min(H - 1, Math.ceil(y + R)); yy++)
			for (let xx = Math.max(0, Math.floor(x - R)); xx <= Math.min(W - 1, Math.ceil(x + R)); xx++) {
				const k = yy * W + xx
				const dd = hyp(xx + 0.5, yy + 0.5, x, y) / PX_PER_KM
				if (dd < d[k]) d[k] = dd
			}
	}
	return d
}
const ground = groundMasks()
const at = (x, y) => ground[Math.min(H - 1, Math.max(0, Math.floor(y))) * W + Math.min(W - 1, Math.max(0, Math.floor(x)))]
const inside = (x, y) => at(x, y) < 1.6
const park = (x, y) => Math.min(1, Math.max(0, (at(x, y) - 0.4) / 0.3))

const spacingKm = Number(process.env.SPACING_KM) || SlimeNetwork.SPACING_KM || 0.4
const net = new SlimeNetwork({width: W, height: H, spacing: spacingKm * PX_PER_KM, inside, park})
Object.assign(net.params, JSON.parse(process.env.PARAMS || '{}'))
console.log(`\nBerlin, ${SETUP}: mesh of ${net.nodeCount} nodes and ${net.edgeCount} edges, ${spacingKm} km apart, ${STEPS} steps`)

const stations = B.stations.map(([name, u, v, modes, inBerlin]) => ({name, x: u * W, y: v * H, modes, inBerlin: inBerlin === 1}))
const list = SETUP === 'ring' ? B.ring : SETUP === 'none' ? [] : B.hubs
const flakes = [
	{x: B.code[1] * W, y: B.code[2] * H, name: B.code[0], kind: 'code', alive: true},
	...list.map((i) => ({x: stations[i].x, y: stations[i].y, name: stations[i].name, kind: 'station', alive: true})),
]
net.setFlakes(flakes)
net.inoculate(0)

const args = {net, flakes, stations, edges: B.edges, pxPerKm: PX_PER_KM}
const pc = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const x2 = (v) => (v == null ? '-' : v.toFixed(2))
const t0 = performance.now()
let modelMs = 0
for (let s = 1; s <= STEPS; s++) {
	const t = performance.now()
	net.step()
	modelMs += performance.now() - t
	if (s % 500 === 0 || s === STEPS) {
		const r = M.compare(args)
		const sl = r.slime
		console.log(
			`  step ${String(s).padStart(5)}: ` +
				(r.forming
					? `still spreading, ${sl.connected} flakes under the sheet`
					: `slime links ${sl.connected}/${r.flakes.alive}, TL/MST ${x2(sl.cost)}, detour ${pc(sl.detour)}, tolerance ${pc(sl.tolerance)}`) +
				` (metrics ${r.ms.toFixed(1)} ms, model ${(modelMs / s).toFixed(1)} ms/step)`,
		)
	}
}

// --- The table -------------------------------------------------------------------

const res = M.compare(args)
if (res.forming || !res.slime.cost) {
	console.log('\nThe slime has not formed a network yet; run more steps.')
	process.exit(failed ? 1 : 0)
}
const lean = M.compare({...args, options: {railMode: 'shortest'}})
const {slime, rail, mst} = res
const T = M.TOKYO
const cols = [
	['slime', slime],
	['S+U', rail],
	['S+U lean', lean.rail],
	['MST', mst],
]
const row = (label, f, tokyo = ['', '']) =>
	console.log(label.padEnd(30) + cols.map(([, c]) => String(f(c)).padStart(10)).join('') + '   |' + tokyo.map((t) => String(t).padStart(10)).join(''))
console.log(`\nslime after ${STEPS} steps against the S+U, over the ${res.flakes.compared} flakes it links (of ${res.flakes.alive})`)
console.log(''.padEnd(30) + cols.map(([n]) => n.padStart(10)).join('') + '   |' + ['Tokyo:'.padStart(10), 'Physarum'.padStart(10), 'rail'.padStart(10)].slice(1).join(''))
row('track length, TL/MST', (c) => x2(c.cost), [x2(T.physarum.cost), x2(T.rail.cost)])
row('length (km)', (c) => (c.lengthKm == null ? '-' : c.lengthKm.toFixed(0)))
row('detour against straight lines', (c) => (c.detour == null ? '-' : `+${pc(c.detour)}`))
row('trips against the MST, MD/MST', (c) => x2(c.mdMST), [x2(T.physarum.mdMST), x2(T.rail.mdMST)])
row('survives a cut, FT (by link)', (c) => pc(c.tolerance), [pc(T.physarum.tolerance), pc(T.rail.tolerance)])
row('survives a cut (by length)', (c) => pc(c.toleranceByLength ?? 0))
row('a cut strands a flake', (c) => pc(1 - c.tolerance), [pc(T.physarum.cutRisk), pc(T.rail.cutRisk)])
row('links (of them bridges)', (c) => (c.links == null ? '-' : `${c.links} (${c.bridges})`))
row('flakes linked', (c) => `${c.connected}/${res.flakes.alive}`)
console.log('\nS+U: every piece of track on some route between two flakes that passes no station twice.')
console.log('S+U lean: only the track on the shortest route between two flakes.')
console.log(`\nthe slime built ${pc(res.overlap.railBuilt)} of the S+U track in the dish, and ${pc(res.overlap.slimeOnRail)} of its tubes run along track (within ${M.DEFAULTS.nearKm} km)`)
console.log(`track pieces mostly built by the slime: ${res.railCoverage.filter((c) => c >= 0.5).length} of ${res.railCoverage.length}`)
console.log(`braided strands taken out: ${res.braids}, tube threshold: D ≥ ${res.threshold.toExponential(2)}`)
console.log(`panel: “${res.foot}”`)

// --- Timing ------------------------------------------------------------------------

const times = []
for (let i = 0; i < 60; i++) {
	const t = performance.now()
	M.compare(args)
	times.push(performance.now() - t)
}
times.sort((p, q) => p - q)
console.log(`\nNetworkMetrics.compare: median ${times[30].toFixed(2)} ms, slowest ${times[59].toFixed(2)} ms over 60 calls (a model step takes ${(modelMs / STEPS).toFixed(1)} ms)`)
console.log(`whole run ${((performance.now() - t0) / 1000).toFixed(0)} s`)

// --- A picture of what is measured -----------------------------------------------------

if (process.env.PNG) {
	const img = Buffer.alloc(W * H * 3, 250)
	const plot = (x, y, c, r = 1) => {
		for (let dy = -r; dy <= r; dy++)
			for (let dx = -r; dx <= r; dx++) {
				const X = Math.round(x + dx), Y = Math.round(y + dy)
				if (X < 0 || Y < 0 || X >= W || Y >= H || dx * dx + dy * dy > r * r + 0.5) continue
				img.set(c, (Y * W + X) * 3)
			}
	}
	const line = (x0, y0, x1, y1, c, r) => {
		const n = Math.ceil(hyp(x0, y0, x1, y1)) + 1
		for (let s = 0; s <= n; s++) plot(x0 + ((x1 - x0) * s) / n, y0 + ((y1 - y0) * s) / n, c, r)
	}
	for (const [p, q] of B.edges) line(stations[p].x, stations[p].y, stations[q].x, stations[q].y, [215, 215, 222], 0)
	// the rail that serves the flakes: blue on a loop, grey where a cut strands a flake
	const s = M.measureSlime(net, flakes, PX_PER_KM)
	const base = M.railBase(stations, B.edges, PX_PER_KM)
	const px = Float64Array.from(s.flakes, (i) => flakes[i].x / PX_PER_KM), py = Float64Array.from(s.flakes, (i) => flakes[i].y / PX_PER_KM)
	const rr = M.measureRail(base, px, py)
	rr.graph.u.forEach((_, e) => {
		for (const part of rr.graph.parts[e]) {
			const i = rr.full.parts[part]
			if (i < 0) continue
			const [p, q] = B.edges[i]
			line(stations[p].x, stations[p].y, stations[q].x, stations[q].y, rr.result.bridge[e] ? [90, 90, 100] : [70, 120, 225], 1)
		}
	})
	// the slime: green on a loop, red where a cut strands a flake
	const sr = M.evaluate(s.graph, s.termOf, px, py)
	const {graph: g, chains} = s.tubes
	s.graph.u.forEach((_, e) => {
		for (const gl of s.graph.parts[e]) {
			const c = g.parts[gl][0]
			for (let q = chains.start[c]; q < chains.start[c + 1] - 1; q++) {
				const i = chains.nodes[q], j = chains.nodes[q + 1]
				line(net.x[i], net.y[i], net.x[j], net.y[j], sr.bridge[e] ? [215, 50, 40] : [30, 160, 70], 1)
			}
		}
	})
	flakes.forEach((f, i) => plot(f.x, f.y, s.flakes.includes(i) ? [120, 80, 20] : [230, 0, 230], 4))
	const crcT = new Int32Array(256).map((_, n) => {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		return c
	})
	const crc = (buf) => {
		let c = -1
		for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8)
		return (c ^ -1) >>> 0
	}
	const chunk = (t, d) => {
		const l = Buffer.alloc(4)
		l.writeUInt32BE(d.length)
		const td = Buffer.concat([Buffer.from(t), d])
		const c = Buffer.alloc(4)
		c.writeUInt32BE(crc(td))
		return Buffer.concat([l, td, c])
	}
	const raw = Buffer.alloc((W * 3 + 1) * H)
	for (let y = 0; y < H; y++) img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3)
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(W, 0)
	ihdr.writeUInt32BE(H, 4)
	ihdr[8] = 8
	ihdr[9] = 2
	mkdirSync(dirname(process.env.PNG), {recursive: true})
	writeFileSync(process.env.PNG, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
	console.log(`drew what is measured to ${process.env.PNG}`)
}

process.exit(failed ? 1 : 0)
