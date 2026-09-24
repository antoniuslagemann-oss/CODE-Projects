'use strict'

// How the slime's network measures up against the real S-Bahn and U-Bahn,
// after Tero et al. (2010), "Rules for Biologically Inspired Adaptive Network
// Design", Science 327:439. They compared Physarum networks between 36 food
// sources with the Tokyo rail network linking the same cities on cost,
// transport efficiency and fault tolerance, and so does this:
//
//   cost       TL/MST: total length of the network over the length of the
//              minimum spanning tree of the flakes (straight lines between
//              them). Tokyo: Physarum 1.75, rail 1.8.
//   detour     how much longer trips between flakes are than straight lines:
//              the sum over all pairs of flakes of the shortest distance along
//              the network, over the sum of the straight-line distances, less
//              one. The paper divides the same sum by the one along the MST
//              instead (MD_MST, 0.85 for both Physarum and rail); that is
//              reported too, as mdMST.
//   tolerance  FT: the chance that one link, picked at random, can break
//              without cutting any flake off. A link is a tube or a stretch of
//              track between two flakes or junctions; the ones that cut
//              something off are the bridges. The paper gives the other side:
//              14% of single link failures cut part of the Physarum network
//              off, 4% of the rail network (cutRisk here). Weighting each link
//              by its length ("a random stretch breaks") is reported too, as
//              toleranceByLength.
//
// Both networks are cut down to what serves the flakes: every tube or piece
// of track that lies on some route between two flakes that passes no place
// twice. Dead ends that lead to no flake go, and so do loops that hang off the
// network at a single point. For the rail that drops the lines beyond the
// outermost flakes but keeps every loop and parallel line between them, which
// is where its tolerance comes from. A flake that is not on a station is
// joined to the nearest one by a walk, which counts towards the distances but
// not towards the track length, and cannot break.
//
// The slime's network is its tubes above a threshold: 1/1000 of the strongest
// tube's conductivity, and at least 4 times the model's floor. Conductivities
// fall into two groups, withered tubes at the floor and live ones a hundred
// times above it, and the threshold sits in the gap. Of those tubes, only the
// piece that links the most flakes counts. Two strands that run side by side
// less than 1.5 mesh spacings apart are one tube braided on the mesh, not two
// routes, and keep only their stronger side. Lengths follow the tubes with the
// zig-zag of the mesh smoothed out (Douglas-Peucker to 0.75 mesh spacings): a
// straight run on this mesh is 6.5% longer than the line it stands for, 2.4%
// once smoothed, and the rail is measured as straight lines between stations.
//
// While the slime is still spreading as a sheet it has no network to measure
// yet; the result then says forming and leaves the measures out.
//
// Everything is compared over the same flakes: the ones the slime has linked,
// with the rail and the MST taken over just those.
//
// Along the track: a piece of S+U track counts as built by the slime where a
// measured tube runs within 400 m of it (railCoverage, per BERLIN.edges entry,
// 0..1 of its length); railBuilt is the built share of all S+U track inside the
// dish, slimeOnRail the share of the slime's tube length within 400 m of track.
//
// NetworkMetrics.compare({net, flakes, stations, edges, pxPerKm, options})
//   net       the SlimeNetwork (D, alive, mesh, flakes[i].node, params)
//   flakes    the page's list [{x, y, alive}] in sim px; 0 is where it started
//   stations  [{x, y}] in sim px, edges BERLIN.edges, pxPerKm the scale
// returns
//   slime, rail  {cost, detour, tolerance, connected, lengthKm, mdMST,
//                toleranceByLength, cutRisk, links, bridges}; the measures are
//                null while fewer than two flakes are linked or while forming
//   mst          the same for the minimum spanning tree (cost 1, tolerance 0)
//   railCoverage Float32Array(edges.length), or null while forming
//   overlap      {railBuilt, slimeOnRail}, or null while forming
//   foot         one plain sentence for the panel
//   forming, flakes {alive, compared}, threshold, slimeEdges (the mesh edges
//   of the measured tubes), braids (strands taken out), ms
// It takes a millisecond or two; the rail side is cached per set of flakes.

const NetworkMetrics = (() => {
	const DEFAULTS = {
		relThreshold: 1e-3, // a tube counts from this fraction of the strongest one...
		floorFactor: 4, // ...and from this many times the model's floor (minD)
		braidSpacings: 1.5, // loops narrower than this many mesh spacings are one braided tube
		smoothSpacings: 0.75, // zig-zag smaller than this many mesh spacings is smoothed away
		nearKm: 0.4, // a tube within this of a track runs along it
		sampleKm: 0.1, // step when walking along track to check that
		railMode: 'serve', // or 'shortest': only the track on the shortest route between two flakes
		dish: null, // {x, y, r} in sim px; the circle inside the mesh's square if not given
	}

	// Tokyo, for reference (Tero et al. 2010)
	const TOKYO = {
		physarum: {cost: 1.75, mdMST: 0.85, cutRisk: 0.14, tolerance: 0.86},
		rail: {cost: 1.8, mdMST: 0.85, cutRisk: 0.04, tolerance: 0.96},
	}

	const dist = (ax, ay, bx, by) => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by))

	// --- A binary heap of (key, value), reused -----------------------------------

	class Heap {
		constructor(capacity = 256) {
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
	// len is what a trip along a link covers, track what it adds to the length
	// of the network (a walk has track 0 and cannot break), weak how strong it
	// is (for tubes, the mean conductivity), parts what it was made of.

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
		for (let e = 0; e < m; e++) {
			start[g.u[e] + 1]++
			if (g.v[e] !== g.u[e]) start[g.v[e] + 1]++ // a loop on one node is listed once
		}
		for (let i = 0; i < n; i++) start[i + 1] += start[i]
		const fill = start.slice(0, n)
		const adj = new Int32Array(start[n])
		for (let e = 0; e < m; e++) {
			adj[fill[g.u[e]]++] = e
			if (g.v[e] !== g.u[e]) adj[fill[g.v[e]]++] = e
		}
		g.adjStart = start
		g.adjEdge = adj
		return g
	}

	const other = (g, e, i) => (g.u[e] === i ? g.v[e] : g.u[e])

	// Shortest distances from one node over the links that are on. With `to`,
	// stops there; with `via`, records the link each node was reached by.
	function dijkstra(g, on, from, out, {limit = Infinity, skip = -1, to = -1, via = null} = {}) {
		out.fill(Infinity)
		if (via) via.fill(-1)
		out[from] = 0
		heap.size = 0
		heap.push(0, from)
		while (heap.size) {
			const i = heap.pop()
			const d = heap.topKey
			if (d > out[i]) continue
			if (i === to || d > limit) break
			for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
				const e = g.adjEdge[k]
				if (!on[e] || e === skip) continue
				const j = other(g, e, i)
				const nd = d + g.len[e]
				if (nd < out[j]) {
					out[j] = nd
					if (via) via[j] = e
					heap.push(nd, j)
				}
			}
		}
		return out
	}

	// Depth-first search on the links that are on, as Tarjan does it: entry
	// times and low points give the bridges and the blocks (biconnected
	// components). Iterative, and parallel links are told apart.
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
					if (w === v) continue // a loop closes on itself
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

	// Keep only what serves the terminals: the links on some simple path
	// between two of them. Blocks of the block-cut tree that hang off by a
	// single cut vertex and hold no terminal of their own go, until none is left.
	function serve(g, on, term) {
		const n = g.n, m = g.u.length
		for (let e = 0; e < m; e++) if (g.u[e] === g.v[e]) on[e] = 0
		const {block, blocks} = tarjan(g, on, true)
		if (!blocks) return on
		const byBlock = Array.from({length: blocks}, () => [])
		for (let e = 0; e < m; e++) if (on[e] && block[e] >= 0) byBlock[block[e]].push(e)
		// the nodes of each block, and how many blocks each node is in
		const stamp = new Int32Array(n).fill(-1)
		const bStart = new Int32Array(blocks + 1)
		const members = []
		const nBlocks = new Int32Array(n)
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
		const nodeBlocks = new Map()
		for (let bl = 0; bl < blocks; bl++) {
			for (let k = bStart[bl]; k < bStart[bl + 1]; k++) {
				const i = members[k]
				if (nBlocks[i] < 2) continue
				if (!nodeBlocks.has(i)) nodeBlocks.set(i, [])
				nodeBlocks.get(i).push(bl)
			}
		}
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
					for (const b2 of nodeBlocks.get(i)) {
						if (gone[b2]) continue
						cuts[b2]--
						queue.push(b2)
					}
				}
			}
		}
		return on
	}

	// Keep only the track on some shortest route between two terminals.
	function shortestUnion(g, on, terms) {
		const keep = new Uint8Array(g.u.length)
		const d = new Float64Array(g.n), via = new Int32Array(g.n)
		const uniq = [...new Set(terms)]
		for (let s = 0; s < uniq.length; s++) {
			dijkstra(g, on, uniq[s], d, {via})
			for (let t = s + 1; t < uniq.length; t++) {
				for (let i = uniq[t]; i !== uniq[s] && via[i] >= 0; i = other(g, via[i], i)) keep[via[i]] = 1
			}
		}
		for (let e = 0; e < on.length; e++) on[e] = on[e] && keep[e] ? 1 : 0
		return on
	}

	// Merge chains through nodes that are neither terminals nor junctions into
	// single links. Returns a new graph on the nodes that are left; h.from maps
	// old nodes to new ones (or -1).
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
					if (next < 0) break
					e = next
				}
				if (keep[i] >= 0) link(h, keep[s], keep[i], len, track, weak, parts)
			}
		}
		return index(h)
	}

	// Euclidean minimum spanning tree (Prim), and the distances along it.
	function mst(px, py) {
		const k = px.length
		const inTree = new Uint8Array(k), best = new Float64Array(k).fill(Infinity), parent = new Int32Array(k).fill(-1)
		const order = new Int32Array(k)
		let total = 0
		if (k) best[0] = 0
		for (let it = 0; it < k; it++) {
			let u = -1
			for (let i = 0; i < k; i++) if (!inTree[i] && (u < 0 || best[i] < best[u])) u = i
			inTree[u] = 1
			order[it] = u
			if (parent[u] >= 0) total += best[u]
			for (let i = 0; i < k; i++) {
				if (inTree[i]) continue
				const d = dist(px[i], py[i], px[u], py[u])
				if (d < best[i]) (best[i] = d), (parent[i] = u)
			}
		}
		// distance along the tree between every pair: each node's row is its
		// parent's row plus the step to the parent, except towards its own subtree
		const along = new Float64Array(k * k)
		for (let s = 0; s < k; s++) {
			// walk the tree from s, in Prim order from the root outwards and back
			const row = s * k
			const seen = new Uint8Array(k)
			const stack = [s]
			seen[s] = 1
			while (stack.length) {
				const u = stack.pop()
				// neighbours: the parent and the children
				const p = parent[u]
				if (p >= 0 && !seen[p]) {
					seen[p] = 1
					along[row + p] = along[row + u] + best[u]
					stack.push(p)
				}
				for (let c = 0; c < k; c++) {
					if (parent[c] !== u || seen[c]) continue
					seen[c] = 1
					along[row + c] = along[row + u] + best[c]
					stack.push(c)
				}
			}
		}
		return {length: total, dist: along, parent}
	}

	// The measures of a network that serves the flakes. termOf[f] is the node
	// of flake f in g, px/py where the flakes are (km).
	function evaluate(g, termOf, px, py, tree = mst(px, py)) {
		const k = termOf.length
		const m = g.u.length
		const on = new Uint8Array(m).fill(1)
		let lengthKm = 0
		for (let e = 0; e < m; e++) lengthKm += g.track[e]
		// shortest distances between the flakes
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
				line += dist(px[i], py[i], px[j], py[j])
				alongMst += tree.dist[i * k + j]
				pairs++
			}
		}
		// links whose failure cuts a flake off are the bridges
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

	// the connected piece that holds the most terminals; switches the rest off
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

	// Any graph with terminals, measured: the piece that links the most flakes,
	// cut down to what serves them, contracted. termOf[f] is the node of flake
	// f (or -1), px/py the flakes (km). mode 'shortest' keeps only the links on
	// shortest routes between flakes.
	function measureGraph(g, termOf, px, py, mode = 'serve') {
		if (!g.adjStart) index(g)
		const on = new Uint8Array(g.u.length).fill(1)
		const {flakes} = mainPart(g, on, termOf)
		const term = new Uint8Array(g.n)
		for (const f of flakes) term[termOf[f]] = 1
		if (mode === 'shortest') shortestUnion(g, on, flakes.map((f) => termOf[f]))
		serve(g, on, term)
		const h = contract(g, on, term)
		const hx = flakes.map((f) => px[f]), hy = flakes.map((f) => py[f])
		const result = flakes.length >= 2 ? evaluate(h, flakes.map((f) => h.from[termOf[f]]), hx, hy) : null
		return {flakes, on, net: h, result}
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

	// Douglas-Peucker: the length of the polyline through the mesh nodes
	// chain[from..to) once wiggles smaller than eps (px) are taken out.
	function smoothLength(net, chain, from, to, eps) {
		const X = net.x, Y = net.y
		const n = to - from
		if (n < 2) return 0
		if (n === 2) return dist(X[chain[from]], Y[chain[from]], X[chain[from + 1]], Y[chain[from + 1]])
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
			let far = -1, worst = -1
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
			len += dist(X[c], Y[c], X[last], Y[last])
			last = c
		}
		return len
	}

	// The tubes above the threshold as a graph: its nodes the flakes and the
	// junctions, its links the tubes between them. Only the piece that holds
	// the most flakes, without the dead ends that lead to none.
	function slimeGraph(net, flakeNodes, pxPerKm, o) {
		const E = net.edgeCount
		const {D, a, b, alive, adjStart, adjEdge} = net
		const P = net.params || {}
		const s = scratch(net)
		const {on, used, deg, term, comp, keep, list, stack} = s
		let maxD = 0
		for (let e = 0; e < E; e++) if (D[e] > maxD && alive[a[e]] && alive[b[e]]) maxD = D[e]
		const floor = P.minD || 1e-4
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
		const startComp = flakeNodes[0] >= 0 ? comp[flakeNodes[0]] : -1
		for (let c = 0; c < counts.length; c++) {
			if (main < 0 || counts[c] > counts[main] || (counts[c] === counts[main] && c === startComp)) main = c
		}
		if (main < 0) return {threshold, maxD, graph: null, termOf: flakeNodes.map(() => -1), chains: null}
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

		// Still a sheet? A tube younger than it takes a fresh one to wither
		// below the threshold may be there only because the slime just grew over
		// it; and tubes don't meet four or more at a node, a sheet does.
		const youngAge = P.decay > 0 ? Math.log(Math.max(1, (P.fresh || 0.4) / threshold)) / P.decay : 0
		const hasAge = net.born && typeof net.time === 'number'
		let onLen = 0, youngLen = 0, nodes = 0, crowded = 0
		for (let q = from; q < to; q++) {
			const i = list[q]
			if (deg[i] === 0) continue
			nodes++
			if (deg[i] >= 4) crowded++
			for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
				const e = adjEdge[k]
				if (!on[e] || a[e] !== i) continue // each edge once
				onLen += net.length[e]
				if (hasAge && net.time - net.born[e] < youngAge) youngLen += net.length[e]
			}
		}
		const young = onLen > 0 ? youngLen / onLen : 0
		const sheet = nodes > 0 ? crowded / nodes : 0
		const termOf0 = flakeNodes.map((t) => (t >= 0 && comp[t] === main ? t : -1))
		if (young > 0.25 || sheet > 0.15) {
			return {threshold, maxD, graph: null, termOf: termOf0, forming: true, young, sheet, rawKm: onLen / pxPerKm, chains: null}
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
		let rawKm = 0
		for (let q = from; q < to; q++) {
			const s0 = list[q]
			if (keep[s0] < 0) continue
			for (let k = adjStart[s0]; k < adjStart[s0 + 1]; k++) {
				const e0 = adjEdge[k]
				if (!on[e0] || used[e0]) continue
				const c0 = chainNodes.length
				chainNodes.push(s0)
				let e = e0, i = s0, raw = 0, sumD = 0
				for (;;) {
					used[e] = 1
					const L = net.length[e]
					raw += L
					sumD += D[e] * L
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
				if (keep[i] < 0) {
					// can't happen after pruning, but never link to nowhere
					chainNodes.length = c0
					continue
				}
				chainStart.push(chainNodes.length)
				const smooth = smoothLength(net, chainNodes, c0, chainNodes.length, eps) / pxPerKm
				// a tube's strength is its mean conductivity along its length
				link(g, keep[s0], keep[i], smooth, smooth, sumD / raw, [chainStart.length - 2])
				rawKm += raw / pxPerKm
			}
		}
		// leave used[] clean for the next call
		for (let q = from; q < to; q++) {
			const i = list[q]
			for (let k = adjStart[i]; k < adjStart[i + 1]; k++) used[adjEdge[k]] = 0
		}
		index(g)
		const termOf = flakeNodes.map((t) => (t >= 0 && comp[t] === main ? keep[t] : -1))
		return {
			threshold,
			maxD,
			graph: g,
			termOf,
			rawKm,
			young,
			sheet,
			forming: false,
			chains: {nodes: Int32Array.from(chainNodes), start: Int32Array.from(chainStart)},
		}
	}

	// Two strands that run side by side are one tube braided on the mesh, not
	// two routes. For every link on a loop, take the smallest loop through it
	// and its mean width, twice its area over its length. Where that is below
	// braidKm, the weakest link of the loop goes. Each round takes out the
	// weakest link of every such loop at once. That never cuts the network in
	// two: a cut needs at least two links, every loop through the strongest of
	// them crosses the cut again through a weaker one, so it is never the
	// weakest of its loop and stays.
	function unbraid(g, on, chains, net, braidKm, pxPerKm, rounds = 8) {
		const m = g.u.length
		const d = new Float64Array(g.n), via = new Int32Array(g.n)
		const cut = new Uint8Array(m)
		const X = net.x, Y = net.y
		const weaker = (f, w) => w < 0 || g.weak[f] < g.weak[w] || (g.weak[f] === g.weak[w] && f < w)
		let removed = 0
		for (let round = 0; round < rounds; round++) {
			const {bridge} = tarjan(g, on, false)
			cut.fill(0)
			let any = false
			for (let e = 0; e < m; e++) {
				if (!on[e] || bridge[e] || g.u[e] === g.v[e]) continue
				// the smallest loop through e: e itself, then the shortest way back
				dijkstra(g, on, g.v[e], d, {skip: e, to: g.u[e], via, limit: 40})
				if (!(d[g.u[e]] <= 40)) continue
				const back = []
				for (let i = g.u[e]; i !== g.v[e]; i = other(g, via[i], i)) back.push(via[i])
				// its outline, in mesh nodes: along e from u to v, then back to u
				let area = 0, len = 0, weakest = -1, at = g.u[e]
				const n0 = chains.nodes[chains.start[g.parts[e][0]]]
				let px = X[n0], py = Y[n0]
				for (let q = -1; q < back.length; q++) {
					const f = q < 0 ? e : back[back.length - 1 - q]
					const c = g.parts[f][0]
					const c0 = chains.start[c], c1 = chains.start[c + 1]
					const forward = g.u[f] === at
					for (let r = 1; r < c1 - c0; r++) {
						const node = chains.nodes[forward ? c0 + r : c1 - 1 - r]
						const x = X[node], y = Y[node]
						area += px * y - x * py
						len += dist(x, y, px, py)
						px = x
						py = y
					}
					at = forward ? g.v[f] : g.u[f]
					if (weaker(f, weakest)) weakest = f
				}
				const width = len > 0 ? Math.abs(area) / len / pxPerKm : 0
				if (width < braidKm) {
					cut[weakest] = 1
					any = true
				}
			}
			if (!any) break
			for (let e = 0; e < m; e++) if (cut[e]) (on[e] = 0), removed++
		}
		return removed
	}

	function meshEdge(net, i, j) {
		for (let k = net.adjStart[i]; k < net.adjStart[i + 1]; k++) {
			const e = net.adjEdge[k]
			if ((net.a[e] === i && net.b[e] === j) || (net.a[e] === j && net.b[e] === i)) return e
		}
		return -1
	}

	// The slime's network, measured. flakes: the page's list, in sim px.
	function measureSlime(net, flakes, pxPerKm, o = DEFAULTS) {
		const flakeNodes = flakes.map((f, i) => (f.alive && net.flakes[i] && net.flakes[i].alive ? net.flakes[i].node : -1))
		const sg = slimeGraph(net, flakeNodes, pxPerKm, o)
		const out = {threshold: sg.threshold, maxD: sg.maxD, forming: !!sg.forming, young: sg.young, sheet: sg.sheet, flakes: [], meshEdges: new Int32Array(0), braids: 0, graph: null, termOf: null}
		if (sg.forming) {
			// a sheet, not a network yet: count what it links, measure nothing
			sg.termOf.forEach((t, f) => t >= 0 && out.flakes.push(f))
			out.lengthKm = sg.rawKm
			return out
		}
		if (!sg.graph) return out
		const g = sg.graph
		const on = new Uint8Array(g.u.length).fill(1)
		out.braids = unbraid(g, on, sg.chains, net, (o.braidSpacings * net.spacing) / pxPerKm, pxPerKm)
		// what is left of the piece after unbraiding, cut down to what serves
		const {flakes: linked} = mainPart(g, on, sg.termOf)
		const term = new Uint8Array(g.n)
		for (const f of linked) term[sg.termOf[f]] = 1
		serve(g, on, term)
		const h = contract(g, on, term)
		// the mesh edges of the tubes that are left
		const edgesOut = []
		const {nodes, start} = sg.chains
		for (let e = 0; e < g.u.length; e++) {
			if (!on[e]) continue
			const c = g.parts[e][0]
			for (let q = start[c]; q < start[c + 1] - 1; q++) edgesOut.push(meshEdge(net, nodes[q], nodes[q + 1]))
		}
		out.flakes = linked
		out.meshEdges = Int32Array.from(edgesOut)
		out.graph = h
		out.termOf = linked.map((f) => h.from[sg.termOf[f]])
		out.tubes = {graph: g, on, chains: sg.chains} // before contracting, for drawing
		return out
	}

	// --- The real network ----------------------------------------------------------

	const railFor = new WeakMap()
	function railBase(stations, edges, pxPerKm) {
		let r = railFor.get(edges)
		if (r && r.stations === stations && r.pxPerKm === pxPerKm) return r
		const n = stations.length
		const x = new Float64Array(n), y = new Float64Array(n)
		stations.forEach((s, i) => ((x[i] = s.x / pxPerKm), (y[i] = s.y / pxPerKm)))
		const len = Float64Array.from(edges, ([p, q]) => dist(x[p], y[p], x[q], y[q]))
		// which stations the track joins up, for counting what it links
		const root = Int32Array.from({length: n}, (_, i) => i)
		const find = (i) => {
			while (root[i] !== i) i = root[i] = root[root[i]]
			return i
		}
		for (const [p, q] of edges) root[find(p)] = find(q)
		const comp = Int32Array.from({length: n}, (_, i) => find(i))
		r = {stations, pxPerKm, x, y, edges, len, comp, cache: new Map(), grid: null}
		railFor.set(edges, r)
		return r
	}

	function nearestStation(base, x, y) {
		let best = -1, bestD = Infinity
		for (let i = 0; i < base.x.length; i++) {
			const d = (base.x[i] - x) * (base.x[i] - x) + (base.y[i] - y) * (base.y[i] - y)
			if (d < bestD) (bestD = d), (best = i)
		}
		return {station: best, km: Math.sqrt(bestD)}
	}

	// how many of the flakes the S+U links, each walking to its nearest station
	function railLinks(base, px, py) {
		const counts = new Map()
		let most = 0
		for (let f = 0; f < px.length; f++) {
			const c = base.comp[nearestStation(base, px[f], py[f]).station]
			const k = (counts.get(c) || 0) + 1
			counts.set(c, k)
			if (k > most) most = k
		}
		return most
	}

	// the S+U track plus a walk from each flake to its nearest station
	function railGraph(base, px, py) {
		const n = base.x.length, k = px.length
		const x = new Float64Array(n + k), y = new Float64Array(n + k)
		x.set(base.x)
		y.set(base.y)
		const g = graph(x, y)
		base.edges.forEach(([p, q], i) => link(g, p, q, base.len[i], base.len[i], 0, i))
		const termOf = new Int32Array(k)
		let walkKm = 0, nodes = n
		for (let f = 0; f < k; f++) {
			const {station: best, km: bestD} = nearestStation(base, px[f], py[f])
			if (bestD < 0.01) termOf[f] = best // on the station
			else {
				const node = nodes++
				x[node] = px[f]
				y[node] = py[f]
				link(g, node, best, bestD, 0, 0, -1)
				termOf[f] = node
				walkKm += bestD
			}
		}
		g.n = nodes
		g.x = x.subarray(0, nodes)
		g.y = y.subarray(0, nodes)
		g.walkKm = walkKm
		return {g: index(g), termOf}
	}

	function measureRail(base, px, py, mode = 'serve') {
		let key = mode
		for (let i = 0; i < px.length; i++) key += `;${Math.round(px[i] * 1000)},${Math.round(py[i] * 1000)}`
		const hit = base.cache.get(key)
		if (hit) return hit
		const {g, termOf} = railGraph(base, px, py)
		const r = measureGraph(g, Array.from(termOf), px, py, mode)
		const res = {result: r.result, connected: r.flakes.length, walkKm: g.walkKm, graph: r.net, full: g, on: r.on}
		if (base.cache.size > 16) base.cache.clear()
		base.cache.set(key, res)
		return res
	}

	// --- Tubes along track -----------------------------------------------------------

	// Segments bucketed in square cells as big as the reach, to find near ones
	// fast. reuse: a grid from an earlier call whose buffers can be filled again.
	function segmentGrid(ax, ay, bx, by, cell, W, H, reuse = null) {
		const cols = Math.max(1, Math.ceil(W / cell) + 2), rows = Math.max(1, Math.ceil(H / cell) + 2)
		const cells = cols * rows
		const cellOf = (v, n) => Math.min(n - 1, Math.max(0, Math.floor(v / cell) + 1))
		const fits = reuse && reuse.cols === cols && reuse.rows === rows
		const count = fits ? reuse.start.fill(0) : new Int32Array(cells + 1)
		const fill = fits ? reuse.fill : new Int32Array(cells)
		const n = ax.length
		const x0 = new Int32Array(n), x1 = new Int32Array(n), y0 = new Int32Array(n), y1 = new Int32Array(n)
		for (let s = 0; s < n; s++) {
			x0[s] = cellOf(Math.min(ax[s], bx[s]), cols)
			x1[s] = cellOf(Math.max(ax[s], bx[s]), cols)
			y0[s] = cellOf(Math.min(ay[s], by[s]), rows)
			y1[s] = cellOf(Math.max(ay[s], by[s]), rows)
			for (let cy = y0[s]; cy <= y1[s]; cy++) for (let cx = x0[s]; cx <= x1[s]; cx++) count[cy * cols + cx + 1]++
		}
		for (let c = 0; c < cells; c++) count[c + 1] += count[c]
		fill.set(count.subarray(0, cells))
		const items = fits && reuse.items.length >= count[cells] ? reuse.items : new Int32Array(Math.max(count[cells], 16) * 2)
		for (let s = 0; s < n; s++) for (let cy = y0[s]; cy <= y1[s]; cy++) for (let cx = x0[s]; cx <= x1[s]; cx++) items[fill[cy * cols + cx]++] = s
		return {start: count, fill, items, cols, rows, cell, cellOf, ax, ay, bx, by}
	}

	function near(grid, x, y, r2) {
		const {start, items, cols, rows, cellOf, ax, ay, bx, by} = grid
		const cx = cellOf(x, cols), cy = cellOf(y, rows)
		for (let yy = Math.max(0, cy - 1); yy <= Math.min(rows - 1, cy + 1); yy++) {
			for (let xx = Math.max(0, cx - 1); xx <= Math.min(cols - 1, cx + 1); xx++) {
				const c = yy * cols + xx
				for (let q = start[c]; q < start[c + 1]; q++) {
					const s = items[q]
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

	// Per piece of track, the share of its length within reach of a tube; the
	// share of all track in the dish the slime built; the share of the tubes
	// that run along track.
	function overlap(net, base, meshEdges, pxPerKm, o) {
		const R = o.nearKm * pxPerKm, R2 = R * R
		const st = base.stations, edges = base.edges
		const W = net.width || 1024, H = net.height || 1024
		const dish = o.dish || {x: W / 2, y: H / 2, r: Math.min(W, H) / 2}
		const dr2 = dish.r * dish.r
		const sampleKey = `${R}|${o.sampleKm}|${dish.x},${dish.y},${dish.r}|${W}x${H}`
		if (!base.grid || base.grid.key !== sampleKey) {
			const ax = Float64Array.from(edges, ([p]) => st[p].x), ay = Float64Array.from(edges, ([p]) => st[p].y)
			const bx = Float64Array.from(edges, ([, q]) => st[q].x), by = Float64Array.from(edges, ([, q]) => st[q].y)
			base.grid = segmentGrid(ax, ay, bx, by, R, W, H)
			base.grid.key = sampleKey
			// sample points along the track, and which are in the dish
			const step = o.sampleKm * pxPerKm
			const sx = [], sy = [], sw = [], of = [], inDish = []
			edges.forEach(([p, q], i) => {
				const x0 = st[p].x, y0 = st[p].y, x1 = st[q].x, y1 = st[q].y
				const L = dist(x0, y0, x1, y1)
				const k = Math.max(1, Math.ceil(L / step))
				for (let j = 0; j < k; j++) {
					const t = (j + 0.5) / k
					const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t
					sx.push(x)
					sy.push(y)
					sw.push(1 / k)
					of.push(i)
					inDish.push((x - dish.x) ** 2 + (y - dish.y) ** 2 <= dr2 ? (L / k) / pxPerKm : 0)
				}
			})
			base.samples = {x: Float64Array.from(sx), y: Float64Array.from(sy), w: Float64Array.from(sw), of: Int32Array.from(of), inDish: Float64Array.from(inDish)}
		}
		const coverage = new Float32Array(edges.length)
		const n = meshEdges.length
		if (!n) return {coverage, railBuilt: 0, slimeOnRail: 0}
		// the tubes, as mesh segments
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
		const tubes = segmentGrid(ax, ay, bx, by, R, W, H, base.tubeGrid)
		base.tubeGrid = tubes
		const S = base.samples
		let railIn = 0, builtIn = 0
		for (let q = 0; q < S.x.length; q++) {
			const hit = near(tubes, S.x[q], S.y[q], R2)
			if (hit) coverage[S.of[q]] += S.w[q]
			railIn += S.inDish[q]
			if (hit) builtIn += S.inDish[q]
		}
		return {coverage, railBuilt: railIn > 0 ? builtIn / railIn : 0, slimeOnRail: tubeLen > 0 ? tubeOnRail / tubeLen : 0}
	}

	// --- Putting it together -----------------------------------------------------------

	const pct = (v) => `${Math.round(v * 100)}%`

	// one plain sentence for the panel
	function foot(slime, rail, alive, forming) {
		if (forming) return 'The slime is still spreading out. Its network takes shape as the tubes it doesn’t need wither.'
		if (!slime || !rail || slime.cost == null) return 'The slime needs to link a few more oat flakes before its network can be measured.'
		const n = slime.connected
		const lead = n < alive ? `So far the slime links ${n} of ${alive} flakes` : `The slime links all ${n} flakes`
		const ratio = slime.lengthKm / rail.lengthKm
		const track =
			ratio < 0.95 ? `with ${pct(1 - ratio)} less track than the S+U`
			: ratio > 1.05 ? `with ${pct(ratio - 1)} more track than the S+U`
			: 'with about as much track as the S+U'
		const dt = slime.tolerance - rail.tolerance
		const cut =
			dt < -0.1 ? ', but one broken tube cuts a flake off more often'
			: dt > 0.1 ? ', and has more ways around a break'
			: ', and copes with a break about as well'
		return `${lead} ${track}${cut}.`
	}

	const pick = (r, connected) =>
		r
			? {
					cost: r.cost,
					detour: r.detour,
					tolerance: r.tolerance,
					connected,
					lengthKm: r.lengthKm,
					mdMST: r.mdMST,
					toleranceByLength: r.toleranceByLength,
					cutRisk: r.tolerance == null ? null : 1 - r.tolerance,
					links: r.links,
					bridges: r.bridges,
				}
			: {cost: null, detour: null, tolerance: null, connected, lengthKm: null}

	const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

	// The whole comparison, for the page.
	//   net       the SlimeNetwork
	//   flakes    the page's list [{x, y, alive}] in sim px, 0 is where the slime started
	//   stations  [{x, y}] in sim px, edges BERLIN.edges, pxPerKm the scale
	//   options   to override DEFAULTS
	function compare({net, flakes, stations, edges, pxPerKm, options}) {
		const t0 = now()
		const o = {...DEFAULTS, ...(options || {})}
		const alive = flakes.filter((f) => f.alive).length
		const s = measureSlime(net, flakes, pxPerKm, o)
		if (!stations || !stations.length || !edges || !edges.length) throw new Error('NetworkMetrics.compare needs stations and edges')
		const base = railBase(stations, edges, pxPerKm)
		const at = (list) => [Float64Array.from(list, (i) => flakes[i].x / pxPerKm), Float64Array.from(list, (i) => flakes[i].y / pxPerKm)]
		// all the flakes the rail links, for the count
		const all = []
		flakes.forEach((f, i) => f.alive && all.push(i))
		const railConnected = railLinks(base, ...at(all))
		let slime, rail, tree = null
		if (s.flakes.length >= 2 && !s.forming) {
			// the same flakes the slime links, for everything else
			const [px, py] = at(s.flakes)
			const t = mst(px, py)
			slime = pick(evaluate(s.graph, s.termOf, px, py, t), s.flakes.length)
			rail = pick(measureRail(base, px, py, o.railMode).result, railConnected)
			let line = 0, along = 0
			const k = px.length
			for (let i = 0; i < k; i++) {
				for (let j = i + 1; j < k; j++) {
					line += dist(px[i], py[i], px[j], py[j])
					along += t.dist[i * k + j]
				}
			}
			tree = {cost: 1, detour: along / line - 1, tolerance: 0, connected: k, lengthKm: t.length, mdMST: 1}
		} else {
			slime = pick(null, s.flakes.length)
			if (s.forming) (slime.forming = true), (slime.lengthKm = s.lengthKm)
			// nothing to compare with yet: the rail over all the flakes
			rail = pick(all.length >= 2 ? measureRail(base, ...at(all), o.railMode).result : null, railConnected)
		}
		const ov = s.forming ? null : overlap(net, base, s.meshEdges, pxPerKm, o)
		return {
			slime,
			rail,
			mst: tree,
			railCoverage: ov ? ov.coverage : null,
			overlap: ov ? {railBuilt: ov.railBuilt, slimeOnRail: ov.slimeOnRail} : null,
			foot: foot(slime, rail, alive, s.forming),
			forming: s.forming,
			flakes: {alive, compared: s.forming ? 0 : s.flakes.length},
			threshold: s.threshold,
			slimeEdges: s.meshEdges,
			braids: s.braids,
			ms: now() - t0,
		}
	}

	return {compare, measureSlime, measureRail, railBase, measureGraph, evaluate, mst, graph, link, index, serve, contract, tarjan, DEFAULTS, TOKYO}
})()

if (typeof module !== 'undefined') module.exports = NetworkMetrics
