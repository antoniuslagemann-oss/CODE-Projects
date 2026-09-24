#!/usr/bin/env node
// Runs the tube network without a browser and writes PNG snapshots, for
// tuning the model quickly.
//
//   node tools/preview.mjs [steps=2000] [every=250] [out=tests/output/model/preview]
//   SETUP=ring node tools/preview.mjs
//   PARAMS='{"mu":1.5}' node tools/preview.mjs
//   NET=path/to/network.js node tools/preview.mjs    another version of the model

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

const STEPS = Number(process.argv[2]) || 2000
const EVERY = Number(process.argv[3]) || 250
const OUT = process.argv[4] || new URL('tests/output/model/preview', root).pathname
const SETUP = process.env.SETUP || 'hubs'
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
console.log(`mesh: ${net.nodeCount} nodes, ${net.edgeCount} edges (${Date.now() - t0} ms)`)

const st = (i) => ({x: B.stations[i][1] * W, y: B.stations[i][2] * H})
const list = SETUP === 'ring' ? B.ring : SETUP === 'none' ? [] : B.hubs
const flakes = [{x: B.code[1] * W, y: B.code[2] * H, alive: true}, ...list.map((i) => ({...st(i), alive: true}))]
net.setFlakes(flakes)
net.inoculate(0)

// --- tiny PNG writer ---
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c })
const crc = (buf) => { let c = -1; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
function png(path, img) {
	const raw = Buffer.alloc((W * 3 + 1) * H)
	for (let y = 0; y < H; y++) img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3)
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
	writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

function snapshot(name) {
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
	let maxD = 0
	for (let e = 0; e < net.edgeCount; e++) maxD = Math.max(maxD, net.D[e])
	for (let e = 0; e < net.edgeCount; e++) {
		const a = net.a[e], b = net.b[e]
		if (!net.alive[a] || !net.alive[b]) continue
		const rel = net.D[e] / Math.max(1e-9, maxD)
		const width = 0.6 + 5 * Math.pow(rel, 0.25)
		const alpha = Math.min(1, 0.15 + 1.2 * Math.pow(rel, 0.5))
		if (rel < 0.002) continue
		const x0 = net.x[a], y0 = net.y[a], x1 = net.x[b], y1 = net.y[b]
		const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
		const col = rel > 0.3 ? [201, 129, 0] : [239, 185, 0]
		for (let s = 0; s <= n; s++) {
			const x = x0 + ((x1 - x0) * s) / n, y = y0 + ((y1 - y0) * s) / n
			const r = width / 2
			for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
				for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
					if (dx * dx + dy * dy <= r * r + 0.25) blend(x + dx, y + dy, col, alpha)
		}
	}
	for (const f of flakes) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9) blend(f.x + dx, f.y + dy, [120, 90, 50], 1)
	png(`${OUT}/${name}.png`, img)
}

const times = new Float64Array(STEPS)
let t = Date.now(), iters = 0
for (let s = 1; s <= STEPS; s++) {
	const ts = performance.now()
	net.step()
	times[s - 1] = performance.now() - ts
	iters += net.solverIterations
	if (s % EVERY === 0) {
		const reached = net.reachedFlakes().length
		let strong = 0
		for (let e = 0; e < net.edgeCount; e++) if (net.D[e] > 0.05) strong++
		console.log(`step ${s}: reached ${reached}/${flakes.length}, strong tubes ${strong}, ${((Date.now() - t) / EVERY).toFixed(1)} ms/step, ${(iters / EVERY).toFixed(0)} CG iterations/step`)
		snapshot(`net-${String(s).padStart(5, '0')}`)
		t = Date.now(); iters = 0
	}
}
const sorted = Array.from(times).sort((p, q) => p - q)
const pick = (f) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]
console.log(`ms per step: median ${pick(0.5).toFixed(2)}, p95 ${pick(0.95).toFixed(2)}, max ${sorted.at(-1).toFixed(2)}`)
