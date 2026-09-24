#!/usr/bin/env node
// Builds data/berlin.js from open VBB timetable data.
//
// Source: VBB Verkehrsverbund Berlin-Brandenburg GmbH, GTFS timetable data,
// CC BY 4.0, as packaged on npm by Jannis R (vbb-stations, vbb-lines).
//
//   npm install
//   npm run build:data

import {writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const stationsFull = require('vbb-stations/full.json')
const lines = require('vbb-lines/data.json')

const OUT = fileURLToPath(new URL('../data/berlin.js', import.meta.url))

// CODE University of Applied Sciences, in KALLE Neukölln since August 2024:
// Donaustraße 44, behind Karl-Marx-Straße 101. Placed between U Rathaus
// Neukölln and U Karl-Marx-Str., good to about 150 m.
const CODE = {name: 'CODE University', lat: 52.4797, lon: 13.4375}

// One oat flake per neighbourhood: the busiest station wins, and the
// neighbourhoods grow from 1.6 km across in Mitte to about 4.5 km at the edge.
const HUB_SPACING = (kmFromCentre) => 1.6 + 0.17 * kmFromCentre
const CENTRE = {lat: 52.515, lon: 13.39}
const DISH_MARGIN_KM = 2.4 // between the outermost stop and the rim of the dish

// Flat projection. Berlin spans 0.34° of latitude, so a single cos(lat) is fine.
const LAT0 = 52.5
const KM_PER_LAT = 111.2
const KM_PER_LON = 111.32 * Math.cos((LAT0 * Math.PI) / 180)

const isBerlin = (id) => id.startsWith('de:11000:')

// --- Resolve any stop or platform id to its parent station -------------------

const parentOf = new Map()
for (const [id, st] of Object.entries(stationsFull)) {
	for (const stop of st.stops || []) parentOf.set(stop.id, id)
}
const resolve = (stopId) => {
	const parts = stopId.split(':')
	if (parts.length >= 3) {
		const p3 = parts.slice(0, 3).join(':')
		if (stationsFull[p3]) return p3
	}
	if (stationsFull[stopId]) return stopId
	return parentOf.get(stopId) ?? null
}

const shortName = (name) => name
	.replace(/ \(Berlin\)$/, '')
	.replace(/^(S\+U|S|U) /, '')
	.replace(/ Bhf$/, '')
	.replace(/^Berlin /, '')

// --- Every stop in Berlin: this traces the shape of the city -----------------

const cityPoints = []
{
	const seen = new Set()
	const add = (loc) => {
		// dedupe on a ~30 m grid
		const key = Math.round(loc.latitude * 3700) + ':' + Math.round(loc.longitude * 2250)
		if (seen.has(key)) return
		seen.add(key)
		cityPoints.push([loc.latitude, loc.longitude])
	}
	for (const [id, st] of Object.entries(stationsFull)) {
		if (!isBerlin(id)) continue
		add(st.location)
		for (const stop of st.stops || []) add(stop.location)
	}
}

// The dish is round: the smallest circle around every stop (Welzl), plus room
// for the parkland band and the rim. The map is the square around it.
const circle = (() => {
	const pts = cityPoints.map(([lat, lon]) => [(lon - 13.4) * KM_PER_LON, (lat - LAT0) * KM_PER_LAT])
	let seed = 1
	for (let i = pts.length - 1; i > 0; i--) {
		seed = (seed * 16807) % 2147483647
		const j = seed % (i + 1)
		;[pts[i], pts[j]] = [pts[j], pts[i]]
	}
	const inC = (c, p) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= c[2] + 1e-9
	const two = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, Math.hypot(p[0] - q[0], p[1] - q[1]) / 2]
	const three = (p, q, r) => {
		const ax = p[0], ay = p[1], bx = q[0], by = q[1], cx = r[0], cy = r[1]
		const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
		const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
		const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
		return [ux, uy, Math.hypot(ax - ux, ay - uy)]
	}
	let c = [pts[0][0], pts[0][1], 0]
	for (let i = 1; i < pts.length; i++) {
		if (inC(c, pts[i])) continue
		c = [pts[i][0], pts[i][1], 0]
		for (let j = 0; j < i; j++) {
			if (inC(c, pts[j])) continue
			c = two(pts[i], pts[j])
			for (let k = 0; k < j; k++) if (!inC(c, pts[k])) c = three(pts[i], pts[j], pts[k])
		}
	}
	return {lon: 13.4 + c[0] / KM_PER_LON, lat: LAT0 + c[1] / KM_PER_LAT, km: c[2]}
})()
const RADIUS_KM = circle.km + DISH_MARGIN_KM
const south = circle.lat - RADIUS_KM / KM_PER_LAT
const north = circle.lat + RADIUS_KM / KM_PER_LAT
const west = circle.lon - RADIUS_KM / KM_PER_LON
const east = circle.lon + RADIUS_KM / KM_PER_LON
const widthKm = 2 * RADIUS_KM
const heightKm = 2 * RADIUS_KM

const project = (lat, lon) => [(lon - west) / (east - west), (north - lat) / (north - south)]
const distKm = (a, b) => Math.hypot((a.lat - b.lat) * KM_PER_LAT, (a.lon - b.lon) * KM_PER_LON)

// --- S-Bahn and U-Bahn: stations and the edges between consecutive stops -----

const MODES = {suburban: 'S', subway: 'U'}
const stations = new Map() // id -> {id, name, lat, lon, weight, modes:Set}
const edges = new Map() // key -> {a, b, mode, trips, lines:Set}

for (const line of lines) {
	const mode = MODES[line.product]
	if (!mode) continue
	for (const variant of line.variants) {
		const ids = []
		for (const stopId of variant.stops) {
			const id = resolve(stopId)
			if (!id) continue
			if (ids[ids.length - 1] !== id) ids.push(id)
		}
		for (const id of ids) {
			const st = stationsFull[id]
			if (!stations.has(id)) {
				stations.set(id, {
					id,
					name: shortName(st.name),
					lat: st.location.latitude,
					lon: st.location.longitude,
					weight: st.weight,
					modes: new Set(),
				})
			}
			stations.get(id).modes.add(mode)
		}
		for (let i = 1; i < ids.length; i++) {
			const [a, b] = [ids[i - 1], ids[i]].sort()
			const key = `${mode}|${a}|${b}`
			if (!edges.has(key)) edges.set(key, {a, b, mode, trips: 0, lines: new Set()})
			const e = edges.get(key)
			e.trips += variant.trips
			e.lines.add(line.name)
		}
	}
}

// Some variants skip stations (early and late trips, diversions). Those make
// long chords across the map. Drop an edge when the same line mode already
// connects its two ends by a path that is barely longer.
const removeShortcuts = (mode) => {
	const list = [...edges.values()].filter((e) => e.mode === mode)
	const adj = new Map()
	const link = (e) => {
		for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
			if (!adj.has(x)) adj.set(x, new Set())
			adj.get(x).add(y)
		}
	}
	const unlink = (e) => {
		adj.get(e.a).delete(e.b)
		adj.get(e.b).delete(e.a)
	}
	list.forEach(link)
	const len = (x, y) => distKm(stations.get(x), stations.get(y))
	const pathWithin = (from, to, limit) => {
		const best = new Map([[from, 0]])
		const queue = [[0, from]]
		while (queue.length) {
			queue.sort((p, q) => p[0] - q[0])
			const [d, x] = queue.shift()
			if (x === to) return true
			if (d > (best.get(x) ?? Infinity)) continue
			for (const y of adj.get(x) || []) {
				const nd = d + len(x, y)
				if (nd <= limit && nd < (best.get(y) ?? Infinity)) {
					best.set(y, nd)
					queue.push([nd, y])
				}
			}
		}
		return false
	}
	list.sort((p, q) => len(q.a, q.b) - len(p.a, p.b))
	let removed = 0
	for (const e of list) {
		unlink(e)
		if (pathWithin(e.a, e.b, len(e.a, e.b) * 1.15)) {
			edges.delete(`${e.mode}|${e.a}|${e.b}`)
			removed++
		} else {
			link(e)
		}
	}
	return removed
}
const removedS = removeShortcuts('S')
const removedU = removeShortcuts('U')

// Keep what touches the map.
const inBox = (st) => st.lat > south && st.lat < north && st.lon > west && st.lon < east
const keptEdges = [...edges.values()].filter((e) => inBox(stations.get(e.a)) || inBox(stations.get(e.b)))
const usedIds = new Set(keptEdges.flatMap((e) => [e.a, e.b]))
const stationList = [...stations.values()].filter((s) => usedIds.has(s.id))
stationList.sort((p, q) => q.weight - p.weight)
const indexOf = new Map(stationList.map((s, i) => [s.id, i]))

// --- Oat flakes: the busiest station in each neighbourhood -------------------

const hubs = []
for (const s of stationList) {
	if (!isBerlin(s.id)) continue
	const spacing = HUB_SPACING(distKm(s, CENTRE))
	if (hubs.some((h) => distKm(h, s) < Math.max(spacing, h.spacing))) continue
	hubs.push({...s, spacing})
}

// --- The Ringbahn, in order --------------------------------------------------

const ringVariant = lines
	.filter((l) => l.name === 'S41')
	.flatMap((l) => l.variants)
	.sort((p, q) => q.trips - p.trips)[0]
const ring = [...new Set(ringVariant.stops.map(resolve))].map((id) => indexOf.get(id))

// --- Write -------------------------------------------------------------------

const r4 = (x) => Math.round(x * 10000) / 10000

const packed = new Uint16Array(cityPoints.length * 2)
cityPoints.forEach(([lat, lon], i) => {
	const [u, v] = project(lat, lon)
	packed[i * 2] = Math.round(u * 65535)
	packed[i * 2 + 1] = Math.round(v * 65535)
})
const cityB64 = Buffer.from(packed.buffer).toString('base64')

const data = {
	bbox: {west: r4(west), south: r4(south), east: r4(east), north: r4(north)},
	// the map is a square; the dish is the circle inside it
	km: [Math.round(widthKm * 100) / 100, Math.round(heightKm * 100) / 100],
	// [name, u, v, modes ("S", "U" or "SU"), inBerlin]
	stations: stationList.map((s) => {
		const [u, v] = project(s.lat, s.lon)
		return [s.name, r4(u), r4(v), [...s.modes].sort().join(''), isBerlin(s.id) ? 1 : 0]
	}),
	// [stationA, stationB, "S" | "U"]
	edges: keptEdges
		.map((e) => [indexOf.get(e.a), indexOf.get(e.b), e.mode])
		.sort((p, q) => p[0] - q[0] || p[1] - q[1]),
	hubs: hubs.map((h) => indexOf.get(h.id)),
	ring,
	code: [CODE.name, ...project(CODE.lat, CODE.lon).map(r4)],
	city: cityB64,
}

const header = `// Generated by tools/build-data.mjs. Do not edit by hand.
// Station and line data: VBB Verkehrsverbund Berlin-Brandenburg GmbH,
// GTFS timetable data, CC BY 4.0, modified. Via the vbb-stations and
// vbb-lines packages by Jannis R.
`
const body = JSON.stringify(data)
	.replace(/\],\[/g, '],\n[')
writeFileSync(OUT, `${header}const BERLIN = ${body}\n`)

console.log(`dish: ${widthKm.toFixed(1)} km across, centred ${circle.lat.toFixed(4)}, ${circle.lon.toFixed(4)} (stops within ${circle.km.toFixed(1)} km)`)
console.log(`city points: ${cityPoints.length}`)
console.log(`stations: ${stationList.length}, edges: ${keptEdges.length} (dropped shortcuts S ${removedS}, U ${removedU})`)
console.log(`hubs (${hubs.length}): ${hubs.map((h) => h.name).join(', ')}`)
console.log(`ring (${ring.length}): ${ring.map((i) => stationList[i].name).join(' > ')}`)
console.log(`wrote ${OUT} (${(Buffer.byteLength(body) / 1024).toFixed(1)} KB)`)
