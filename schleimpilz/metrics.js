'use strict'

// How the slime's network measures up against the real S-Bahn and U-Bahn,
// after Tero et al. (2010), "Rules for Biologically Inspired Adaptive Network
// Design", Science 327:439. They compared Physarum networks between 36 food
// sources with the Tokyo rail network linking the same cities on three
// counts, and so does this:
//
//   cost       TL/MST: total length of the network over the length of the
//              minimum spanning tree of the flakes (straight lines between
//              them). Tokyo: Physarum 1.75, rail 1.8.
//   detour     how much longer the trips between flakes are than straight
//              lines: sum over all pairs of the shortest distance along the
//              network, over the sum of the straight-line distances, minus 1.
//              The paper normalises the same sum by the one along the MST
//              (MD_MST, 0.85 for both Physarum and rail); that is here too.
//   tolerance  FT: the chance that one link, picked at random, can break
//              without cutting any flake off. A link runs between two flakes
//              or junctions. The paper puts it the other way round: 14% of
//              single-link failures cut part of the Physarum network off, 4%
//              of the rail network. Weighting each link by its length instead
//              ("a random stretch of track breaks") is reported too.
//
// Both networks are reduced to the part that serves the flakes: every tube or
// track section that lies on some route between two flakes that visits no
// place twice. Dead ends that lead to no flake go, and so do loops that hang
// off the network by one point. For the rail, that drops the lines beyond the
// outermost flakes but keeps every loop and parallel line between them, which
// is where its tolerance comes from. A flake that is not on a station is
// joined to the nearest one by a walk; the walk counts towards the distances
// between flakes but not towards track length, and it cannot break.
//
// The slime's network is its tubes above a threshold: at least 1/1000 of the
// strongest tube's conductivity and 4 times the model's floor. The tube
// conductivities split cleanly into withered tubes at the floor and live ones
// a hundred times above it, and the threshold sits in that gap. Of those
// tubes only the piece that links the most flakes counts. Loops shorter than
// six mesh spacings are one tube braided on the mesh, not two routes, and
// keep only their stronger side. Tube lengths follow the tube, with the
// zig-zag of the mesh smoothed out (Douglas-Peucker to half a mesh spacing):
// on a triangular mesh a straight tube is about 10% longer than the line it
// stands for, and rail track is measured as straight lines between stations.
//
// All comparisons are made over the same flakes: the ones the slime has
// linked so far, so that the rail and the MST are measured on what the slime
// is measured on.

const NetworkMetrics = (() => {
	const DEFAULTS = {
		relThreshold: 1e-3, // a tube counts from this fraction of the strongest one...
		floorFactor: 4, // ...and from this many times the model's floor (minD)
		loopSpacings: 6, // loops shorter than this many mesh spacings are one braided tube
		smoothSpacings: 0.5, // mesh zig-zag smaller than this many spacings is smoothed away
		nearKm: 0.4, // a tube within this of a track runs along it
		sampleKm: 0.1, // step when walking along track to check that
		dish: null, // {x, y, r} in sim px; defaults to the circle inside the mesh's square
	}

	// Tokyo, for reference (Tero et al. 2010)
	const TOKYO = {
		physarum: {cost: 1.75, mdMST: 0.85, cutRisk: 0.14},
		rail: {cost: 1.8, mdMST: 0.85, cutRisk: 0.04},
	}

	// --- A binary heap of (key, value), reused -----------------------------------

	class Heap {
		constructor(capacity = 64) {
			this.keys = new Float64Array(capacity)
			this.vals = new Int32Array(capacity)
			this.size = 0
			this.topKey = 0
		}
		push(key, val) {
			if (this.size === this.keys.length) {
				const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2)
				k.set(this.keys)
				v.set(this.vals)
				this.keys = k
				this.vals = v
			}
			const {keys, vals} = this
			let i = this.size++
			while (i > 0) {
				const p = (i - 1) >> 1
				if (keys[p] <= key) break
				keys[i] = keys[p]
				vals[i] = vals[p]
				i = p
			}
			keys[i] = key
			vals[i] = val
		}
		pop() {
			const {keys, vals} = this
			const top = vals[0]
			this.topKey = keys[0]
			const n = --this.size
			if (n > 0) {
				const key = keys[n], val = vals[n]
				let i = 0
				for (;;) {
					let c = 2 * i + 1
					if (c >= n) break
					if (c + 1 < n && keys[c + 1] < keys[c]) c++
					if (keys[c] >= key) break
					keys[i] = keys[c]
					vals[i] = vals[c]
					i = c
				}
				keys[i] = key
				vals[i] = val
			}
			return top
		}
	}
	const heap = new Heap()

	// --- Graphs: nodes with positions (km), links with lengths (km) --------------
	//
	// len is what a trip along the link covers, track what it adds to the
	// network's length; a walk to a station has track 0 and cannot break.

	function graph(x, y) {
		return {n: x.length, x, y, u: [], v: [], len: [], track: [], weak: [], parts: [], adjStart: null, adjEdge: null}
	}

	function link(g, u, v, len, track = len, weak = 0, parts = null) {
		g.u.push(u)
		g.v.push(v)
		g.len.push(len)
		g.track.push(track)
		g.weak.push(weak)
		g.parts.push(parts)
		return g.u.length - 1
	}

	function index(g) {
		const n = g.n, m = g.u.length
		const start = new Int32Array(n + 1)
		for (let e = 0; e < m; e++) start[g.u[e] + 1]++, start[g.v[e] + 1]++
		for (let i = 0; i < n; i++) start[i + 1] += start[i]
		const fill = start.slice(0, n)
		const adj = new Int32Array(2 * m)
		for (let e = 0; e < m; e++) {
			adj[fill[g.u[e]]++] = e
			if (g.v[e] !== g.u[e]) adj[fill[g.v[e]]++] = e
		}
		g.adjStart = start
		g.adjEdge = adj
		return g
	}

	const other = (g, e, i) => (g.u[e] === i ? g.v[e] : g.u[e])

	// shortest distances from one node, over the links that are on
	function dijkstra(g, on, from, out, limit = Infinity, skip = -1) {
		out.fill(Infinity)
		out[from] = 0
		heap.size = 0
		heap.push(0, from)
		while (heap.size) {
			const i = heap.pop()
			const d = heap.topKey
			if (d > out[i]) continue
			if (d > limit) break
			for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
				const e = g.adjEdge[k]
				if (!on[e] || e === skip) continue
				const j = other(g, e, i)
				const nd = d + g.len[e]
				if (nd < out[j]) {
					out[j] = nd
					heap.push(nd, j)
				}
			}
		}
		return out
	}

	// Depth-first search on the links that are on, as Tarjan does it: entry
	// times and low points, with bridges and blocks (biconnected components).
	function tarjan(g, on, wantBlocks) {
		const n = g.n, m = g.u.length
		const tin = new Int32Array(n).fill(-1), low = new Int32Array(n)
		const bridge = new Uint8Array(m)
		const block = wantBlocks ? new Int32Array(m).fill(-1) : null
		const sv = new Int32Array(n), se = new Int32Array(n), sk = new Int32Array(n)
		const es = wantBlocks ? new Int32Array(m) : null
		let esp = 0, blocks = 0, timer = 0
		for (let r = 0; r < n; r++) {
			if (tin[r] >= 0) continue
			let sp = 0
			sv[0] = r
			se[0] = -1
			sk[0] = g.adjStart[r]
			tin[r] = low[r] = timer++
			while (sp >= 0) {
				const v = sv[sp]
				if (sk[sp] < g.adjStart[v + 1]) {
					const e = g.adjEdge[sk[sp]++]
					if (!on[e] || e === se[sp]) continue
					const w = other(g, e, v)
					if (w === v) continue // loops close on themselves
					if (tin[w] < 0) {
						if (wantBlocks) es[esp++] = e
						tin[w] = low[w] = timer++
						sp++
						sv[sp] = w
						se[sp] = e
						sk[sp] = g.adjStart[w]
					} else if (tin[w] < tin[v]) {
						if (wantBlocks) es[esp++] = e
						if (tin[w] < low[v]) low[v] = tin[w]
					}
				} else {
					const pe = se[sp--]
					if (sp < 0) break
					const p = sv[sp]
					if (low[v] < low[p]) low[p] = low[v]
					if (low[v] > tin[p]) bridge[pe] = 1
					if (wantBlocks && low[v] >= tin[p]) {
						let e
						do {
							e = es[--esp]
							block[e] = blocks
						} while (e !== pe)
						blocks++
					}
				}
			}
		}
		return {bridge, block, blocks}
	}

	// Keep only what serves the terminals: the links that lie on some simple
	// path between two of them. Blocks of the block-cut tree that hang off by
	// one cut vertex and hold no terminal of their own go, until none is left.
	function serve(g, on, term) {
		const n = g.n, m = g.u.length
		for (let e = 0; e < m; e++) if (g.u[e] === g.v[e]) on[e] = 0
		const {block, blocks} = tarjan(g, on, true)
		if (!blocks) return on
		// the nodes of each block
		const stamp = new Int32Array(n).fill(-1)
		const bStart = new Int32Array(blocks + 1)
		const byBlock = Array.from({length: blocks}, () => [])
		for (let e = 0; e < m; e++) if (on[e] && block[e] >= 0) byBlock[block[e]].push(e)
		const members = []
		const nBlocks = new Int32Array(n) // blocks each node is in
		for (let bl = 0; bl < blocks; bl++) {
			bStart[bl] = members.length
			for (const e of byBlock[bl]) {
				for (const i of [g.u[e], g.v[e]]) {
					if (stamp[i] === bl) continue
					stamp[i] = bl
					members.push(i)
					nBlocks[i]++
				}
			}
		}
		bStart[blocks] = members.length
		const nodeBlocks = Array.from({length: n}, () => [])
		for (let bl = 0; bl < blocks; bl++) for (let k = bStart[bl]; k < bStart[bl + 1]; k++) nodeBlocks[members[k]].push(bl)
		const cuts = new Int32Array(blocks)
		for (let bl = 0; bl < blocks; bl++) for (let k = bStart[bl]; k < bStart[bl + 1]; k++) if (nBlocks[members[k]] > 1) cuts[bl]++
		const gone = new Uint8Array(blocks)
		const queue = Array.from({length: blocks}, (_, i) => i)
		while (queue.length) {
			const bl = queue.pop()
			if (gone[bl] || cuts[bl] > 1) continue
			let own = false, cut = -1
			for (let k = bStart[bl]; k < bStart[bl + 1]; k++) {
				const i = members[k]
				if (nBlocks[i] > 1) cut = i
				else if (term[i]) own = true
			}
			if (own) continue
			if (cut < 0) {
				// a block on its own: keep it if it holds a terminal at all
				let any = false
				for (let k = bStart[bl]; k < bStart[bl + 1]; k++) if (term[members[k]]) any = true
				if (any) continue
			}
			gone[bl] = 1
			for (const e of byBlock[bl]) on[e] = 0
			for (let k = bStart[bl]; k < bStart[bl + 1]; k++) {
				const i = members[k]
				if (--nBlocks[i] === 1) {
					for (const b2 of nodeBlocks[i]) {
						if (gone[b2]) continue
						cuts[b2]--
						queue.push(b2)
					}
				}
			}
		}
		return on
	}

	// Merge chains through nodes that are neither terminals nor junctions into
	// single links. Returns a new graph on the nodes that are left.
	function contract(g, on, term) {
		const n = g.n, m = g.u.length
		const deg = new Int32Array(n)
		for (let e = 0; e < m; e++) {
			if (!on[e]) continue
			deg[g.u[e]]++
			deg[g.v[e]]++
		}
		const keep = new Int32Array(n).fill(-1)
		const xs = [], ys = []
		for (let i = 0; i < n; i++) {
			if (deg[i] === 0 && !term[i]) continue
			if (term[i] || deg[i] !== 2) {
				keep[i] = xs.length
				xs.push(g.x[i])
				ys.push(g.y[i])
			}
		}
		const h = graph(Float64Array.from(xs), Float64Array.from(ys))
		h.from = keep
		const used = new Uint8Array(m)
		for (let s = 0; s < n; s++) {
			if (keep[s] < 0) continue
			for (let k = g.adjStart[s]; k < g.adjStart[s + 1]; k++) {
				const e0 = g.adjEdge[k]
				if (!on[e0] || used[e0]) continue
				let len = 0, track = 0, weak = Infinity
				const parts = []
				let e = e0, i = s
				for (;;) {
					used[e] = 1
					len += g.len[e]
					track += g.track[e]
					weak = Math.min(weak, g.weak[e])
					parts.push(e)
					i = other(g, e, i)
					if (keep[i] >= 0) break
					let next = -1
					for (let q = g.adjStart[i]; q < g.adjStart[i + 1]; q++) {
						const f = g.adjEdge[q]
						if (on[f] && !used[f]) {
							next = f
							break
						}
					}
					if (next < 0) break // closed on itself
					e = next
				}
				if (keep[i] >= 0) link(h, keep[s], keep[i], len, track, weak, parts)
			}
		}
		return index(h)
	}

	// Euclidean minimum spanning tree (Prim), with the distances along it.
	function mst(px, py) {
		const k = px.length
		const inTree = new Uint8Array(k), best = new Float64Array(k).fill(Infinity), parent = new Int32Array(k).fill(-1)
		const adj = Array.from({length: k}, () => [])
		let total = 0
		best[0] = 0
		for (let it = 0; it < k; it++) {
			let u = -1
			for (let i = 0; i < k; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i
			inTree[u] = 1
			if (parent[u] >= 0) {
				total += best[u]
				adj[u].push(parent[u])
				adj[parent[u]].push(u)
			}
			for (let i = 0; i < k; i++) {
				if (inTree[i]) continue
				const d = Math.hypot(px[i] - px[u], py[i] - py[u])
				if (d < best[i]) (best[i] = d), (parent[i] = u)
			}
		}
		// distances along the tree from every node
		const dist = new Float64Array(k * k)
		const stack = []
		for (let s = 0; s < k; s++) {
			const row = s * k
			const seen = new Uint8Array(k)
			seen[s] = 1
			stack.push(s)
			while (stack.length) {
				const u = stack.pop()
				for (const w of adj[u]) {
					if (seen[w]) continue
					seen[w] = 1
					dist[row + w] = dist[row + u] + Math.hypot(px[w] - px[u], py[w] - py[u])
					stack.push(w)
				}
			}
		}
		return {length: total, dist}
	}

	// The measures, on a network that serves the flakes. termOf[f] is the node
	// of flake f, px/py where the flakes are (km).
	function evaluate(g, termOf, px, py, tree = mst(px, py)) {
		const k = termOf.length
		const m = g.u.length
		const on = new Uint8Array(m).fill(1)
		let lengthKm = 0
		for (let e = 0; e < m; e++) lengthKm += g.track[e]
		// shortest distances between flakes
		const rows = new Map()
		const tmp = new Float64Array(g.n)
		for (const t of termOf) if (!rows.has(t)) rows.set(t, Float64Array.from(dijkstra(g, on, t, tmp)))
		let net = 0, line = 0, alongMst = 0, pairs = 0, unreachable = 0
		for (let i = 0; i < k; i++) {
			const row = rows.get(termOf[i])
			for (let j = i + 1; j < k; j++) {
				const d = row[termOf[j]]
				if (!isFinite(d)) {
					unreachable++
					continue
				}
				net += d
				line += Math.hypot(px[i] - px[j], py[i] - py[j])
				alongMst += tree.dist[i * k + j]
				pairs++
			}
		}
		// links whose failure cuts a flake off: the bridges
		const {bridge} = tarjan(g, on, false)
		let links = 0, bridges = 0, trackKm = 0, bridgeKm = 0
		for (let e = 0; e < m; e++) {
			if (!(g.track[e] > 0)) continue // walks don't break
			links++
			trackKm += g.track[e]
			if (bridge[e]) bridges++, (bridgeKm += g.track[e])
		}
		return {
			lengthKm,
			cost: tree.length > 0 ? lengthKm / tree.length : null,
			md: pairs ? net / pairs : null,
			detour: line > 0 ? net / line - 1 : null,
			mdMST: alongMst > 0 ? net / alongMst : null,
			tolerance: links ? 1 - bridges / links : null,
			toleranceByLength: trackKm > 0 ? 1 - bridgeKm / trackKm : null,
			links,
			bridges,
			unreachable,
			bridge,
		}
	}

	// From any graph with terminals to the measures: the part that links the
	// most flakes, reduced to what serves them, contracted, measured.
	// termOf[f] is the node of flake f (or -1), px/py the flakes (km).
	function measureGraph(g, termOf, px, py) {
		if (!g.adjStart) index(g)
		const m = g.u.length
		const on = new Uint8Array(m).fill(1)
		const {flakes, main} = mainPart(g, on, termOf)
		const term = new Uint8Array(g.n)
		for (const f of flakes) term[termOf[f]] = 1
		serve(g, on, term)
		const h = contract(g, on, term)
		const hx = flakes.map((f) => px[f]), hy = flakes.map((f) => py[f])
		const res = flakes.length >= 2 ? evaluate(h, flakes.map((f) => h.from[termOf[f]]), hx, hy) : null
		return {flakes, main, on, net: h, result: res}
	}

	// the connected piece that holds the most flakes
	function mainPart(g, on, termOf) {
		const comp = new Int32Array(g.n).fill(-1)
		const counts = []
		const stack = []
		for (const t of termOf) {
			if (t < 0 || comp[t] >= 0) continue
			const c = counts.length
			counts.push(0)
			comp[t] = c
			stack.push(t)
			while (stack.length) {
				const i = stack.pop()
				for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
					const e = g.adjEdge[k]
					if (!on[e]) continue
					const j = other(g, e, i)
					if (comp[j] < 0) {
						comp[j] = c
						stack.push(j)
					}
				}
			}
		}
		for (const t of termOf) if (t >= 0) counts[comp[t]]++
		let main = -1
		for (let c = 0; c < counts.length; c++) if (main < 0 || counts[c] > counts[main]) main = c
		for (let e = 0; e < g.u.length; e++) if (comp[g.u[e]] !== main) on[e] = 0
		const flakes = []
		termOf.forEach((t, f) => t >= 0 && comp[t] === main && flakes.push(f))
		return {flakes, main}
	}

	// --- The slime's network, from the mesh --------------------------------------

	const scratchFor = new WeakMap()
	function scratch(net) {
		let s = scratchFor.get(net)
		if (!s || s.E !== net.edgeCount || s.N !== net.nodeCount) {
			s = {
				E: net.edgeCount,
				N: net.nodeCount,
				on: new Uint8Array(net.edgeCount),
				used: new Uint8Array(net.edgeCount),
				deg: new Int32Array(net.nodeCount),
				term: new Uint8Array(net.nodeCount),
				comp: new Int32Array(net.nodeCount),
				keep: new Int32Array(net.nodeCount),
				list: new Int32Array(net.nodeCount),
				stack: new Int32Array(net.nodeCount),
			}
			scratchFor.set(net, s)
		}
		return s
	}

	// Douglas-Peucker: the length of the polyline through the mesh nodes in
	// chain, once wiggles smaller than eps (px) are taken out.
	function smoothLength(net, chain, from, to, eps) {
		const X = net.x, Y = net.y
		const n = to - from
		if (n < 2) return 0
		if (n === 2) return Math.hypot(X[chain[from + 1]] - X[chain[from]], Y[chain[from + 1]] - Y[chain[from]])
		const keepIt = new Uint8Array(n)
		keepIt[0] = keepIt[n - 1] = 1
		const stack = [0, n - 1]
		const eps2 = eps * eps
		while (stack.length) {
			const j = stack.pop(), i = stack.pop()
			if (j - i < 2) continue
			const ax = X[chain[from + i]], ay = Y[chain[from + i]]
			const dx = X[chain[from + j]] - ax, dy = Y[chain[from + j]] - ay
			const L2 = dx * dx + dy * dy
			let worst = -1, far = -1
			for (let q = i + 1; q < j; q++) {
				const px = X[chain[from + q]] - ax, py = Y[chain[from + q]] - ay
				let d2
				if (L2 === 0) d2 = px * px + py * py
				else {
					const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2))
					const ex = px - t * dx, ey = py - t * dy
					d2 = ex * ex + ey * ey
				}
				if (d2 > far) (far = d2), (worst = q)
			}
			if (far > eps2) {
				keepIt[worst] = 1
				stack.push(i, worst, worst, j)
			}
		}
		let len = 0, last = chain[from]
		for (let q = 1; q < n; q++) {
			if (!keepIt[q]) continue
			const c = chain[from + q]
			len += Math.hypot(X[c] - X[last], Y[c] - Y[last])
			last = c
		}
		return len
	}

	// The tubes above the threshold, as a graph whose nodes are the flakes and
	// the junctions and whose links are the tubes between them.
	function slimeGraph(net, flakeNodes, pxPerKm, o) {
		const E = net.edgeCount
		const {D, a, b, alive, adjStart, adjEdge} = net
		const s = scratch(net)
		const {on, used, deg, term, comp, keep, list, stack} = s
		let maxD = 0
		for (let e = 0; e < E; e++) if (D[e] > maxD && alive[a[e]] && alive[b[e]]) maxD = D[e]
		const floor = (net.params && net.params.minD) || 1e-4
		const threshold = Math.max(o.floorFactor * floor, o.relThreshold * maxD)
		for (let e = 0; e < E; e++) on[e] = D[e] >= threshold && alive[a[e]] && alive[b[e]] ? 1 : 0

		// the piece of tube network that holds the most flakes
		term.fill(0)
		for (const t of flakeNodes) if (t >= 0) term[t] = 1
		comp.fill(-1)
		const counts = [], starts = []
		let listed = 0
		for (const t of flakeNodes) {
			if (t < 0 || comp[t] >= 0) continue
			const c = counts.length
			counts.push(0)
			starts.push(listed)
			let sp = 0
			stack[sp++] = t
			comp[t] = c
			while (sp) {
				const i = stack[--sp]
				list[listed++] = i
				for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
					const e = adjEdge[k]
					if (!on[e]) continue
					const j = a[e] === i ? b[e] : a[e]
					if (comp[j] < 0) {
						comp[j] = c
						stack[sp++] = j
					}
				}
			}
		}
		starts.push(listed)
		for (const t of flakeNodes) if (t >= 0) counts[comp[t]]++
		let main = -1
		for (let c = 0; c < counts.length; c++) {
			if (main < 0 || counts[c] > counts[main] || (counts[c] === counts[main] && flakeNodes[0] >= 0 && comp[flakeNodes[0]] === c)) main = c
		}
		const empty = {threshold, maxD, graph: null, termOf: flakeNodes.map(() => -1), chains: null}
		if (main < 0) return empty
		const from = starts[main], to = starts[main + 1]

		// dead ends that lead to no flake wither back to where they branch off
		for (let q = from; q < to; q++) {
			const i = list[q]
			let d = 0
			for (let k = adjStart[i]; k < adjStart[i + 1]; k++) if (on[adjEdge[k]]) d++
			deg[i] = d
		}
		let sp = 0
		for (let q = from; q < to; q++) if (deg[list[q]] === 1 && !term[list[q]]) stack[sp++] = list[q]
		while (sp) {
			const i = stack[--sp]
			if (deg[i] !== 1) continue
			for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
				const e = adjEdge[k]
				if (!on[e]) continue
				on[e] = 0
				deg[i] = 0
				const j = a[e] === i ? b[e] : a[e]
				if (--deg[j] === 1 && !term[j]) stack[sp++] = j
				break
			}
		}

		// flakes and junctions become nodes, the tubes between them links
		const xs = [], ys = []
		for (let q = from; q < to; q++) {
			const i = list[q]
			keep[i] = -1
			if (term[i] || (deg[i] > 0 && deg[i] !== 2)) {
				keep[i] = xs.length
				xs.push(net.x[i] / pxPerKm)
				ys.push(net.y[i] / pxPerKm)
			}
		}
		const g = graph(Float64Array.from(xs), Float64Array.from(ys))
		const chainNodes = [], chainStart = [0]
		const eps = o.smoothSpacings * net.spacing
		for (let q = from; q < to; q++) {
			const s0 = list[q]
			if (keep[s0] < 0) continue
			for (let k = adjStart[s0]; k < adjStart[s0 + 1]; k++) {
				const e0 = adjEdge[k]
				if (!on[e0] || used[e0]) continue
				const c0 = chainNodes.length
				chainNodes.push(s0)
				let e = e0, i = s0, raw = 0, weak = Infinity, sumD = 0
				for (;;) {
					used[e] = 1
					raw += net.length[e]
					sumD += D[e] * net.length[e]
					if (D[e] < weak) weak = D[e]
					i = a[e] === i ? b[e] : a[e]
					chainNodes.push(i)
					if (keep[i] >= 0) break
					let next = -1
					for (let q2 = adjStart[i]; q2 < adjStart[i + 1]; q2++) {
						const f = adjEdge[q2]
						if (on[f] && !used[f]) {
							next = f
							break
						}
					}
					if (next < 0) break
					e = next
				}
				chainStart.push(chainNodes.length)
				const smooth = smoothLength(net, chainNodes, c0, chainNodes.length, eps) / pxPerKm
				// a tube's strength: its mean conductivity along its length
				link(g, keep[s0], keep[i], smooth, smooth, sumD / raw, [chainStart.length - 2])
				g.rawKm = (g.rawKm || 0) + raw / pxPerKm
			}
		}
		// used[] must be clean for the next call
		for (let q = from; q < to; q++) {
			const i = list[q]
			for (let k = adjStart[i]; k < adjStart[i + 1]; k++) used[adjEdge[k]] = 0
		}
		index(g)
		const termOf = flakeNodes.map((t) => (t >= 0 && comp[t] === main ? keep[t] : -1))
		return {threshold, maxD, graph: g, termOf, chains: {nodes: Int32Array.from(chainNodes), start: Int32Array.from(chainStart)}}
	}

	// Loops shorter than loopKm are one tube braided on the mesh: drop the
	// weaker side until there are none.
	function unbraid(g, on, loopKm) {
		const m = g.u.length
		const dist = new Float64Array(g.n)
		let removed = 0
		for (;;) {
			let worst = -1
			for (let e = 0; e < m; e++) {
				if (!on[e]) continue
				if (g.len[e] >= loopKm) continue
				let small
				if (g.u[e] === g.v[e]) small = true
				else {
					dijkstra(g, on, g.u[e], dist, loopKm - g.len[e], e)
					small = g.len[e] + dist[g.v[e]] < loopKm
				}
				if (small && (worst < 0 || g.weak[e] < g.weak[worst])) worst = e
			}
			if (worst < 0) return removed
			on[worst] = 0
			removed++
		}
	}

	// --- The real network ----------------------------------------------------------

	const railFor = new WeakMap()
	function railBase(stations, edges, pxPerKm) {
		let r = railFor.get(edges)
		if (r && r.stations === stations && r.pxPerKm === pxPerKm) return r
		const n = stations.length
		const x = new Float64Array(n), y = new Float64Array(n)
		stations.forEach((s, i) => ((x[i] = s.x / pxPerKm), (y[i] = s.y / pxPerKm)))
		r = {stations, pxPerKm, x, y, edges, cache: new Map(), grid: null}
		railFor.set(edges, r)
		return r
	}

	// the S+U track plus a walk from each flake to its nearest station
	function railGraph(base, px, py) {
		const n = base.x.length, k = px.length
		const x = new Float64Array(n + k), y = new Float64Array(n + k)
		x.set(base.x)
		y.set(base.y)
		const g = graph(x, y)
		g.n = n
		for (const [p, q] of base.edges) {
			const d = Math.hypot(base.x[p] - base.x[q], base.y[p] - base.y[q])
			link(g, p, q, d, d)
		}
		const termOf = new Int32Array(k)
		let walkKm = 0
		for (let f = 0; f < k; f++) {
			let best = -1, bestD = Infinity
			for (let i = 0; i < n; i++) {
				const d = Math.hypot(base.x[i] - px[f], base.y[i] - py[f])
				if (d < bestD) (bestD = d), (best = i)
			}
			if (bestD < 0.01) termOf[f] = best // on the station
			else {
				const node = g.n++
				x[node] = px[f]
				y[node] = py[f]
				link(g, node, best, bestD, 0)
				termOf[f] = node
				walkKm += bestD
			}
		}
		g.x = x.subarray(0, g.n)
		g.y = y.subarray(0, g.n)
		g.walkKm = walkKm
		return {g: index(g), termOf}
	}

	// --- Tubes along track -----------------------------------------------------------

	// segments in a grid of cells as big as the reach, to find near ones fast
	function segmentGrid(ax, ay, bx, by, cell) {
		const cells = new Map()
		for (let s = 0; s < ax.length; s++) {
			const x0 = Math.floor(Math.min(ax[s], bx[s]) / cell), x1 = Math.floor(Math.max(ax[s], bx[s]) / cell)
			const y0 = Math.floor(Math.min(ay[s], by[s]) / cell), y1 = Math.floor(Math.max(ay[s], by[s]) / cell)
			for (let cy = y0; cy <= y1; cy++) {
				for (let cx = x0; cx <= x1; cx++) {
					const key = cy * 4096 + cx
					let l = cells.get(key)
					if (!l) cells.set(key, (l = []))
					l.push(s)
				}
			}
		}
		return {cells, cell, ax, ay, bx, by}
	}

	function near(grid, x, y, r2) {
		const {cells, cell, ax, ay, bx, by} = grid
		const cx = Math.floor(x / cell), cy = Math.floor(y / cell)
		for (let yy = cy - 1; yy <= cy + 1; yy++) {
			for (let xx = cx - 1; xx <= cx + 1; xx++) {
				const l = cells.get(yy * 4096 + xx)
				if (!l) continue
				for (const s of l) {
					const dx = bx[s] - ax[s], dy = by[s] - ay[s]
					const px = x - ax[s], py = y - ay[s]
					const L2 = dx * dx + dy * dy
					const t = L2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0
					const ex = px - t * dx, ey = py - t * dy
					if (ex * ex + ey * ey <= r2) return true
				}
			}
		}
		return false
	}

	function overlap(net, base, meshEdges, pxPerKm, o) {
		const R = o.nearKm * pxPerKm, R2 = R * R
		const st = base.stations, edges = base.edges
		const dish = o.dish || {x: net.width / 2, y: net.height / 2, r: Math.min(net.width, net.height) / 2}
		const dr2 = dish.r * dish.r
		if (!base.grid || base.grid.R !== R) {
			const ax = [], ay = [], bx = [], by = []
			for (const [p, q] of edges) ax.push(st[p].x), ay.push(st[p].y), bx.push(st[q].x), by.push(st[q].y)
			base.grid = segmentGrid(ax, ay, bx, by, R)
			base.grid.R = R
		}
		// the tubes, as mesh segments
		const n = meshEdges.length
		const ax = new Float64Array(n), ay = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n)
		let tubeLen = 0, tubeOnRail = 0
		for (let q = 0; q < n; q++) {
			const e = meshEdges[q]
			ax[q] = net.x[net.a[e]]
			ay[q] = net.y[net.a[e]]
			bx[q] = net.x[net.b[e]]
			by[q] = net.y[net.b[e]]
			const len = net.length[e]
			tubeLen += len
			if (near(base.grid, (ax[q] + bx[q]) / 2, (ay[q] + by[q]) / 2, R2)) tubeOnRail += len
		}
		const tubes = segmentGrid(ax, ay, bx, by, R)
		const coverage = new Float32Array(edges.length)
		const step = o.sampleKm * pxPerKm
		let railIn = 0, builtIn = 0
		edges.forEach(([p, q], i) => {
			const x0 = st[p].x, y0 = st[p].y, x1 = st[q].x, y1 = st[q].y
			const L = Math.hypot(x1 - x0, y1 - y0)
			const k = Math.max(1, Math.ceil(L / step))
			let hit = 0
			for (let j = 0; j < k; j++) {
				const t = (j + 0.5) / k
				const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t
				const h = n > 0 && near(tubes, x, y, R2)
				if (h) hit++
				if ((x - dish.x) ** 2 + (y - dish.y) ** 2 <= dr2) {
					railIn += L / k
					if (h) builtIn += L / k
				}
			}
			coverage[i] = hit / k
		})
		return {coverage, railBuilt: railIn > 0 ? builtIn / railIn : 0, slimeOnRail: tubeLen > 0 ? tubeOnRail / tubeLen : 0}
	}

	// --- Putting it together -----------------------------------------------------------

	// The slime's network, measured. flakes: the page's list, in sim px.
	function measureSlime(net, flakes, pxPerKm, o) {
		const flakeNodes = flakes.map((f, i) => (f.alive && net.flakes[i] && net.flakes[i].alive ? net.flakes[i].node : -1))
		const sg = slimeGraph(net, flakeNodes, pxPerKm, o)
		const out = {threshold: sg.threshold, maxD: sg.maxD, flakes: [], result: null, meshEdges: new Int32Array(0), braids: 0}
		if (!sg.graph) return out
		const g = sg.graph
		const on = new Uint8Array(g.u.length).fill(1)
		const term = new Uint8Array(g.n)
		for (const t of sg.termOf) if (t >= 0) term[t] = 1
		out.braids = unbraid(g, on, o.loopSpacings * net.spacing / pxPerKm)
		// what is left of the piece after unbraiding, and what serves the flakes
		const {flakes: linked} = mainPart(g, on, sg.termOf)
		const t2 = new Uint8Array(g.n)
		for (const f of linked) t2[sg.termOf[f]] = 1
		serve(g, on, t2)
		const h = contract(g, on, t2)
		out.flakes = linked
		// the mesh edges of the tubes that are left
		const edgesOut = []
		const {nodes, start} = sg.chains
		for (let e = 0; e < g.u.length; e++) {
			if (!on[e]) continue
			const c = g.parts[e][0]
			for (let q = start[c]; q < start[c + 1] - 1; q++) edgesOut.push(meshEdge(net, nodes[q], nodes[q + 1]))
		}
		out.meshEdges = Int32Array.from(edgesOut)
		out.graph = h
		out.termOf = linked.map((f) => h.from[sg.termOf[f]])
		out.tubes = {graph: g, on, chains: sg.chains} // before contraction, for drawing
		return out
	}

	function meshEdge(net, i, j) {
		for (let k = net.adjStart[i]; k < net.adjStart[i + 1]; k++) {
			const e = net.adjEdge[k]
			if ((net.a[e] === i && net.b[e] === j) || (net.a[e] === j && net.b[e] === i)) return e
		}
		return -1
	}

	function measureRail(base, px, py) {
		const key = Array.from(px, (x, i) => `${x.toFixed(4)},${py[i].toFixed(4)}`).join(';')
		const hit = base.cache.get(key)
		if (hit) return hit
		const {g, termOf} = railGraph(base, px, py)
		const r = measureGraph(g, Array.from(termOf), px, py)
		const res = {result: r.result, connected: r.flakes.length, walkKm: g.walkKm, graph: r.net}
		if (base.cache.size > 16) base.cache.clear()
		base.cache.set(key, res)
		return res
	}

	const pct = (v) => `${Math.round(v * 100)}%`

	// one plain sentence for the panel
	function foot(slime, rail, alive) {
		if (!slime || !rail) return 'The slime needs to link a few more oat flakes before it can be measured.'
		const n = slime.connected
		const lead = n < alive ? `So far the slime links ${n} of ${alive} flakes` : `The slime links all ${n} flakes`
		const ratio = slime.lengthKm / rail.lengthKm
		const track =
			ratio < 0.95 ? `with ${pct(1 - ratio)} less track than the S+U`
			: ratio > 1.05 ? `with ${pct(ratio - 1)} more track than the S+U`
			: 'with about as much track as the S+U'
		const dt = slime.tolerance - rail.tolerance
		const cut =
			dt < -0.1 ? ', but a single cut strands a flake more often'
			: dt > 0.1 ? ', and has more ways around a cut'
			: ', and copes with a cut about as well'
		return `${lead} ${track}${cut}.`
	}

	const pick = (r, connected, lengthKm) =>
		r && {
			cost: r.cost,
			detour: r.detour,
			tolerance: r.tolerance,
			connected,
			lengthKm,
			mdMST: r.mdMST,
			toleranceByLength: r.toleranceByLength,
			cutRisk: r.tolerance == null ? null : 1 - r.tolerance,
			links: r.links,
			bridges: r.bridges,
		}

	// The whole comparison, for the page. net: the SlimeNetwork; flakes: the
	// page's list [{x, y, alive}] in sim px, 0 is where the slime started;
	// stations [{x, y}] in sim px; edges BERLIN.edges; pxPerKm the scale.
	function compare({net, flakes, stations, edges, pxPerKm, options}) {
		const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
		const o = {...DEFAULTS, ...(options || {})}
		const alive = flakes.filter((f) => f.alive).length
		const s = measureSlime(net, flakes, pxPerKm, o)
		const base = railBase(stations, edges, pxPerKm)
		// every flake the rail can serve, and the same flakes the slime links
		const all = []
		flakes.forEach((f, i) => f.alive && all.push(i))
		const railAll = measureRail(base, Float64Array.from(all, (i) => flakes[i].x / pxPerKm), Float64Array.from(all, (i) => flakes[i].y / pxPerKm))
		let slime = null, rail = null, tree = null
		if (s.flakes.length >= 2) {
			const px = Float64Array.from(s.flakes, (i) => flakes[i].x / pxPerKm)
			const py = Float64Array.from(s.flakes, (i) => flakes[i].y / pxPerKm)
			const t = mst(px, py)
			const sr = evaluate(s.graph, s.termOf, px, py, t)
			const rr = measureRail(base, px, py)
			slime = pick(sr, s.flakes.length, sr.lengthKm)
			rail = pick(rr.result, railAll.connected, rr.result && rr.result.lengthKm)
			// tree distances against straight lines, for the same pairs
			let line = 0, along = 0
			const k = px.length
			for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) (line += Math.hypot(px[i] - px[j], py[i] - py[j])), (along += t.dist[i * k + j])
			tree = {cost: 1, detour: along / line - 1, tolerance: 0, connected: k, lengthKm: t.length, mdMST: 1}
		}
		const ov = overlap(net, base, s.meshEdges, pxPerKm, o)
		const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
		return {
			slime,
			rail,
			mst: tree,
			railCoverage: ov.coverage,
			overlap: {railBuilt: ov.railBuilt, slimeOnRail: ov.slimeOnRail},
			foot: foot(slime, rail, alive),
			flakes: {alive, compared: s.flakes.length},
			threshold: s.threshold,
			slimeEdges: s.meshEdges,
			braids: s.braids,
			ms: t1 - t0,
		}
	}

	return {compare, measureSlime, measureRail, railBase, measureGraph, evaluate, mst, graph, link, index, serve, contract, DEFAULTS, TOKYO}
})()

if (typeof module !== 'undefined') module.exports = NetworkMetrics
