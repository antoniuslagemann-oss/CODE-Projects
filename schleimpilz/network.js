'use strict'

// The slime as a network of tubes, after the model in Tero et al. (2010).
//
// The dish is covered by a fine mesh of possible tubes. The slime grows out
// from where it was put down and fills the mesh. Once it has found food,
// protoplasm streams from one oat flake to the others. The flow through each
// tube follows Kirchhoff's laws, like current in a circuit, and each tube
// thickens with the flow through it and thins without. Tubes nobody needs
// wither away, and what is left is a transport network.

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

		// node -> edges, for walking the mesh
		const degree = new Int32Array(N + 1)
		for (let e = 0; e < E; e++) degree[ea[e] + 1]++, degree[eb[e] + 1]++
		for (let i = 0; i < N; i++) degree[i + 1] += degree[i]
		this.adjStart = degree
		this.adjEdge = new Int32Array(2 * E)
		const fill = degree.slice(0, N)
		for (let e = 0; e < E; e++) {
			this.adjEdge[fill[ea[e]]++] = e
			this.adjEdge[fill[eb[e]]++] = e
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
		this.flux = new Float32Array(E) // Q along a -> b from the last step, signed
		this.arrival = new Float32Array(N) // how far the slime crawls to get here
		this.alive = new Uint8Array(N)
		this.order = new Int32Array(N) // nodes by arrival
		this.grown = 0 // nodes in order[] that the slime has covered
		this.weight = new Float64Array(E)
		this.diag = new Float64Array(N)
		this.rhs = new Float64Array(N)
		this.r = new Float64Array(N)
		this.z = new Float64Array(N)
		this.dir = new Float64Array(N)
		this.q = new Float64Array(N)
		this.warm = new Map() // source node -> last pressures, to start from
		this.flakes = [] // {node, alive}
		this.start = -1
		this.time = 0
		this.front = 0
		this.solverIterations = 0
		this.rand = rand
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

	// list: [{x, y, alive}], same order as the page keeps them
	setFlakes(list) {
		this.flakes = list.map((f) => ({node: f.alive ? this.nearestNode(f.x, f.y) : -1, alive: !!f.alive}))
	}

	cost(e) {
		const P = this.params
		return this.length[e] * (1 + P.parkCost * this.parkland[e] + P.lightCost * this.light[e])
	}

	// Put the slime down on one oat flake and let it start over.
	inoculate(flake) {
		const N = this.nodeCount
		this.start = this.flakes[flake].node
		this.D.fill(0)
		this.born.fill(0)
		this.flow.fill(0)
		this.flux.fill(0)
		this.alive.fill(0)
		this.warm.clear()
		this.time = 0
		this.front = 0
		this.grown = 0

		// how far the slime has to crawl to reach every node (in doubles: heap
		// keys must match what is stored, or nodes get skipped as stale)
		const dist = new Float64Array(N).fill(Infinity)
		dist[this.start] = 0
		const heap = [[0, this.start]]
		const push = (item) => {
			heap.push(item)
			let i = heap.length - 1
			while (i > 0) {
				const p = (i - 1) >> 1
				if (heap[p][0] <= heap[i][0]) break
				;[heap[p], heap[i]] = [heap[i], heap[p]]
				i = p
			}
		}
		const pop = () => {
			const top = heap[0]
			const last = heap.pop()
			if (heap.length) {
				heap[0] = last
				let i = 0
				for (;;) {
					const l = 2 * i + 1, r = l + 1
					let m = i
					if (l < heap.length && heap[l][0] < heap[m][0]) m = l
					if (r < heap.length && heap[r][0] < heap[m][0]) m = r
					if (m === i) break
					;[heap[m], heap[i]] = [heap[i], heap[m]]
					i = m
				}
			}
			return top
		}
		while (heap.length) {
			const [d, i] = pop()
			if (d > dist[i]) continue
			for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
				const e = this.adjEdge[k]
				const j = this.a[e] === i ? this.b[e] : this.a[e]
				const nd = d + this.cost(e)
				if (nd < dist[j]) (dist[j] = nd), push([nd, j])
			}
		}
		this.arrival.set(dist)
		const order = Array.from({length: N}, (_, i) => i).sort((p, q) => dist[p] - dist[q])
		this.order.set(order)
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
		const dt = P.dt
		this.time += dt

		// the growing edge of the slime moves on
		this.front += P.growth * this.spacing * dt
		while (this.grown < this.nodeCount) {
			const i = this.order[this.grown]
			if (!(this.arrival[i] <= this.front)) break
			this.alive[i] = 1
			this.grown++
			for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
				const e = this.adjEdge[k]
				const j = this.a[e] === i ? this.b[e] : this.a[e]
				if (this.alive[j]) {
					this.D[e] = P.fresh
					this.born[e] = this.time
				}
			}
		}

		const reached = this.reachedFlakes()
		if (reached.length < 2) return

		// one flake pushes protoplasm in, the others take it
		const source = reached[Math.floor(this.rand() * reached.length)]
		const rhs = this.rhs.fill(0)
		const inflow = P.flow
		rhs[this.flakes[source].node] += inflow
		const sinks = reached.filter((i) => i !== source)
		for (const i of sinks) rhs[this.flakes[i].node] -= inflow / sinks.length

		const pressure = this.solve(this.flakes[source].node)

		// tubes grow with the flow through them and shrink without
		const {D, flow, weight, a, b} = this
		const mu = P.mu
		for (let e = 0, E = this.edgeCount; e < E; e++) {
			if (weight[e] === 0) continue
			const q = weight[e] * (pressure[a[e]] - pressure[b[e]])
			this.flux[e] = q
			const Q = Math.abs(q)
			flow[e] = Q
			const Qm = Q ** mu
			const grow = Qm / (1 + Qm)
			D[e] = Math.max(P.minD, D[e] + dt * (grow - P.decay * D[e]))
		}
	}

	// Kirchhoff on the living mesh: find the pressure at every node so that
	// what flows in equals what flows out. Conjugate gradients with a Jacobi
	// preconditioner, started from last time's answer for the same source.
	solve(sourceNode) {
		const {D, a, b, weight, diag, rhs, r, z, dir, q, alive} = this
		const N = this.nodeCount, E = this.edgeCount
		diag.fill(1e-9)
		for (let e = 0; e < E; e++) {
			if (alive[a[e]] && alive[b[e]]) {
				const w = D[e] / this.cost(e)
				weight[e] = w
				diag[a[e]] += w
				diag[b[e]] += w
			} else {
				weight[e] = 0
			}
		}
		let x = this.warm.get(sourceNode)
		if (!x) this.warm.set(sourceNode, (x = new Float64Array(N)))

		const multiply = (v, out) => {
			for (let i = 0; i < N; i++) out[i] = diag[i] * v[i]
			for (let e = 0; e < E; e++) {
				const w = weight[e]
				if (w === 0) continue
				const p = a[e], s = b[e]
				out[p] -= w * v[s]
				out[s] -= w * v[p]
			}
		}

		multiply(x, q)
		let bb = 0
		for (let i = 0; i < N; i++) {
			r[i] = rhs[i] - q[i]
			bb += rhs[i] * rhs[i]
		}
		let rz = 0
		for (let i = 0; i < N; i++) {
			z[i] = r[i] / diag[i]
			dir[i] = z[i]
			rz += r[i] * z[i]
		}
		const tol = this.params.tolerance ** 2 * bb
		let it = 0
		for (; it < this.params.maxIterations; it++) {
			let rr = 0
			for (let i = 0; i < N; i++) rr += r[i] * r[i]
			if (rr <= tol) break
			multiply(dir, q)
			let pq = 0
			for (let i = 0; i < N; i++) pq += dir[i] * q[i]
			if (pq <= 0) break
			const alpha = rz / pq
			let rzNew = 0
			for (let i = 0; i < N; i++) {
				x[i] += alpha * dir[i]
				r[i] -= alpha * q[i]
				z[i] = r[i] / diag[i]
				rzNew += r[i] * z[i]
			}
			const beta = rzNew / rz
			rz = rzNew
			for (let i = 0; i < N; i++) dir[i] = z[i] + beta * dir[i]
		}
		this.solverIterations = it
		return x
	}
}

SlimeNetwork.DEFAULTS = {
	dt: 0.05,
	mu: 1.8, // above 1, tubes compete for the flow
	flow: 2, // protoplasm pushed through per step
	decay: 1,
	minD: 1e-4,
	fresh: 0.4, // conductivity of a tube the slime has just grown
	growth: 1.5, // mesh spacings the growing edge covers per unit time
	parkCost: 1.5, // parkland makes a tube this much longer, relatively
	lightCost: 12,
	tolerance: 1e-4,
	maxIterations: 400,
}

if (typeof module !== 'undefined') module.exports = SlimeNetwork
