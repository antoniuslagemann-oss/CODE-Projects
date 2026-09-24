'use strict'

// The slime as a network of tubes, after the model in Tero et al. (2010).
//
// The dish is covered by a fine mesh of possible tubes. The slime grows out
// from where it was put down and fills the mesh, as a sheet at first. Once it
// has found food, protoplasm streams between the oat flakes: a few flakes at
// a time push, the others take. The flow through each tube follows
// Kirchhoff's laws, like current in a circuit, and each tube thickens with
// the flow through it and thins without. Tubes nobody needs wither away, and
// what is left is a transport network.
//
// D is a tube's conductivity, which goes with the fourth power of its radius,
// so a drawing should make a tube about D^(1/4) wide. Tubes the slime has
// just grown have D = fresh; working tubes settle between about 0.2 and 3;
// the rest sinks to minD.

class SlimeNetwork {
	constructor({width, height, spacing, inside, park, seed = 7}) {
		this.width = width
		this.height = height
		this.spacing = spacing
		this.params = {...SlimeNetwork.DEFAULTS}

		// a triangular lattice, shaken a little so it doesn't look like one
		let s = seed >>> 0
		const rand = () => {
			s = (s + 0x6d2b79f5) >>> 0
			let t = s
			t = Math.imul(t ^ (t >>> 15), t | 1)
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
		const rowH = (spacing * Math.sqrt(3)) / 2
		const cols = Math.ceil(width / spacing) + 1
		const rows = Math.ceil(height / rowH) + 1
		const grid = new Int32Array(cols * rows).fill(-1)
		const xs = [], ys = []
		for (let j = 0; j < rows; j++) {
			for (let i = 0; i < cols; i++) {
				const x = i * spacing + (j & 1 ? spacing / 2 : 0) + (rand() - 0.5) * 0.45 * spacing
				const y = j * rowH + (rand() - 0.5) * 0.45 * rowH
				if (x < 0 || y < 0 || x >= width || y >= height || !inside(x, y)) continue
				grid[j * cols + i] = xs.length
				xs.push(x)
				ys.push(y)
			}
		}
		const ea = [], eb = []
		const link = (a, i, j) => {
			if (i < 0 || j < 0 || i >= cols || j >= rows) return
			const b = grid[j * cols + i]
			if (b < 0) return
			if (!inside((xs[a] + xs[b]) / 2, (ys[a] + ys[b]) / 2)) return
			ea.push(a)
			eb.push(b)
		}
		for (let j = 0; j < rows; j++) {
			for (let i = 0; i < cols; i++) {
				const a = grid[j * cols + i]
				if (a < 0) continue
				link(a, i + 1, j)
				if (j & 1) link(a, i, j + 1), link(a, i + 1, j + 1)
				else link(a, i - 1, j + 1), link(a, i, j + 1)
			}
		}

		const N = (this.nodeCount = xs.length)
		const E = (this.edgeCount = ea.length)
		this.x = Float32Array.from(xs)
		this.y = Float32Array.from(ys)
		this.a = Int32Array.from(ea)
		this.b = Int32Array.from(eb)
		this.length = new Float32Array(E) // px
		this.parkland = new Float32Array(E) // 0..1
		this.light = new Float32Array(E) // 0..1
		for (let e = 0; e < E; e++) {
			const p = ea[e], q = eb[e]
			this.length[e] = Math.hypot(xs[p] - xs[q], ys[p] - ys[q])
			this.parkland[e] = park ? park((xs[p] + xs[q]) / 2, (ys[p] + ys[q]) / 2) : 0
		}

		// Some ground is easier going than other ground, for no reason we can
		// see: each tube gets a random factor of its own, plus a smooth one
		// that changes over a few kilometres. Both are -1..1, drawn once. They
		// make the growing edge come out round and lobed instead of in the
		// hexagon of the lattice, and break ties between parallel routes.
		this.rough = new Float32Array(E)
		this.lumpy = new Float32Array(E)
		const lump = 6 * spacing
		const lc = Math.ceil(width / lump) + 2, lr = Math.ceil(height / lump) + 2
		const knots = Float32Array.from({length: lc * lr}, () => 2 * rand() - 1)
		const smooth = (t) => t * t * (3 - 2 * t)
		for (let e = 0; e < E; e++) {
			const mx = (xs[ea[e]] + xs[eb[e]]) / 2 / lump, my = (ys[ea[e]] + ys[eb[e]]) / 2 / lump
			const i = Math.floor(mx), j = Math.floor(my), u = smooth(mx - i), v = smooth(my - j)
			const k = j * lc + i
			const top = knots[k] + (knots[k + 1] - knots[k]) * u, bottom = knots[k + lc] + (knots[k + lc + 1] - knots[k + lc]) * u
			this.lumpy[e] = top + (bottom - top) * v
			this.rough[e] = 2 * rand() - 1
		}

		// node -> edges and neighbours, for walking the mesh
		const {start, slot, other} = SlimeNetwork.links(N, this.a, this.b)
		this.adjStart = start
		this.adjEdge = slot
		this.adjNode = other

		// The growing edge crawls along the mesh and also straight across each
		// pair of triangles, the long way: twelve directions instead of six,
		// so it spreads in circles rather than hexagons.
		{
			const from = [], to = [], via = [], stretch = []
			const add = (p, q, e, f) => (from.push(p, q), to.push(q, p), via.push(e, e), stretch.push(f, f))
			for (let e = 0; e < E; e++) {
				const p = ea[e], q = eb[e]
				add(p, q, e, 1)
				const apex = []
				for (let k = start[p]; k < start[p + 1]; k++) {
					const r = other[k]
					for (let l = start[q]; l < start[q + 1]; l++) if (other[l] === r) apex.push(r)
				}
				if (apex.length === 2) add(apex[0], apex[1], e, Math.hypot(xs[apex[0]] - xs[apex[1]], ys[apex[0]] - ys[apex[1]]) / this.length[e])
			}
			const cs = new Int32Array(N + 1)
			for (const p of from) cs[p + 1]++
			for (let i = 0; i < N; i++) cs[i + 1] += cs[i]
			const fill = cs.slice(0, N)
			this.crawlStart = cs
			this.crawlNode = new Int32Array(from.length)
			this.crawlEdge = new Int32Array(from.length)
			this.crawlStretch = new Float32Array(from.length)
			for (let k = 0; k < from.length; k++) {
				const at = fill[from[k]]++
				this.crawlNode[at] = to[k]
				this.crawlEdge[at] = via[k]
				this.crawlStretch[at] = stretch[k]
			}
		}

		// find nodes near a point fast
		this.cell = spacing
		this.bucketCols = Math.ceil(width / spacing)
		this.bucketRows = Math.ceil(height / spacing)
		this.buckets = new Map()
		for (let i = 0; i < N; i++) {
			const k = Math.floor(ys[i] / spacing) * this.bucketCols + Math.floor(xs[i] / spacing)
			if (!this.buckets.has(k)) this.buckets.set(k, [])
			this.buckets.get(k).push(i)
		}

		this.D = new Float32Array(E) // conductivity of each tube
		this.born = new Float32Array(E) // when the slime first covered it
		this.flow = new Float32Array(E) // |Q| from the last step, for drawing
		this.flux = new Float32Array(E) // Q from the last step, > 0 when it runs from a to b
		this.arrival = new Float32Array(N) // how far the slime crawls to get here
		this.alive = new Uint8Array(N)
		this.order = new Int32Array(N) // nodes by arrival
		this.grown = 0 // nodes in order[] that the slime has covered
		this.margin = 0 // order[margin..grown] is the growing margin
		this.weight = new Float64Array(E)
		this.pressure = new Float64Array(N)
		this.before = [new Float64Array(N), new Float64Array(N)] // pressures of the last two steps
		this.rhs = new Float64Array(N)
		this.r = new Float64Array(N)
		this.dir = new Float64Array(N)
		this.q = new Float64Array(N)

		// The mesh is the bottom of the multigrid stack (see solve). Its nodes
		// have at most six neighbours, which makes for fast loops.
		const L0 = SlimeNetwork.level(N, this.a, this.b, start, slot, other, this.weight)
		L0.nb = new Int32Array(6 * N)
		L0.ne = new Int32Array(6 * N)
		L0.nw = new Float64Array(6 * N)
		for (let i = 0; i < N; i++) {
			let c = 0
			for (let k = start[i]; k < start[i + 1] && c < 6; k++, c++) {
				L0.nb[6 * i + c] = other[k]
				L0.ne[6 * i + c] = slot[k]
			}
			for (; c < 6; c++) (L0.nb[6 * i + c] = i), (L0.ne[6 * i + c] = -1)
		}
		this.levels = [L0]
		this.built = -Infinity // step when the stack was last made

		this.flakes = [] // {x, y, node, alive}
		this.start = -1
		this.time = 0
		this.steps = 0
		this.front = 0
		this.lightSum = 0
		this.solverIterations = 0
		this.rand = rand
		this.relay = {slots: [], deck: []}
		this.curve = {mu: NaN, nu: NaN, table: null}

		// Take a few steps on a dummy dish covered in slime, with three flakes,
		// so that the first steps of the real slime don't wait for the
		// JavaScript engine to compile all this.
		this.flakes = [0, N >> 1, N - 1].map((i) => ({x: xs[i], y: ys[i], node: i, alive: true}))
		this.inoculate(0)
		this.front = Infinity
		for (let k = 0; k < 6; k++) this.step()
		this.flakes = []
		this.reset()
	}

	// forget everything the slime did
	reset() {
		this.D.fill(0)
		this.born.fill(0)
		this.flow.fill(0)
		this.flux.fill(0)
		this.alive.fill(0)
		this.pressure.fill(0)
		this.before[0].fill(0)
		this.before[1].fill(0)
		this.time = 0
		this.steps = 0
		this.front = 0
		this.grown = 0
		this.margin = 0
		this.built = this.levels.length > 1 ? 0 : -Infinity // a stack we have will do for a while
		this.relay = {slots: [], deck: []}
	}

	nearestNode(x, y) {
		const c = this.cell
		const bx = Math.floor(x / c), by = Math.floor(y / c)
		let best = -1, bestD = Infinity
		for (let r = 0; r <= 4 && best < 0; r++) {
			for (let yy = by - r; yy <= by + r; yy++) {
				for (let xx = bx - r; xx <= bx + r; xx++) {
					const list = this.buckets.get(yy * this.bucketCols + xx)
					if (!list) continue
					for (const i of list) {
						const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2
						if (d < bestD) (bestD = d), (best = i)
					}
				}
			}
		}
		return best
	}

	// list: [{x, y, alive}], same order as the page keeps them. A flake that
	// wasn't there before gets to push first: the slime has news to share.
	setFlakes(list) {
		const old = this.flakes
		this.flakes = list.map((f, i) => {
			const node = f.alive ? this.nearestNode(f.x, f.y) : -1
			const was = old[i]
			if (f.alive && this.time > 0 && !(was && was.alive && was.node === node)) this.relay.deck.unshift(i)
			return {x: f.x, y: f.y, node, alive: !!f.alive}
		})
	}

	// how hard it is to push protoplasm through tube e
	cost(e) {
		const P = this.params
		return this.length[e] * (1 + P.parkCost * this.parkland[e] + P.lightCost * this.light[e]) * (1 + P.jitter * this.rough[e])
	}

	// how long it takes the growing edge to cross it
	crawlCost(e) {
		const P = this.params
		const ground = 1 + P.parkCost * this.parkland[e] + P.lightCost * this.light[e]
		return this.length[e] * ground * Math.max(0.3, 1 + P.roughness * this.rough[e] + P.lobes * this.lumpy[e])
	}

	// Put the slime down on one oat flake and let it start over.
	inoculate(flake) {
		const N = this.nodeCount
		const f = this.flakes[flake]
		this.start = f.node >= 0 ? f.node : this.nearestNode(f.x, f.y)
		this.reset()
		this.lightSum = this.sumLight()
		const dist = new Float64Array(N).fill(Infinity)
		dist[this.start] = 0
		this.crawl(dist, [this.start])
		this.arrival.set(dist)
		const order = Array.from({length: N}, (_, i) => i).sort((p, q) => dist[p] - dist[q])
		this.order.set(order)
	}

	// How far the slime has to crawl to reach every node, from the nodes in
	// seeds (Dijkstra). Distances are doubles here; arrival keeps floats.
	crawl(dist, seeds) {
		const N = this.nodeCount
		const heap = new Int32Array(N), at = new Int32Array(N).fill(-1)
		let size = 0
		const up = (k) => {
			const i = heap[k], d = dist[i]
			while (k > 0) {
				const p = (k - 1) >> 1
				if (dist[heap[p]] <= d) break
				heap[k] = heap[p]
				at[heap[k]] = k
				k = p
			}
			heap[k] = i
			at[i] = k
		}
		const down = (k) => {
			const i = heap[k], d = dist[i]
			for (;;) {
				const l = 2 * k + 1
				if (l >= size) break
				const m = l + 1 < size && dist[heap[l + 1]] < dist[heap[l]] ? l + 1 : l
				if (dist[heap[m]] >= d) break
				heap[k] = heap[m]
				at[heap[k]] = k
				k = m
			}
			heap[k] = i
			at[i] = k
		}
		for (const i of seeds) (heap[size] = i), (at[i] = size), up(size++)
		while (size) {
			const i = heap[0]
			at[i] = -2
			heap[0] = heap[--size]
			if (size) down(0)
			for (let k = this.crawlStart[i]; k < this.crawlStart[i + 1]; k++) {
				const j = this.crawlNode[k]
				if (at[j] === -2) continue
				const nd = dist[i] + this.crawlCost(this.crawlEdge[k]) * this.crawlStretch[k]
				if (nd >= dist[j]) continue
				dist[j] = nd
				if (at[j] < 0) (heap[size] = j), (at[j] = size), up(size++)
				else up(at[j])
			}
		}
	}

	// When light falls on ground the slime hasn't covered yet, it finds a new
	// way around.
	recrawl() {
		const N = this.nodeCount
		const dist = new Float64Array(N).fill(Infinity)
		const seeds = []
		for (let g = 0; g < this.grown; g++) {
			const i = this.order[g]
			dist[i] = this.arrival[i]
			seeds.push(i)
		}
		this.crawl(dist, seeds)
		const rest = Array.from(this.order.subarray(this.grown)).sort((p, q) => dist[p] - dist[q])
		this.order.set(rest, this.grown)
		for (const i of rest) this.arrival[i] = dist[i]
	}

	sumLight() {
		let s = 0
		for (let e = 0; e < this.edgeCount; e++) s += this.light[e]
		return s
	}

	reachedFlakes() {
		const out = []
		this.flakes.forEach((f, i) => {
			if (f.alive && f.node >= 0 && this.alive[f.node]) out.push(i)
		})
		return out
	}

	step() {
		const P = this.params
		this.time += P.dt
		this.steps++
		const light = this.sumLight()
		if (light !== this.lightSum) {
			this.lightSum = light
			if (this.grown < this.nodeCount) this.recrawl()
		}
		this.grow()
		if (this.drive()) {
			this.weigh()
			const rebuild = this.steps - this.built >= P.rebuild
			if (rebuild) this.build()
			this.refresh()
			this.solve(rebuild ? 1 : P.maxIterations)
		} else {
			this.pressure.fill(0)
			this.solverIterations = 0
		}
		this.adapt()
	}

	// the growing edge of the slime moves on
	grow() {
		const P = this.params
		const {order, arrival, alive, adjStart, adjEdge, adjNode, D, born} = this
		this.front += P.growth * this.spacing * P.dt
		while (this.grown < this.nodeCount) {
			const i = order[this.grown]
			if (!(arrival[i] <= this.front)) break
			alive[i] = 1
			this.grown++
			for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
				if (!alive[adjNode[k]]) continue
				const e = adjEdge[k]
				D[e] = P.fresh
				born[e] = this.time
			}
		}
		const back = this.front - P.margin * this.spacing
		while (this.margin < this.grown && arrival[order[this.margin]] <= back) this.margin++
	}

	// Where protoplasm goes in and comes out this step. Returns false when
	// nothing moves.
	drive() {
		const P = this.params
		const rhs = this.rhs.fill(0)
		const reached = this.reachedFlakes()
		const n = reached.length
		const put = (f, amount) => (rhs[this.flakes[f].node] += amount)
		let moving = false

		// A few flakes push, each for a while, and the others take (Tero et
		// al. have one flake push at a time). The pushers hand over one after
		// the other, and every flake gets its turn.
		if (n >= 2) {
			moving = true
			const R = this.relay
			const k = Math.max(1, Math.min(P.sources, n - 1))
			while (R.slots.length < k) R.slots.push({source: -1, previous: -1, since: -Infinity})
			R.slots.length = k
			const push = (f, amount) => {
				put(f, amount + amount / (n - 1))
				for (const j of reached) put(j, -amount / (n - 1))
			}
			R.slots.forEach((slot, i) => {
				if (slot.source < 0 || !reached.includes(slot.source) || this.steps - slot.since >= P.hold) {
					const busy = R.slots.map((o) => o.source)
					R.deck = R.deck.filter((f, j) => reached.includes(f) && !busy.includes(f) && R.deck.indexOf(f) === j)
					if (!R.deck.length) {
						R.deck = reached.filter((f) => !busy.includes(f))
						for (let a = R.deck.length - 1; a > 0; a--) {
							const b = Math.floor(this.rand() * (a + 1))
							;[R.deck[a], R.deck[b]] = [R.deck[b], R.deck[a]]
						}
					}
					slot.previous = reached.includes(slot.source) ? slot.source : -1
					slot.source = R.deck.length ? R.deck.shift() : reached[i % n]
					// the first time round, the pushers start staggered
					slot.since = slot.since === -Infinity ? this.steps - Math.round((i * P.hold) / k) : this.steps
				}
				const lambda = slot.previous < 0 ? 1 : Math.min(1, (this.steps - slot.since + 1) / P.fade)
				push(slot.source, P.flow * lambda)
				if (lambda < 1) push(slot.previous, P.flow * (1 - lambda))
			})
		}

		// The growing margin eats. What it eats comes from the whole body and
		// from the flakes the slime has found.
		const m = this.grown - this.margin
		if (m > 0 && P.feed > 0) {
			moving = true
			const total = P.feed * m
			for (let s = this.margin; s < this.grown; s++) rhs[this.order[s]] -= P.feed
			const body = n ? P.body : 1
			const each = (total * body) / this.grown
			for (let s = 0; s < this.grown; s++) rhs[this.order[s]] += each
			for (const f of reached) put(f, (total * (1 - body)) / n)
		} else if (n === 1 && P.forage > 0) {
			// with a single oat flake and nothing left to cover, the slime
			// feeds itself from it, all over
			moving = true
			const each = P.forage / this.grown
			for (let s = 0; s < this.grown; s++) rhs[this.order[s]] -= each
			put(reached[0], P.forage)
		}
		return moving
	}

	// Conductance of each tube. Mesh the slime hasn't covered gets a trickle,
	// so that the solver sees one connected dish.
	weigh() {
		const P = this.params
		const {a, b, alive, D, weight, length, parkland, light, rough} = this
		const dead = P.minD * 1e-2
		for (let e = 0, E = this.edgeCount; e < E; e++) {
			const c = length[e] * (1 + P.parkCost * parkland[e] + P.lightCost * light[e]) * (1 + P.jitter * rough[e])
			weight[e] = (alive[a[e]] && alive[b[e]] ? D[e] : dead) / c
		}
	}

	// How a tube answers the flow through it, f(Q) = Q^mu / (1 + Q^(mu - nu)).
	// With little flow it goes as Q^mu and tubes compete for the flow (for mu
	// above 1); with a lot it goes as Q^nu and tubes stop competing, which
	// lets loops live (for nu = 0 this is Tero et al.'s sigmoid). It is
	// looked up in a table over the bits of Q, much faster than pow.
	response() {
		const P = this.params, C = this.curve
		if (C.mu === P.mu && C.nu === P.nu) return C.table
		const T = new Float64Array(SlimeNetwork.TABLE + 2)
		for (let j = 0; j <= SlimeNetwork.TABLE + 1; j++) {
			const k = SlimeNetwork.LOW + j
			const Q = 2 ** ((k >> 5) - 1023) * (1 + (k & 31) / 32)
			T[j] = Q ** P.mu / (1 + Q ** (P.mu - P.nu))
		}
		C.mu = P.mu
		C.nu = P.nu
		return (C.table = T)
	}

	// tubes grow with the flow through them and shrink without
	adapt() {
		const P = this.params
		const {D, flow, flux, weight, a, b, alive, pressure} = this
		const T = this.response()
		const bits = SlimeNetwork.BITS, word = SlimeNetwork.WORDS, hi = SlimeNetwork.HIGH
		const LOW = SlimeNetwork.LOW, SIZE = SlimeNetwork.TABLE, top = T[SIZE]
		const dt = P.dt, minD = P.minD, decay = P.decay
		for (let e = 0, E = this.edgeCount; e < E; e++) {
			const p = a[e], s = b[e]
			if (!alive[p] || !alive[s]) continue
			const q = weight[e] * (pressure[p] - pressure[s])
			flux[e] = q
			const Q = q < 0 ? -q : q
			flow[e] = Q
			bits[0] = Q
			const h = word[hi]
			const j = (h >>> 15) - LOW
			const g = j < 0 ? 0 : j >= SIZE ? top : T[j] + (h & 0x7fff) * (1 / 32768) * (T[j + 1] - T[j])
			const d = D[e] + dt * (g - decay * D[e])
			D[e] = d > minD ? d : minD
		}
	}

	// --- Kirchhoff ---
	// Find the pressure at every node so that what flows in equals what flows
	// out. Conjugate gradients (the flexible kind), started from where the
	// last two steps point, with a multigrid cycle as the preconditioner: a
	// stack of coarser and coarser copies of the mesh where each coarse node
	// stands for a few strongly linked nodes below it. Thick tubes get merged
	// first, so a long tube shrinks to a few nodes a few levels up and its
	// pressure settles in one sweep instead of creeping along it node by
	// node. The tubes change slowly and forgive small errors, so a loose
	// tolerance and a few iterations per step are plenty; whatever is left
	// over gets fixed in the next steps.
	solve(maxIterations) {
		const P = this.params
		const L = this.levels[0]
		const N = this.nodeCount
		const x = this.pressure, b = this.rhs, r = this.r, d = this.dir, q = this.q, z = L.x
		const [p1, p2] = this.before
		for (let i = 0; i < N; i++) x[i] = 2 * p1[i] - p2[i]
		SlimeNetwork.multiply(L, x, q)
		let bb = 0, rr = 0
		for (let i = 0; i < N; i++) {
			r[i] = b[i] - q[i]
			bb += b[i] * b[i]
			rr += r[i] * r[i]
		}
		const tol = P.tolerance ** 2 * bb
		let it = 0, dq = 1
		for (; it < maxIterations && rr > tol; it++) {
			L.b.set(r)
			this.cycle(0)
			if (it === 0) d.set(z)
			else {
				let zq = 0
				for (let i = 0; i < N; i++) zq += z[i] * q[i]
				const beta = zq / dq
				for (let i = 0; i < N; i++) d[i] = z[i] - beta * d[i]
			}
			SlimeNetwork.multiply(L, d, q)
			let dr = 0
			dq = 0
			for (let i = 0; i < N; i++) (dq += d[i] * q[i]), (dr += d[i] * r[i])
			if (!(dq > 0)) break
			const alpha = dr / dq
			rr = 0
			for (let i = 0; i < N; i++) {
				x[i] += alpha * d[i]
				r[i] -= alpha * q[i]
				rr += r[i] * r[i]
			}
		}
		let mean = 0
		for (let i = 0; i < N; i++) mean += x[i]
		mean /= N
		for (let i = 0; i < N; i++) x[i] -= mean
		p2.set(p1)
		p1.set(x)
		this.solverIterations = it
	}

	// one multigrid cycle on level l: L.x ~ A^-1 L.b
	cycle(l) {
		const levels = this.levels
		const L = levels[l]
		if (l === levels.length - 1) return SlimeNetwork.dense(L)
		const {n, agg, x, t} = L
		x.fill(0)
		SlimeNetwork.smooth(L, true)
		SlimeNetwork.residual(L)
		const C = levels[l + 1]
		const cb = C.b.fill(0)
		for (let i = 0; i < n; i++) cb[agg[i]] += t[i]
		if (l + 1 === levels.length - 1) SlimeNetwork.dense(C)
		else this.kcycle(l + 1)
		const cx = C.x
		for (let i = 0; i < n; i++) x[i] += cx[agg[i]]
		SlimeNetwork.smooth(L, false)
	}

	// Two cycles on a coarse level, combined as well as conjugate gradients
	// can (Notay's K-cycle). This keeps a tall stack working well.
	kcycle(l) {
		const C = this.levels[l]
		const {n, b, x, r0, v1, w1, w2} = C
		r0.set(b)
		this.cycle(l)
		v1.set(x)
		SlimeNetwork.multiply(C, v1, w1)
		let rho1 = 0, alpha1 = 0
		for (let i = 0; i < n; i++) (rho1 += v1[i] * w1[i]), (alpha1 += v1[i] * r0[i])
		if (!(rho1 > 0)) return x.fill(0)
		const s1 = alpha1 / rho1
		let rr = 0, r00 = 0
		for (let i = 0; i < n; i++) {
			b[i] = r0[i] - s1 * w1[i]
			rr += b[i] * b[i]
			r00 += r0[i] * r0[i]
		}
		if (rr <= 0.0625 * r00) {
			for (let i = 0; i < n; i++) x[i] = s1 * v1[i]
			return
		}
		this.cycle(l)
		SlimeNetwork.multiply(C, x, w2)
		let gamma = 0, beta = 0, alpha2 = 0
		for (let i = 0; i < n; i++) (gamma += x[i] * w1[i]), (beta += x[i] * w2[i]), (alpha2 += x[i] * b[i])
		const rho2 = beta - (gamma * gamma) / rho1
		if (!(rho2 > 0)) {
			for (let i = 0; i < n; i++) x[i] = s1 * v1[i]
			return
		}
		const c1 = s1 - (gamma * alpha2) / (rho1 * rho2), c2 = alpha2 / rho2
		for (let i = 0; i < n; i++) x[i] = c1 * v1[i] + c2 * x[i]
	}

	// Make the stack of coarse levels for the current conductances: pair up
	// strongly linked nodes twice, so four or so fine nodes make a coarse one.
	// Which nodes go together matters much less than the conductances, which
	// refresh() brings up to date every step, so this can wait a long time.
	build() {
		const levels = this.levels
		levels.length = 1
		let L = levels[0]
		while (L.n > 40) {
			const [agg1, n1] = SlimeNetwork.pair(L)
			const [T, map1] = SlimeNetwork.coarsen(L, agg1, n1)
			SlimeNetwork.restrict(L, T, map1)
			const [agg2, n2] = SlimeNetwork.pair(T)
			if (n2 > 0.8 * L.n) break
			const agg = new Int32Array(L.n)
			for (let i = 0; i < L.n; i++) agg[i] = agg2[agg1[i]]
			const [C, map] = SlimeNetwork.coarsen(L, agg, n2)
			L.agg = agg
			L.map = map
			SlimeNetwork.restrict(L, C, map)
			levels.push(C)
			L = C
		}
		const Z = levels[levels.length - 1]
		Z.chol = new Float64Array(Math.max(1, (Z.n - 1) * (Z.n - 1)))
		this.built = this.steps
	}

	// new conductances on every level
	refresh() {
		const levels = this.levels
		const {n, ne, nw, w, diag, idiag} = levels[0]
		for (let i = 0, j = 0; i < n; i++) {
			let s = 0
			for (let c = 0; c < 6; c++, j++) {
				const e = ne[j]
				const v = e >= 0 ? w[e] : 0
				nw[j] = v
				s += v
			}
			diag[i] = s
			idiag[i] = 1 / s
		}
		for (let l = 1; l < levels.length; l++) {
			const L = levels[l]
			SlimeNetwork.restrict(levels[l - 1], L, levels[l - 1].map)
			const {n, start, slot, w, wk, diag, idiag} = L
			for (let i = 0; i < n; i++) {
				let s = 0
				for (let k = start[i]; k < start[i + 1]; k++) {
					const v = w[slot[k]]
					wk[k] = v
					s += v
				}
				diag[i] = s
				idiag[i] = 1 / s
			}
		}
		SlimeNetwork.factor(levels[levels.length - 1])
	}
}

// a double seen as two 32 bit words, for reading its exponent quickly
SlimeNetwork.BITS = new Float64Array(1)
SlimeNetwork.WORDS = new Uint32Array(SlimeNetwork.BITS.buffer)
SlimeNetwork.BITS[0] = 1
SlimeNetwork.HIGH = SlimeNetwork.WORDS[1] === 0x3ff00000 ? 1 : 0
// the response table covers 2^-40 to 2^24 with 32 steps per doubling
SlimeNetwork.LOW = (1023 - 40) * 32
SlimeNetwork.TABLE = 64 * 32

// node -> edges and neighbours
SlimeNetwork.links = (n, ea, eb) => {
	const m = ea.length
	const start = new Int32Array(n + 1)
	for (let e = 0; e < m; e++) start[ea[e] + 1]++, start[eb[e] + 1]++
	for (let i = 0; i < n; i++) start[i + 1] += start[i]
	const slot = new Int32Array(2 * m), other = new Int32Array(2 * m)
	const fill = start.slice(0, n)
	for (let e = 0; e < m; e++) {
		const p = ea[e], q = eb[e]
		slot[fill[p]] = e
		other[fill[p]++] = q
		slot[fill[q]] = e
		other[fill[q]++] = p
	}
	return {start, slot, other}
}

// one level of the multigrid stack
SlimeNetwork.level = (n, ea, eb, start, slot, other, w) => {
	const v = () => new Float64Array(n)
	return {
		n, m: ea.length, ea, eb, start, slot, other, w,
		wk: new Float64Array(slot.length), diag: v(), idiag: v(),
		x: v(), b: v(), t: v(), r0: v(), v1: v(), w1: v(), w2: v(),
		nb: null, ne: null, nw: null, agg: null, map: null, chol: null,
	}
}

// Pair up nodes along their strongest links, the most strongly linked nodes
// first. Nodes left over join their strongest neighbour.
SlimeNetwork.pair = (L) => {
	const {n, w, start, slot, other} = L
	const bits = SlimeNetwork.BITS, word = SlimeNetwork.WORDS, hi = SlimeNetwork.HIGH
	const top = new Float64Array(n)
	const key = new Int32Array(n)
	let kmax = 0
	for (let i = 0; i < n; i++) {
		let t = 0
		for (let k = start[i]; k < start[i + 1]; k++) if (w[slot[k]] > t) t = w[slot[k]]
		top[i] = t
		bits[0] = t
		key[i] = word[hi] >>> 20
		if (key[i] > kmax) kmax = key[i]
	}
	// sort nodes by the doubling their strongest link falls in
	const K = 64
	const count = new Int32Array(K + 1)
	for (let i = 0; i < n; i++) {
		key[i] = Math.min(K - 1, kmax - key[i])
		count[key[i] + 1]++
	}
	for (let k = 0; k < K; k++) count[k + 1] += count[k]
	const sorted = new Int32Array(n)
	for (let i = 0; i < n; i++) sorted[count[key[i]]++] = i
	const agg = new Int32Array(n).fill(-1)
	let c = 0
	for (let s = 0; s < n; s++) {
		const i = sorted[s]
		if (agg[i] >= 0) continue
		let best = -1, bw = 0.25 * top[i]
		for (let k = start[i]; k < start[i + 1]; k++) {
			const j = other[k]
			if (agg[j] >= 0) continue
			const v = w[slot[k]]
			if (v >= bw && v >= 0.25 * top[j]) (bw = v), (best = j)
		}
		if (best >= 0) agg[i] = agg[best] = c++
	}
	for (let i = 0; i < n; i++) {
		if (agg[i] >= 0) continue
		let best = -1, bw = -1
		for (let k = start[i]; k < start[i + 1]; k++) {
			const j = other[k], v = w[slot[k]]
			if (agg[j] >= 0 && v > bw) (bw = v), (best = j)
		}
		agg[i] = best >= 0 ? agg[best] : c++
	}
	return [agg, c]
}

// the level above L, where node i of L becomes node agg[i]
SlimeNetwork.coarsen = (L, agg, nc) => {
	const {n, start, slot, other} = L
	const first = new Int32Array(nc + 1)
	for (let i = 0; i < n; i++) first[agg[i] + 1]++
	for (let c = 0; c < nc; c++) first[c + 1] += first[c]
	const members = new Int32Array(n), fill = first.slice(0, nc)
	for (let i = 0; i < n; i++) members[fill[agg[i]]++] = i
	const owner = new Int32Array(nc).fill(-1), id = new Int32Array(nc)
	const map = new Int32Array(L.m).fill(-1)
	const ca = new Int32Array(L.m), cb = new Int32Array(L.m)
	let m = 0
	for (let c = 0; c < nc; c++) {
		for (let s = first[c]; s < first[c + 1]; s++) {
			const i = members[s]
			for (let k = start[i]; k < start[i + 1]; k++) {
				const c2 = agg[other[k]]
				if (c2 <= c) continue
				if (owner[c2] !== c) {
					owner[c2] = c
					id[c2] = m
					ca[m] = c
					cb[m++] = c2
				}
				map[slot[k]] = id[c2]
			}
		}
	}
	const ea = ca.slice(0, m), eb = cb.slice(0, m)
	const {start: cs, slot: csl, other: co} = SlimeNetwork.links(nc, ea, eb)
	return [SlimeNetwork.level(nc, ea, eb, cs, csl, co, new Float64Array(m)), map]
}

// conductances of the level above: the sum of the links between two groups
SlimeNetwork.restrict = (L, C, map) => {
	const cw = C.w.fill(0), w = L.w
	for (let e = 0; e < L.m; e++) {
		const c = map[e]
		if (c >= 0) cw[c] += w[e]
	}
}

// out = A v
SlimeNetwork.multiply = (L, v, out) => {
	const {n, diag} = L
	if (L.nb) {
		const {nb, nw} = L
		for (let i = 0, j = 0; i < n; i++, j += 6)
			out[i] = diag[i] * v[i] - nw[j] * v[nb[j]] - nw[j + 1] * v[nb[j + 1]] - nw[j + 2] * v[nb[j + 2]] - nw[j + 3] * v[nb[j + 3]] - nw[j + 4] * v[nb[j + 4]] - nw[j + 5] * v[nb[j + 5]]
		return
	}
	const {start, other, wk} = L
	for (let i = 0; i < n; i++) {
		let s = diag[i] * v[i]
		for (let k = start[i], end = start[i + 1]; k < end; k++) s -= wk[k] * v[other[k]]
		out[i] = s
	}
}

// t = b - A x
SlimeNetwork.residual = (L) => {
	const {n, diag, x, b, t} = L
	if (L.nb) {
		const {nb, nw} = L
		for (let i = 0, j = 0; i < n; i++, j += 6)
			t[i] = b[i] - diag[i] * x[i] + nw[j] * x[nb[j]] + nw[j + 1] * x[nb[j + 1]] + nw[j + 2] * x[nb[j + 2]] + nw[j + 3] * x[nb[j + 3]] + nw[j + 4] * x[nb[j + 4]] + nw[j + 5] * x[nb[j + 5]]
		return
	}
	const {start, other, wk} = L
	for (let i = 0; i < n; i++) {
		let s = b[i] - diag[i] * x[i]
		for (let k = start[i], end = start[i + 1]; k < end; k++) s += wk[k] * x[other[k]]
		t[i] = s
	}
}

// a Gauss-Seidel sweep, forwards or backwards
SlimeNetwork.smooth = (L, forwards) => {
	const {n, idiag, x, b} = L
	if (L.nb) {
		const {nb, nw} = L
		if (forwards) {
			for (let i = 0, j = 0; i < n; i++, j += 6)
				x[i] = (b[i] + nw[j] * x[nb[j]] + nw[j + 1] * x[nb[j + 1]] + nw[j + 2] * x[nb[j + 2]] + nw[j + 3] * x[nb[j + 3]] + nw[j + 4] * x[nb[j + 4]] + nw[j + 5] * x[nb[j + 5]]) * idiag[i]
		} else {
			for (let i = n - 1, j = 6 * (n - 1); i >= 0; i--, j -= 6)
				x[i] = (b[i] + nw[j] * x[nb[j]] + nw[j + 1] * x[nb[j + 1]] + nw[j + 2] * x[nb[j + 2]] + nw[j + 3] * x[nb[j + 3]] + nw[j + 4] * x[nb[j + 4]] + nw[j + 5] * x[nb[j + 5]]) * idiag[i]
		}
		return
	}
	const {start, other, wk} = L
	if (forwards) {
		for (let i = 0; i < n; i++) {
			let s = b[i]
			for (let k = start[i], end = start[i + 1]; k < end; k++) s += wk[k] * x[other[k]]
			x[i] = s * idiag[i]
		}
	} else {
		for (let i = n - 1; i >= 0; i--) {
			let s = b[i]
			for (let k = start[i], end = start[i + 1]; k < end; k++) s += wk[k] * x[other[k]]
			x[i] = s * idiag[i]
		}
	}
}

// Cholesky on the top level, with node 0 held at pressure 0
SlimeNetwork.factor = (Z) => {
	const m = Z.n - 1, A = Z.chol
	if (m <= 0) return
	A.fill(0)
	for (let i = 1; i < Z.n; i++) A[(i - 1) * m + i - 1] = Z.diag[i]
	for (let e = 0; e < Z.m; e++) {
		const p = Z.ea[e] - 1, q = Z.eb[e] - 1
		if (p < 0 || q < 0) continue
		A[p * m + q] -= Z.w[e]
		A[q * m + p] -= Z.w[e]
	}
	for (let j = 0; j < m; j++) {
		let d = A[j * m + j]
		for (let k = 0; k < j; k++) d -= A[j * m + k] * A[j * m + k]
		d = Math.sqrt(Math.max(d, 1e-300))
		A[j * m + j] = d
		for (let i = j + 1; i < m; i++) {
			let s = A[i * m + j]
			for (let k = 0; k < j; k++) s -= A[i * m + k] * A[j * m + k]
			A[i * m + j] = s / d
		}
	}
}

SlimeNetwork.dense = (Z) => {
	const m = Z.n - 1, A = Z.chol, x = Z.x, b = Z.b
	x[0] = 0
	for (let i = 0; i < m; i++) {
		let s = b[i + 1]
		for (let k = 0; k < i; k++) s -= A[i * m + k] * x[k + 1]
		x[i + 1] = s / A[i * m + i]
	}
	for (let i = m - 1; i >= 0; i--) {
		let s = x[i + 1]
		for (let k = i + 1; k < m; k++) s -= A[k * m + i] * x[k + 1]
		x[i + 1] = s / A[i * m + i]
	}
}

SlimeNetwork.DEFAULTS = {
	dt: 0.01, // time per step; a tube left without flow thins by 1/e in 1/(dt decay) steps
	decay: 1,
	mu: 1.8, // how tubes answer the flow, see response()
	nu: 0.7,
	flow: 10, // protoplasm each pushing flake sends out per unit time
	sources: 4, // flakes pushing at once
	hold: 24, // steps one flake keeps pushing: the flow keeps its direction
	fade: 4, // steps for one flake to hand over to the next
	feed: 0.01, // protoplasm each node on the growing margin eats
	body: 0.5, // how much of that comes from the whole body, not the flakes
	margin: 3, // mesh spacings of the growing margin that eat
	forage: 4, // flow from the one flake to the body when there is only one
	minD: 1e-3,
	fresh: 0.4, // conductivity of a tube the slime has just grown
	growth: 9, // mesh spacings the growing edge covers per unit time
	roughness: 0.25, // how much the growing edge's pace varies from tube to tube
	lobes: 0.3, // and from one stretch of ground to the next
	jitter: 0.05, // how much tubes differ in how easily protoplasm flows
	parkCost: 1.5, // parkland makes a tube this much longer, relatively
	lightCost: 12,
	tolerance: 1e-2,
	maxIterations: 3, // solver iterations per step, at most
	rebuild: 250, // steps between rebuilds of the multigrid stack
}

if (typeof module !== 'undefined') module.exports = SlimeNetwork
