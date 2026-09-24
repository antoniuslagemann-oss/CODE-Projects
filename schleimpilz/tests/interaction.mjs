// Drives the dish the way a person would, with the mouse, the keyboard and
// touch, and checks what they would see: the HUD, the lab log, the hint, the
// tooltip, the controls, the view. It also probes for bugs found by reading
// app.js, so a failing check can mean a known bug that isn't fixed yet; the
// summary at the end says which. WebGL2 runs in software (SwiftShader), as
// in tests/smoke.mjs.
//
//   node tests/interaction.mjs
//   CHROMIUM_ARGS="--ignore-certificate-errors-spki-list=..." node tests/interaction.mjs
//   QA_ONLY=flakes,zoom node tests/interaction.mjs      some areas only
//   QA_STUBS=render,metrics node tests/interaction.mjs  use the stand-ins
//
// When render.js or metrics.js is missing, stand-ins are served instead: a
// DishRenderer without WebGL that keeps a real light grid, and a
// NetworkMetrics.compare that returns sample results. Screenshots and
// results.json go to tests/output/qa/.

import {createServer} from 'node:http'
import {existsSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {extname, join, normalize} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'output', 'qa')
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}
const list = (s) => new Set((s || '').split(',').map((x) => x.trim()).filter(Boolean))
const ONLY = list(process.env.QA_ONLY)
const FORCE = list(process.env.QA_STUBS)
const STUB = {
	'render.js': FORCE.has('render') || !existsSync(join(ROOT, 'render.js')),
	'metrics.js': FORCE.has('metrics') || !existsSync(join(ROOT, 'metrics.js')),
}
const DESKTOP = {width: 1440, height: 900}
const PHONE = {width: 390, height: 844}
const FONTS = /fonts\.(googleapis|gstatic)\.com/

// --- Stand-ins ----------------------------------------------------------------

const STUB_RENDER = String.raw`'use strict'
// Stand-in for render.js, served by tests/interaction.mjs: no WebGL, a plain
// 2D picture, and a real light grid so that light painting can be checked.
class DishRenderer {
	constructor(canvas, {width = 1024, height = 1024} = {}) {
		this.canvas = canvas
		this.width = width
		this.height = height
		this.light = new Float32Array(width * height)
		this.palette = {dark: false}
		this.ctx = canvas.getContext('2d')
		this.renders = 0
		this.stub = true
	}
	setGround(city, extent) {
		this.city = city
		this.extent = extent
	}
	setMesh(net) {
		this.net = net
	}
	update(net) {
		this.net = net
	}
	setPalette(p) {
		this.palette = p || {}
	}
	render(seconds = 0, {still = false, view = null} = {}) {
		this.renders++
		this.lastView = view && {...view}
		const c = this.ctx, w = this.canvas.width, h = this.canvas.height
		const v = view || {x: this.width / 2, y: this.height / 2, zoom: 1}
		const s = Math.min(w / this.width, h / this.height) * v.zoom
		c.setTransform(1, 0, 0, 1, 0, 0)
		c.fillStyle = this.palette.dark ? '#0d100a' : '#dde2d4'
		c.fillRect(0, 0, w, h)
		c.setTransform(s, 0, 0, s, w / 2 - v.x * s, h / 2 - v.y * s)
		c.beginPath()
		c.arc(this.width / 2, this.height / 2, this.width / 2, 0, 2 * Math.PI)
		c.fillStyle = this.palette.dark ? '#171b11' : '#e4e5d7'
		c.fill()
	}
	paintLight(cx, cy, radius, amount) {
		const w = this.width, h = this.height
		const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(w - 1, Math.ceil(cx + radius))
		const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(h - 1, Math.ceil(cy + radius))
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius
				if (d >= 1) continue
				const k = y * w + x
				this.light[k] = Math.max(0, Math.min(1, this.light[k] + amount * (1 - d * d)))
			}
		}
	}
	clearLight() {
		this.light.fill(0)
	}
	lightAt(x, y) {
		const ix = Math.min(this.width - 1, Math.max(0, Math.floor(x)))
		const iy = Math.min(this.height - 1, Math.max(0, Math.floor(y)))
		return this.light[iy * this.width + ix]
	}
}
`

const STUB_METRICS = String.raw`'use strict'
// Stand-in for metrics.js, served by tests/interaction.mjs.
const NetworkMetrics = {
	stub: true,
	compare({flakes, edges}) {
		const alive = flakes.filter((f) => f.alive).length
		return {
			slime: {cost: 1.72, detour: 0.21, tolerance: 0.83},
			rail: {cost: 1.8, detour: 0.25, tolerance: 0.9},
			overlap: {railBuilt: 0.42, slimeOnRail: 0.55},
			railCoverage: edges.map((_, i) => (i % 3 ? 1 : 0)),
			foot: 'A sample result from the test stand-in, over ' + alive + ' flakes.',
		}
	},
}
`

// --- Results --------------------------------------------------------------------

const results = []
let area = 'setup'
let problems = [] // console and page errors in the current area

function check(name, ok, detail = '') {
	ok = !!ok
	results.push({area, name, ok, detail: ok ? '' : String(detail)})
	const more = ok || detail === '' ? '' : '\n         ' + String(detail).split('\n').join('\n         ')
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${more}`)
	return ok
}

const near = (a, b, tol) => Math.abs(a - b) <= tol
const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : JSON.stringify(v))

// --- Server and browser ---------------------------------------------------------

const server = createServer(async (req, res) => {
	const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
	try {
		const body = await readFile(join(ROOT, path || 'index.html'))
		res.writeHead(200, {'content-type': TYPES[extname(path)] || 'application/octet-stream'})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const BASE = `http://127.0.0.1:${server.address().port}/`

await mkdir(OUT, {recursive: true})
const browser = await chromium.launch({
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean)],
})
const contexts = []

function watch(page) {
	page.on('console', (m) => {
		const text = m.text()
		if (/GPU stall due to ReadPixels/.test(text)) return // the driver grumbling about a readback
		if (FONTS.test(m.location().url || '') || FONTS.test(text)) return // Google Fonts out of reach
		if (m.type() === 'error' || /GL_INVALID|WebGL:/.test(text)) problems.push(`console ${m.type()}: ${text}`)
	})
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
	page.on('requestfailed', (r) => {
		if (!FONTS.test(r.url())) problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`)
	})
}

// A fresh page in its own context. query '?manual': the test steps the model.
async function open({viewport = DESKTOP, deviceScaleFactor = 1, hasTouch = false, query = '?manual'} = {}) {
	const context = await browser.newContext({viewport, deviceScaleFactor, hasTouch})
	contexts.push(context)
	for (const [file, body] of [['render.js', STUB_RENDER], ['metrics.js', STUB_METRICS]]) {
		if (STUB[file]) await context.route('**/' + file, (r) => r.fulfill({contentType: 'text/javascript', body}))
	}
	await context.addInitScript(() => {
		// errors that reach window.onerror without being uncaught exceptions (ResizeObserver loops)
		window.__qaErrors = []
		addEventListener('error', (e) => window.__qaErrors.push(String(e.message || e.error)))
	})
	const page = await context.newPage()
	watch(page)
	await page.goto(BASE + 'index.html' + query)
	await page.waitForFunction(() => window.schleimpilz || !document.getElementById('error').hidden, null, {timeout: 60000})
	const error = await page.evaluate(() => (document.getElementById('error').hidden ? null : document.getElementById('error').textContent))
	if (error) throw new Error(`the page shows an error: ${error}`)
	await instrument(page)
	return page
}

// Watches the renderer (no behaviour changes) and adds helpers for the test.
async function instrument(page) {
	await page.evaluate(() => {
		const S = window.schleimpilz
		const PX = 1024 / BERLIN.km[0]
		const qa = (window.__qa = {PX, paints: [], palettes: []})
		const r = S.renderer
		const paint = r.paintLight.bind(r), palette = r.setPalette.bind(r)
		r.paintLight = (...a) => (qa.paints.push(a), paint(...a))
		r.setPalette = (p) => (qa.palettes.push(!!(p && p.dark)), palette(p))
		const view = () => S.view || {x: 512, y: 512, zoom: 1}
		const box = () => document.getElementById('overlay').getBoundingClientRect()
		qa.view = () => ({...view()})
		qa.scale = () => (box().width / 1024) * view().zoom // css px per map px
		qa.toClient = (x, y) => {
			const b = box(), v = view(), s = (b.width / 1024) * v.zoom
			return [b.left + (x - v.x) * s + b.width / 2, b.top + (y - v.y) * s + b.height / 2]
		}
		qa.fromClient = (cx, cy) => {
			const b = box(), v = view(), s = (b.width / 1024) * v.zoom
			return [(cx - b.left - b.width / 2) / s + v.x, (cy - b.top - b.height / 2) / s + v.y]
		}
		qa.flakes = () => S.state.flakes.map((f, i) => ({i, name: f.name, x: f.x, y: f.y, kind: f.kind, alive: f.alive, reached: S.state.reached.has(i)}))
		qa.alive = () => qa.flakes().filter((f) => f.alive)
		qa.log = () =>
			[...document.querySelectorAll('#journal li')].map((li) => ({
				time: li.children[0]?.textContent || '',
				text: li.children[1]?.textContent || '',
				far: li.children[2]?.textContent || '',
				you: !!li.children[1]?.classList.contains('you'),
			}))
		const stations = BERLIN.stations.map(([name, u, v]) => ({name, x: u * 1024, y: v * 1024}))
		qa.stations = stations
		qa.nearestStation = (x, y) => {
			let best = null, d = Infinity
			for (const s of stations) {
				const k = Math.hypot(s.x - x, s.y - y)
				if (k < d) (best = s), (d = k)
			}
			return {name: best.name, km: d / PX}
		}
		qa.nodeKm = (x, y) => {
			const n = S.net, i = n.nearestNode(x, y)
			return i < 0 ? Infinity : Math.hypot(n.x[i] - x, n.y[i] - y) / PX
		}
		// empty city: stations on the mesh, away from every flake and from each other
		qa.emptyCity = (count, {minKm = 1.3, maxR = 430, from = null, minFrom = 0, maxFrom = Infinity, far = false, avoid = []} = {}) => {
			const taken = qa.alive().map((f) => [f.x, f.y]).concat(avoid)
			let cand = stations.filter((s) => Math.hypot(s.x - 512, s.y - 512) < maxR && qa.nodeKm(s.x, s.y) < 0.25)
			if (from) {
				const d = (s) => Math.hypot(s.x - from[0], s.y - from[1]) / PX
				cand = cand.filter((s) => d(s) >= minFrom && d(s) <= maxFrom).sort((a, b) => (far ? d(b) - d(a) : d(a) - d(b)))
			}
			const out = []
			for (const s of cand) {
				if (out.length >= count) break
				const all = taken.concat(out.map((o) => [o.x, o.y]))
				if (all.some(([x, y]) => Math.hypot(x - s.x, y - s.y) / PX < minKm)) continue
				out.push({name: s.name, x: s.x, y: s.y})
			}
			return out
		}
		// lit agar inside the dish: far from every node of the mesh
		qa.outsidePoint = () => {
			for (let r = 440; r >= 200; r -= 20) {
				for (let a = 0; a < 360; a += 4) {
					const x = 512 + r * Math.cos((a * Math.PI) / 180), y = 512 + r * Math.sin((a * Math.PI) / 180)
					if (qa.nodeKm(x, y) > 1.4) return [x, y]
				}
			}
			return null
		}
		// a point on the glass wall of the dish (render.js: inner radius 0.984 R), close to the mesh
		qa.rimPoint = () => {
			const n = S.net
			let best = -1, br = 0
			for (let i = 0; i < n.nodeCount; i++) {
				const r = Math.hypot(n.x[i] - 512, n.y[i] - 512)
				if (r > br) (br = r), (best = i)
			}
			const r = Math.min(511, br + 0.5 * PX)
			const ux = (n.x[best] - 512) / br, uy = (n.y[best] - 512) / br
			return {x: 512 + ux * r, y: 512 + uy * r, r, nodeR: br, inner: 512 * 0.984}
		}
		// light on the tubes of the mesh along a stroke from a to b (map px)
		qa.lightStats = (ax, ay, bx, by) => {
			const n = S.net
			const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy
			const km = (px, py) => {
				const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0
				return Math.hypot(px - ax - t * dx, py - ay - t * dy) / PX
			}
			let sum = 0, count = 0, farMax = 0, max = 0
			for (let e = 0; e < n.edgeCount; e++) {
				const mx = (n.x[n.a[e]] + n.x[n.b[e]]) / 2, my = (n.y[n.a[e]] + n.y[n.b[e]]) / 2
				const l = n.light[e]
				if (l > max) max = l
				const d = km(mx, my)
				if (d < 0.4) (sum += l), count++
				else if (d > 2.5 && l > farMax) farMax = l
			}
			return {near: count ? sum / count : NaN, edges: count, farMax, max}
		}
		qa.maxLight = () => S.net.light.reduce((m, v) => (v > m ? v : m), 0)
		qa.overlayPixels = () => document.getElementById('overlay').toDataURL()
	})
}

const frames = (page, n = 2) =>
	page.evaluate(
		(n) =>
			new Promise((ok) => {
				const f = () => (--n <= 0 ? ok() : requestAnimationFrame(f))
				requestAnimationFrame(f)
			}),
		n,
	)
// app.js looks at what the slime reached, and updates the HUD, every 12 frames
const settle = (page) => frames(page, 14)
const qa = (page, fn, arg) => page.evaluate(fn, arg)
const text = (page, sel) => page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, sel)
const hud = (page) => text(page, '#hud-reached')
const log = (page) => qa(page, () => window.__qa.log())
const view = (page) => qa(page, () => window.__qa.view())
const blur = (page) => page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur())
const toClient = (page, x, y) => qa(page, ([x, y]) => window.__qa.toClient(x, y), [x, y])
const fromClient = (page, x, y) => qa(page, ([x, y]) => window.__qa.fromClient(x, y), [x, y])
const hidden = (page, sel) => page.evaluate((sel) => document.querySelector(sel).hidden, sel)

async function waitFor(page, fn, arg, timeout = 5000) {
	try {
		await page.waitForFunction(fn, arg, {timeout})
		return true
	} catch {
		return false
	}
}
const waitHud = (page, want, timeout = 5000) => waitFor(page, (want) => document.getElementById('hud-reached').textContent === want, want, timeout)

// click a map point with the mouse (down and up without moving)
async function clickMap(page, x, y) {
	const [cx, cy] = await toClient(page, x, y)
	await page.mouse.click(cx, cy)
	return [cx, cy]
}

// a stroke with the mouse from map point a to map point b
async function stroke(page, a, b, steps = 24) {
	const [ax, ay] = await toClient(page, ...a)
	const [bx, by] = await toClient(page, ...b)
	await page.mouse.move(ax, ay)
	await page.mouse.down()
	await page.mouse.move(bx, by, {steps})
	await page.mouse.up()
}

async function stepUntil(page, cond, {chunk = 50, max = 600} = {}) {
	let done = 0
	while (done < max) {
		await page.evaluate((n) => window.schleimpilz.step(n), chunk)
		done += chunk
		if (await page.evaluate(cond)) break
	}
	return done
}

// back to the start: whole dish, oat flake tool, busiest stations, names on, rail off
async function reset(page) {
	await page.mouse.move(2, 2)
	await blur(page)
	await page.keyboard.press('0')
	await page.keyboard.press('1')
	if (!(await page.isChecked('#setup-hubs'))) await page.click('label:has(#setup-hubs)')
	if (await page.isChecked('#show-rail')) await page.click('label.switch:has(#show-rail)')
	if (!(await page.isChecked('#show-names'))) await page.click('label.switch:has(#show-names)')
	await page.click('#restart')
	await blur(page)
	await page.evaluate(() => (window.__qa.paints.length = 0))
	await settle(page)
}

// closes a page of its own, keeping its window errors for the area
async function done(p) {
	const errs = await p.evaluate(() => (window.__qaErrors || []).splice(0)).catch(() => [])
	problems.push(...errs.map((e) => `window error: ${e}`))
	await p.context().close()
}

async function section(name, pages, fn) {
	if (ONLY.size && !ONLY.has(name)) return
	area = name
	problems = []
	const t0 = Date.now()
	console.log(`\n${name}`)
	try {
		await fn()
	} catch (err) {
		check('ran to the end', false, err.stack || err.message)
	}
	for (const p of pages()) {
		if (p.isClosed()) continue
		const errs = await p.evaluate(() => (window.__qaErrors || []).splice(0)).catch(() => [])
		problems.push(...errs.map((e) => `window error: ${e}`))
	}
	check('no console or page errors', problems.length === 0, [...new Set(problems)].join('\n'))
	console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
}

// --- The areas ------------------------------------------------------------------

const HINT_FOOD = 'Click the dish to put down an oat flake. Click a flake to take it away.'
const HINT_LIGHT = 'Drag across the dish to shine light on it. The slime keeps away, and tubes in the light wither.'
const HINT_ERASE = 'Drag across the dish to switch the light off again.'
const HINT_OUTSIDE = 'The slime only grows inside the city. Put the oat flake somewhere in Berlin.'
const HINT_FULL = 'The dish is full. Take a flake away first.'
const START_NOTE = 'Put down on CODE University in Neukölln'

console.log(`stand-ins: ${Object.entries(STUB).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none, the real render.js and metrics.js'}`)

let page = null
const main = () => (page ? [page] : [])

try {
	await section('load', main, async () => {
		problems = []
		page = await open()
		check('title is "Schleimpilz"', (await page.title()) === 'Schleimpilz', await page.title())
		check('no error box on the dish', await hidden(page, '#error'))
		check('HUD shows "1 of 38 oat flakes"', (await hud(page)) === '1 of 38 oat flakes', await hud(page))
		const entries = await log(page)
		check('the lab log has one entry', entries.length === 1, JSON.stringify(entries))
		check('its first entry is the inoculation at CODE', entries.at(-1)?.text === START_NOTE && entries.at(-1)?.time === '0:00', JSON.stringify(entries.at(-1)))
		check('the hint is the oat flake one', (await text(page, '#hint')) === HINT_FOOD, await text(page, '#hint'))
		check('Pause button says "Pause"', (await text(page, '#play')) === 'Pause')
		check('rail legend rows are hidden', await page.evaluate(() => [...document.querySelectorAll('.rail-key')].every((li) => li.hidden)))
		check('"Whole dish" button is hidden at zoom 1', await hidden(page, '#fit'))
		await page.screenshot({path: join(OUT, 'load.png')})
	})
	if (!page) throw new Error('the page did not load')

	await section('tooltip', main, async () => {
		await reset(page)
		const flakes = await qa(page, () => window.__qa.alive())
		const code = flakes.find((f) => f.kind === 'code')
		const [cx, cy] = await toClient(page, code.x, code.y)
		await page.mouse.move(cx, cy)
		check('hovering CODE shows its tooltip', !(await hidden(page, '#tip')))
		check('it names CODE and says the slime started there', (await text(page, '#tip')) === 'CODE University · the slime started here', await text(page, '#tip'))
		const at = await page.evaluate(() => {
			const t = document.getElementById('tip'), d = document.getElementById('dish').getBoundingClientRect()
			return [d.left + parseFloat(t.style.left), d.top + parseFloat(t.style.top)]
		})
		check('the tooltip is anchored on the flake', near(at[0], cx, 1.5) && near(at[1], cy, 1.5), `${fmt(at)} vs ${fmt([cx, cy])}`)
		const far = flakes.filter((f) => f.kind === 'station').sort((a, b) => Math.hypot(b.x - code.x, b.y - code.y) - Math.hypot(a.x - code.x, a.y - code.y))[0]
		await page.mouse.move(...(await toClient(page, far.x, far.y)))
		check(`hovering ${far.name} says "not reached yet"`, (await text(page, '#tip')) === `${far.name} · not reached yet`, await text(page, '#tip'))
		await page.mouse.move(...(await toClient(page, 20, 20)))
		check('hovering the bench hides the tooltip', await hidden(page, '#tip'))
		await page.mouse.move(...(await toClient(page, far.x, far.y)))
		await page.mouse.move(2, 2)
		check('leaving the dish hides the tooltip', await hidden(page, '#tip'))
	})

	await section('growth', main, async () => {
		await reset(page)
		const before = await hud(page)
		const t0 = Date.now()
		const steps = await stepUntil(page, () => window.schleimpilz.state.reached.size >= 5, {chunk: 50, max: 700})
		const after = await hud(page)
		const reached = Number(after.split(' ')[0])
		console.log(`  ${steps} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${after}`)
		check('the HUD count rises as the slime grows', reached > 1 && after.endsWith('of 38 oat flakes'), `${before} -> ${after}`)
		const [mm, ss] = (await text(page, '#hud-clock')).split(':').map(Number)
		check('the HUD clock runs with the model (60 steps a second)', Math.abs(mm * 60 + ss - steps / 60) <= 1, `${await text(page, '#hud-clock')} after ${steps} steps`)
		const entries = await log(page)
		const reachedNotes = entries.filter((e) => e.text.startsWith('Reached '))
		check('every newly reached flake adds a "Reached …" entry', reachedNotes.length === reached - 1, `${reachedNotes.length} entries for ${reached - 1} flakes (CODE excluded)`)
		check('each "Reached …" entry has a distance in km', reachedNotes.every((e) => /^\d+\.\d km$/.test(e.far)), JSON.stringify(reachedNotes))
		const names = reachedNotes.map((e) => e.text)
		check('no flake is logged twice', new Set(names).size === names.length, names.join(', '))
		const want = await qa(page, () => {
			const f = window.__qa.flakes(), c = f[0]
			return f.filter((x) => x.reached && x.kind !== 'code').map((x) => ({text: `Reached ${x.name}`, km: Math.hypot(x.x - c.x, x.y - c.y) / window.__qa.PX}))
		})
		const wrong = want.filter((w) => {
			const e = reachedNotes.find((n) => n.text === w.text)
			return !e || !near(parseFloat(e.far), w.km, 0.051)
		})
		check('the km is the straight line from CODE', wrong.length === 0, JSON.stringify(wrong))
		check('the inoculation is still the oldest entry', entries.at(-1)?.text === START_NOTE, entries.at(-1)?.text)
		// a reached flake says so in its tooltip
		const r = (await qa(page, () => window.__qa.alive())).find((f) => f.reached && f.kind === 'station')
		if (r) {
			await page.mouse.move(...(await toClient(page, r.x, r.y)))
			check(`hovering ${r.name} says "reached"`, (await text(page, '#tip')) === `${r.name} · reached`, await text(page, '#tip'))
			await page.mouse.move(2, 2)
		}
		// more steps: nothing logged twice
		await page.evaluate(() => window.schleimpilz.step(60))
		await settle(page)
		const again = (await log(page)).filter((e) => e.text.startsWith('Reached ')).map((e) => e.text)
		check('stepping on logs no duplicates', new Set(again).size === again.length, again.join(', '))
		const verdict = await page.evaluate(() => ({metrics: document.querySelectorAll('#verdict .metric').length, wait: !!document.querySelector('#verdict .verdict-wait')}))
		check('the verdict shows measures or the waiting note', verdict.metrics > 0 || verdict.wait, JSON.stringify(verdict))
		console.log(`  verdict: ${verdict.metrics} measures${verdict.wait ? ', waiting' : ''}`)
		await page.locator('#dish').screenshot({path: join(OUT, 'growth.png')})

		// a reached flake taken away, and a new one put down in its slot far from the slime
		const gone = (await qa(page, () => window.__qa.alive())).find((f) => f.reached && f.kind === 'station')
		const count0 = Number((await hud(page)).split(' ')[0])
		await clickMap(page, gone.x, gone.y)
		await settle(page)
		check('taking away a reached flake lowers both counts', (await hud(page)) === `${count0 - 1} of 37 oat flakes`, await hud(page))
		const start = (await qa(page, () => window.__qa.flakes()))[0]
		const [spot] = await qa(page, (c) => window.__qa.emptyCity(1, {from: c, far: true, minKm: 2}), [start.x, start.y])
		await clickMap(page, spot.x, spot.y)
		await settle(page)
		const slot = await qa(page, (i) => window.__qa.flakes()[i], gone.i)
		check('the new flake reuses the free slot', slot.kind === 'yours' && slot.alive, JSON.stringify(slot))
		check('…and does not inherit "reached" from the old one', !slot.reached && (await hud(page)) === `${count0 - 1} of 38 oat flakes`, `${JSON.stringify(slot)} HUD ${await hud(page)}`)
		await page.mouse.move(...(await toClient(page, slot.x, slot.y)))
		check('…its tooltip says "not reached yet"', (await text(page, '#tip')) === `${slot.name} · not reached yet`, await text(page, '#tip'))
		await page.mouse.move(2, 2)
	})

	await section('flakes', main, async () => {
		await reset(page)
		const n0 = (await qa(page, () => window.__qa.alive())).length
		const [spot] = await qa(page, () => window.__qa.emptyCity(1, {minKm: 1.6}))
		const [cx, cy] = await clickMap(page, spot.x, spot.y)
		await settle(page)
		const placed = (await qa(page, () => window.__qa.alive())).find((f) => f.kind === 'yours')
		const entries = await log(page)
		check('clicking empty city puts down a flake (HUD +1)', (await hud(page)) === `1 of ${n0 + 1} oat flakes`, await hud(page))
		check('…where the click was', placed && near(placed.x, spot.x, 1) && near(placed.y, spot.y, 1), JSON.stringify(placed))
		const nearName = placed && (await qa(page, ([x, y]) => window.__qa.nearestStation(x, y).name, [placed.x, placed.y]))
		check(`…and logs "You put down an oat flake near ${nearName}"`, entries[0]?.text === `You put down an oat flake near ${nearName}` && entries[0]?.you, JSON.stringify(entries[0]))

		// take it away again, with the tooltip showing (as it is after hovering)
		await page.mouse.move(cx + 1, cy)
		await page.mouse.move(cx, cy)
		check('hovering your flake shows its tooltip', (await text(page, '#tip')) === `near ${nearName} · not reached yet`, await text(page, '#tip'))
		await page.mouse.down()
		await page.mouse.up()
		await settle(page)
		check('clicking a flake takes it away (HUD −1)', (await hud(page)) === `1 of ${n0} oat flakes`, await hud(page))
		const took = (await log(page))[0]
		check('…and logs that you took it away', took?.text.startsWith('You took away the oat flake') && took?.you, JSON.stringify(took))
		check('BUG copy: the log reads naturally for your own flake (no "at near …")', !/ at near /.test(took?.text || ''), took?.text)
		check('BUG stale tooltip: the tooltip goes once the flake under it is taken away', (await hidden(page, '#tip')) || !(await text(page, '#tip')).includes(nearName), `tooltip still says "${await text(page, '#tip')}"`)
		await page.mouse.move(2, 2)

		// outside Berlin: the lit agar inside the dish, and the bench in the corner
		const lit = await qa(page, () => window.__qa.outsidePoint())
		check('found lit agar inside the dish to click', !!lit)
		for (const [what, pt] of [['the lit agar inside the dish', lit], ['the bench in the corner', [12, 12]]]) {
			if (!pt) continue
			const hudBefore = await hud(page), logBefore = (await log(page)).length, nBefore = (await qa(page, () => window.__qa.flakes())).length
			await clickMap(page, ...pt)
			await settle(page)
			check(`clicking ${what} is refused with a hint`, (await text(page, '#hint')) === HINT_OUTSIDE, await text(page, '#hint'))
			check(`…and changes nothing`, (await hud(page)) === hudBefore && (await log(page)).length === logBefore && (await qa(page, () => window.__qa.flakes())).length === nBefore, `${await hud(page)}, ${(await log(page)).length} log entries`)
		}
		await page.waitForTimeout(3200)
		check('the hint comes back after 3 s', (await text(page, '#hint')) === HINT_FOOD, await text(page, '#hint'))

		// the glass wall of the dish is not agar
		const rim = await qa(page, () => window.__qa.rimPoint())
		const nRim = (await qa(page, () => window.__qa.alive())).length
		await clickMap(page, rim.x, rim.y)
		await settle(page)
		const onGlass = (await qa(page, () => window.__qa.alive())).length > nRim
		check(`BUG rim: a click on the glass wall (r ${fmt(rim.r, 1)} px, glass from ${fmt(rim.inner, 1)}) puts down no flake`, !onGlass, 'a flake was put down on the glass')
		if (onGlass) await clickMap(page, rim.x, rim.y)

		// your own flake far from any station
		const lone = await qa(page, () => {
			const q = window.__qa
			for (let y = 60; y < 964; y += 6) {
				for (let x = 60; x < 964; x += 6) {
					if (Math.hypot(x - 512, y - 512) > 440 || q.nodeKm(x, y) > 0.2 || q.nearestStation(x, y).km < 1.7) continue
					if (q.alive().some((f) => Math.hypot(f.x - x, f.y - y) / q.PX < 1.5)) continue
					return [x, y]
				}
			}
			return null
		})
		if (lone) {
			await clickMap(page, ...lone)
			await settle(page)
			check('far from stations: "You put down an oat flake"', (await log(page))[0]?.text === 'You put down an oat flake', (await log(page))[0]?.text)
			await clickMap(page, ...lone)
			await settle(page)
			const t = (await log(page))[0]?.text
			check('BUG copy: taking it away reads naturally (no "at Your oat flake")', !/at Your oat flake/.test(t), t)
		}
	})

	await section('limit', main, async () => {
		await reset(page)
		const n0 = (await qa(page, () => window.__qa.alive())).length
		const spots = await qa(page, (n) => window.__qa.emptyCity(n, {minKm: 1.3}), 64 - n0 + 1)
		check(`found ${64 - n0 + 1} empty spots in the city`, spots.length === 64 - n0 + 1, spots.length)
		for (const s of spots.slice(0, -1)) await clickMap(page, s.x, s.y)
		await settle(page)
		check('the dish takes flakes up to 64', (await hud(page)) === '1 of 64 oat flakes', await hud(page))
		const logBefore = (await log(page)).length
		const last = spots.at(-1)
		await clickMap(page, last.x, last.y)
		await settle(page)
		check('the 65th is refused: "The dish is full…"', (await text(page, '#hint')) === HINT_FULL, await text(page, '#hint'))
		check('…and nothing changes', (await hud(page)) === '1 of 64 oat flakes' && (await log(page)).length === logBefore, `${await hud(page)}, ${(await log(page)).length - logBefore} new entries`)
		await page.locator('#dish').screenshot({path: join(OUT, 'flakes-64.png')})
		const mine = spots[3]
		await clickMap(page, mine.x, mine.y)
		await settle(page)
		await clickMap(page, last.x, last.y)
		await settle(page)
		const all = await qa(page, () => window.__qa.flakes())
		check('after taking one away, another fits in its slot', (await hud(page)) === '1 of 64 oat flakes' && all.length === 64, `${await hud(page)}, ${all.length} slots`)
	})

	await section('light', main, async () => {
		await reset(page)
		const a = await qa(page, () => window.__qa.stations.find((s) => s.name === 'Alexanderplatz'))
		const b = await qa(page, () => window.__qa.stations.find((s) => s.name === 'Ostkreuz'))
		const A = [a.x, a.y], B = [b.x, b.y]
		await page.keyboard.press('2')
		check('key 2 picks the Light tool', (await page.isChecked('#tool-light')) && (await text(page, '#hint')) === HINT_LIGHT, await text(page, '#hint'))
		await stroke(page, A, B)
		await settle(page)
		const paints = await qa(page, () => window.__qa.paints.splice(0))
		check('dragging paints light (renderer.paintLight)', paints.length > 5, `${paints.length} calls`)
		check('…with the light amount and a 1 km brush', paints.every((p) => p[3] > 0 && near(p[2], 1024 / 50.71, 0.01)), JSON.stringify(paints.slice(0, 2)))
		check('…starting and ending under the pointer', paints.length > 0 && near(paints[0][0], A[0], 1) && near(paints[0][1], A[1], 1) && near(paints.at(-1)[0], B[0], 1) && near(paints.at(-1)[1], B[1], 1), `${fmt(paints[0]?.slice(0, 2))} … ${fmt(paints.at(-1)?.slice(0, 2))} for ${fmt(A)} … ${fmt(B)}`)
		let s = await qa(page, ([a, b]) => window.__qa.lightStats(a[0], a[1], b[0], b[1]), [A, B])
		check('net.light rises on the tubes under the stroke', s.near > 0.3 && s.edges > 20, JSON.stringify(s))
		check('…and nowhere far from it', s.farMax === 0, JSON.stringify(s))
		const shone = (await log(page))[0]
		check('the log says "You shone a light near …"', /^You shone a light near .+/.test(shone?.text) && shone?.you, shone?.text)
		await page.locator('#dish').screenshot({path: join(OUT, 'light.png')})

		// the Dark tool takes it away
		await page.keyboard.press('3')
		check('key 3 picks the Dark tool', (await page.isChecked('#tool-erase')) && (await text(page, '#hint')) === HINT_ERASE, await text(page, '#hint'))
		await stroke(page, A, B)
		await settle(page)
		const dark = await qa(page, () => window.__qa.paints.splice(0))
		check('the Dark tool paints with a negative amount', dark.length > 0 && dark.every((p) => p[3] < 0), JSON.stringify(dark.slice(0, 1)))
		s = await qa(page, ([a, b]) => window.__qa.lightStats(a[0], a[1], b[0], b[1]), [A, B])
		check('…and removes the light from the tubes', s.near < 0.01 && s.max < 0.05, JSON.stringify(s))
		check('the log says "You switched the light off near …"', /^You switched the light off( near .+)?$/.test((await log(page))[0]?.text), (await log(page))[0]?.text)

		// a stroke that leaves the dish and comes back keeps painting; released outside, it ends
		await page.keyboard.press('2')
		const [bx, by] = await toClient(page, ...B)
		const offDish = Math.min(DESKTOP.width - 2, bx + 600)
		await page.mouse.move(bx, by)
		await page.mouse.down()
		await page.mouse.move(offDish, by, {steps: 6}) // off the dish, over the bench
		await page.mouse.move(bx - 40, by, {steps: 6}) // back on the dish
		await page.mouse.move(offDish, by, {steps: 3})
		await page.mouse.up() // outside the dish
		const outside = await qa(page, () => window.__qa.paints.splice(0))
		check('a stroke dragged off the dish and back keeps painting (pointer capture)', outside.some((p) => p[0] < b.x - 1) && outside.some((p) => p[0] > 1024), `${outside.length} calls`)
		await page.mouse.move(bx - 60, by + 30, {steps: 5})
		await page.mouse.move(bx - 120, by, {steps: 5})
		check('released outside the dish, hovering back paints nothing', (await qa(page, () => window.__qa.paints.length)) === 0, `${await qa(page, () => window.__qa.paints.length)} calls`)

		// switching tools in the middle of a stroke
		const [ax, ay] = await toClient(page, ...A)
		await page.mouse.move(ax, ay)
		await page.mouse.down()
		await page.mouse.move(ax + 30, ay, {steps: 3})
		await page.keyboard.press('1')
		await page.mouse.move(ax + 90, ay, {steps: 6})
		await page.mouse.up()
		const mixed = await qa(page, () => window.__qa.paints.splice(0))
		check('BUG mid-stroke: switching to the oat flake tool mid-stroke does not turn the light stroke into Dark', mixed.every((p) => p[3] > 0), `amounts ${[...new Set(mixed.map((p) => p[3]))].join(', ')}`)

		// Start over clears the light and puts the flakes back
		await page.keyboard.press('2')
		await stroke(page, A, B)
		await page.keyboard.press('1')
		await clickMap(page, ...(await qa(page, () => window.__qa.emptyCity(1))).map((p) => [p.x, p.y])[0])
		await settle(page)
		check('(light and an extra flake are down)', (await qa(page, () => window.__qa.maxLight())) > 0.3 && (await hud(page)) === '1 of 39 oat flakes', await hud(page))
		await page.click('#restart')
		await settle(page)
		const cleared = await qa(page, ([a, b]) => ({max: window.__qa.maxLight(), mid: window.schleimpilz.renderer.lightAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)}), [A, B])
		check('"Start over" clears the light (renderer and tubes)', cleared.max === 0 && cleared.mid === 0, JSON.stringify(cleared))
		check('…and puts the flakes back to the setup', (await hud(page)) === '1 of 38 oat flakes' && (await log(page)).length === 1, `${await hud(page)}, ${(await log(page)).length} log entries`)
	})

	await section('setups', main, async () => {
		await reset(page)
		await clickMap(page, ...(await qa(page, () => window.__qa.emptyCity(1))).map((p) => [p.x, p.y])[0])
		await page.evaluate(() => window.schleimpilz.step(80))
		await settle(page)
		const ring = await qa(page, () => BERLIN.ring.map((i) => BERLIN.stations[i][0]))
		const hubs = await qa(page, () => BERLIN.hubs.map((i) => BERLIN.stations[i][0]))
		for (const [id, label, want, names] of [
			['#setup-ring', 'Ringbahn', '1 of 28 oat flakes', ring],
			['#setup-none', 'Only CODE', '1 of 1 oat flake', []],
			['#setup-hubs', 'Busiest stations', '1 of 38 oat flakes', hubs],
		]) {
			await page.click(`label:has(${id})`)
			await settle(page)
			const got = await qa(page, () => window.__qa.alive().map((f) => f.name))
			check(`${label}: HUD "${want}"`, (await hud(page)) === want, await hud(page))
			check(`${label}: CODE and ${names.length} stations`, got[0] === 'CODE University' && JSON.stringify(got.slice(1)) === JSON.stringify(names), got.join(', '))
			const entries = await log(page)
			check(`${label}: the log starts over`, entries.length === 1 && entries[0].text === START_NOTE, JSON.stringify(entries))
			check(`${label}: the clock starts over`, (await text(page, '#hud-clock')) === '0:00', await text(page, '#hud-clock'))
			check(`${label}: the verdict waits again`, await page.evaluate(() => !!document.querySelector('#verdict .verdict-wait')))
			await page.evaluate(() => window.schleimpilz.step(40))
		}
		await page.click('#restart')
		await blur(page)
	})

	await section('controls', main, async () => {
		await reset(page)
		const running = () => page.evaluate(() => window.schleimpilz.state.running)
		await page.click('#play')
		check('Pause: the button says "Play" and the dish stops', (await text(page, '#play')) === 'Play' && !(await running()))
		await page.click('#play')
		check('Play: the button says "Pause" and the dish runs', (await text(page, '#play')) === 'Pause' && (await running()))

		await page.focus('#speed')
		await page.keyboard.press('End')
		const top = await page.evaluate(() => window.schleimpilz.state.speed)
		await page.keyboard.press('Home')
		const bottom = await page.evaluate(() => window.schleimpilz.state.speed)
		await page.keyboard.press('ArrowRight')
		await page.keyboard.press('ArrowRight')
		check('the Speed slider sets the speed (1…6)', top === 6 && bottom === 1 && (await page.evaluate(() => window.schleimpilz.state.speed)) === 3, `${top}, ${bottom}`)

		const pixels = () => qa(page, () => window.__qa.overlayPixels())
		const p0 = await pixels()
		await page.click('label.switch:has(#show-rail)')
		await settle(page)
		const rows = await page.evaluate(() => [...document.querySelectorAll('.rail-key')].map((li) => !li.hidden && li.offsetHeight > 0))
		check('"Real S-Bahn and U-Bahn" shows the rail legend rows', rows.length === 3 && rows.every(Boolean), JSON.stringify(rows))
		check('…and draws the network on the dish', (await page.evaluate(() => window.schleimpilz.state.showRail)) && (await pixels()) !== p0)
		await page.locator('#dish').screenshot({path: join(OUT, 'rail.png')})
		await page.click('label.switch:has(#show-rail)')
		await settle(page)
		check('…and switched off, hides them again', await page.evaluate(() => [...document.querySelectorAll('.rail-key')].every((li) => li.hidden)))
		check('…and the overlay is as before', (await pixels()) === p0)

		await page.click('label.switch:has(#show-names)')
		await settle(page)
		check('"Station names" off takes the names off the dish', !(await page.evaluate(() => window.schleimpilz.state.showNames)) && (await pixels()) !== p0)
		await page.click('label.switch:has(#show-names)')
		await settle(page)
		check('…and on puts them back', (await pixels()) === p0)

		// keys, with nothing focused
		await blur(page)
		await page.keyboard.press('Space')
		const r1 = await running()
		await page.keyboard.press('Space')
		check('Space pauses and plays', r1 === false && (await running()) === true && (await text(page, '#play')) === 'Pause')
		await page.keyboard.press('n')
		const n1 = await page.evaluate(() => [window.schleimpilz.state.showRail, !document.querySelector('.rail-key').hidden, document.getElementById('show-rail').checked])
		await page.keyboard.press('N')
		const n2 = await page.evaluate(() => window.schleimpilz.state.showRail)
		check('N shows and hides the real network', n1.every(Boolean) && n2 === false, JSON.stringify(n1))
		for (const [key, id, hint] of [['2', 'light', HINT_LIGHT], ['3', 'erase', HINT_ERASE], ['1', 'food', HINT_FOOD]]) {
			await page.keyboard.press(key)
			check(`key ${key} picks the ${id} tool`, (await page.isChecked('#tool-' + id)) && (await text(page, '#hint')) === hint && (await page.evaluate(() => window.schleimpilz.state.tool)) === id)
		}
		await clickMap(page, ...(await qa(page, () => window.__qa.emptyCity(1))).map((p) => [p.x, p.y])[0])
		await page.click('#play')
		await blur(page)
		await page.keyboard.press('r')
		await settle(page)
		check('R starts over (and plays)', (await hud(page)) === '1 of 38 oat flakes' && (await log(page)).length === 1 && (await running()), await hud(page))

		// Space on a focused control must act once
		await page.focus('#play')
		await page.keyboard.press('Space')
		check('Space on the focused Pause button toggles once', (await running()) === false && (await text(page, '#play')) === 'Play')
		await page.keyboard.press('Space')
		check('…and again once', (await running()) === true)
		await page.focus('#show-rail')
		await page.keyboard.press('Space')
		check('Space on a focused switch flips the switch, not the clock', (await page.isChecked('#show-rail')) && (await running()) === true)
		await page.keyboard.press('Space')
		await blur(page)
	})

	await section('lab', main, async () => {
		await reset(page)
		const defaults = await page.evaluate(() => ({...window.schleimpilz.net.params}))
		await page.click('#lab summary')
		check('Lab settings opens', await page.evaluate(() => document.getElementById('lab').open))
		const sliders = await page.evaluate(() => [...document.querySelectorAll('#sliders input[type=range]')].map((i) => ({id: i.id, min: Number(i.min), max: Number(i.max)})))
		check('it has the four sliders', JSON.stringify(sliders.map((s) => s.id)) === JSON.stringify(['p-mu', 'p-flow', 'p-decay', 'p-growth']), JSON.stringify(sliders))
		for (const s of sliders) {
			const key = s.id.slice(2)
			await page.focus('#' + s.id)
			await page.keyboard.press('End')
			const hi = await page.evaluate((k) => [window.schleimpilz.net.params[k], document.getElementById('o-' + k).textContent], key)
			await page.keyboard.press('Home')
			const lo = await page.evaluate((k) => window.schleimpilz.net.params[k], key)
			check(`the ${key} slider sets net.params.${key} (${s.min}…${s.max})`, near(hi[0], s.max, 1e-9) && near(lo, s.min, 1e-9) && hi[1] !== '', `${hi[0]} (${hi[1]}), ${lo}`)
		}
		await page.click('#reset-lab')
		const after = await page.evaluate(() => ({...window.schleimpilz.net.params}))
		check('Reset restores net.params', JSON.stringify(after) === JSON.stringify(defaults), JSON.stringify(after))
		const values = await page.evaluate(() => [...document.querySelectorAll('#sliders input[type=range]')].map((i) => Number(i.value)))
		check('…and the sliders', JSON.stringify(values) === JSON.stringify(sliders.map((s) => defaults[s.id.slice(2)])), JSON.stringify(values))
		await page.click('#lab summary')
		await blur(page)
	})

	await section('theme', main, async () => {
		await reset(page)
		await page.evaluate(() => (window.__qa.palettes.length = 0))
		await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
		await frames(page, 3)
		let calls = await qa(page, () => window.__qa.palettes.slice())
		check('data-theme="dark" re-reads the palette (setPalette, dark: true)', calls.at(-1) === true, JSON.stringify(calls))
		check('…and the page turns dark', (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(13, 16, 10)', await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
		await page.evaluate(() => window.schleimpilz.step(1))
		await page.screenshot({path: join(OUT, 'theme-dark.png')})
		await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
		await frames(page, 3)
		calls = await qa(page, () => window.__qa.palettes.slice())
		check('data-theme="light" re-reads it with dark: false', calls.at(-1) === false, JSON.stringify(calls))
		await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
		await frames(page, 3)
		calls = await qa(page, () => window.__qa.palettes.slice())
		check('removing data-theme follows the system (light here)', calls.at(-1) === false && calls.length === 3, JSON.stringify(calls))
	})

	await section('zoom', main, async () => {
		await reset(page)
		// keys
		await page.keyboard.press('+')
		let v = await view(page)
		check('+ zooms in (×1.3) and shows "Whole dish"', near(v.zoom, 1.3, 1e-6) && !(await hidden(page, '#fit')), JSON.stringify(v))
		await page.keyboard.press('-')
		await page.keyboard.press('-')
		v = await view(page)
		check('- zooms out, not below the whole dish', near(v.zoom, 1, 1e-9) && near(v.x, 512, 1e-6) && near(v.y, 512, 1e-6) && (await hidden(page, '#fit')), JSON.stringify(v))
		await page.keyboard.press('=')
		const eq = await view(page)
		await page.keyboard.press('0')
		v = await view(page)
		check('= zooms in, 0 shows the whole dish', near(eq.zoom, 1.3, 1e-6) && v.zoom === 1 && (await hidden(page, '#fit')), `${JSON.stringify(eq)} ${JSON.stringify(v)}`)

		// the wheel keeps the point under the cursor where it is
		const target = (await qa(page, () => window.__qa.alive())).find((f) => f.name === 'Ostkreuz')
		let [cx, cy] = await toClient(page, target.x, target.y)
		await page.mouse.move(cx, cy)
		await page.mouse.wheel(0, -300)
		await frames(page, 3)
		v = await view(page)
		let [nx, ny] = await toClient(page, target.x, target.y)
		check('the wheel zooms in', v.zoom > 1.5, JSON.stringify(v))
		check('…keeping the point under the cursor fixed', near(nx, cx, 0.75) && near(ny, cy, 0.75), `${fmt([nx, ny])} vs cursor ${fmt([cx, cy])}`)
		await page.mouse.move(cx + 1, cy)
		await page.mouse.move(cx, cy)
		check('…so the tooltip there still names Ostkreuz', (await text(page, '#tip'))?.startsWith('Ostkreuz · '), await text(page, '#tip'))
		await page.screenshot({path: join(OUT, 'zoom.png')})
		const fit = await page.evaluate(() => {
			const b = document.getElementById('fit'), f = b.getBoundingClientRect(), h = document.querySelector('.hud').getBoundingClientRect()
			const top = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2)
			return {
				position: getComputedStyle(b).position,
				box: [f.left, f.top, f.width, f.height].map(Math.round),
				onTop: !!top && (top === b || b.contains(top)),
				covered: top && top !== b && !b.contains(top) ? top.id || top.tagName : null,
				overlapsHud: f.left < h.right && f.right > h.left && f.top < h.bottom && f.bottom > h.top,
			}
		})
		check('BUG css: "Whole dish" shows on top of the dish, clickable and clear of the HUD', fit.onTop && !fit.overlapsHud && fit.box[2] > 0, JSON.stringify(fit))

		// clicks while zoomed land where they should
		await page.mouse.down()
		await page.mouse.up()
		await settle(page)
		check('a click while zoomed takes away the flake under the cursor', (await log(page))[0]?.text === 'You took away the oat flake at Ostkreuz' && (await hud(page)) === '1 of 37 oat flakes', `${(await log(page))[0]?.text}, ${await hud(page)}`)
		await page.mouse.click(cx, cy)
		await settle(page)
		const back = (await qa(page, () => window.__qa.alive())).find((f) => f.kind === 'yours')
		check('…and a second one puts a flake back right there', back && near(back.x, target.x, 0.7) && near(back.y, target.y, 0.7) && (await hud(page)) === '1 of 38 oat flakes', JSON.stringify(back))
		const s = await qa(page, () => window.__qa.scale())
		const [spot] = await qa(page, (c) => window.__qa.emptyCity(1, {from: c, maxFrom: 3}), [target.x, target.y])
		const at = await clickMap(page, spot.x, spot.y)
		await settle(page)
		const put = (await qa(page, () => window.__qa.alive())).filter((f) => f.kind === 'yours').at(-1)
		const want = await fromClient(page, ...at)
		check('clicking empty city while zoomed puts the flake under the cursor', put && near(put.x, want[0], 0.5 / s + 0.01) && near(put.y, want[1], 0.5 / s + 0.01) && near(put.x, spot.x, 1), `${fmt([put?.x, put?.y])} vs ${fmt(want)}`)

		// panning with the oat flake tool
		await page.keyboard.press('0')
		const [ox, oy] = await toClient(page, 512, 512)
		await page.mouse.move(ox, oy)
		await page.mouse.wheel(0, -385) // about ×2, around the middle
		await frames(page, 3)
		v = await view(page)
		const nBefore = (await qa(page, () => window.__qa.alive())).length, logBefore = (await log(page)).length
		const sc = await qa(page, () => window.__qa.scale())
		await page.mouse.move(ox, oy)
		await page.mouse.down()
		await page.mouse.move(ox + 100, oy, {steps: 5})
		await page.mouse.up()
		let v2 = await view(page)
		check('a drag pans the zoomed dish with the pointer', near(v2.x, v.x - 100 / sc, 0.6) && near(v2.y, v.y, 0.01), `x ${fmt(v.x)} -> ${fmt(v2.x)}, expected ${fmt(v.x - 100 / sc)}`)
		const box = await page.locator('#overlay').boundingBox()
		const drag = async (x0, y0, x1, y1) => {
			await page.mouse.move(x0, y0)
			await page.mouse.down()
			await page.mouse.move(x1, y1, {steps: 12})
			await page.mouse.up()
			return view(page)
		}
		const half = 512 / v.zoom
		v2 = await drag(box.x + 20, oy, DESKTOP.width - 4, oy)
		const edge = await toClient(page, 0, 512)
		check('pan clamps at the west edge of the dish', near(v2.x, half, 1e-6) && near(edge[0], box.x, 0.5), `view.x ${fmt(v2.x)} (edge at ${fmt(half)}), map x 0 at ${fmt(edge[0])} vs canvas ${fmt(box.x)}`)
		v2 = await drag(box.x + box.width - 20, oy, 4, oy)
		check('…and the east edge', near(v2.x, 1024 - half, 1e-6), JSON.stringify(v2))
		v2 = await drag(ox, box.y + 10, ox, DESKTOP.height - 4)
		check('…and the north edge', near(v2.y, half, 1e-6), JSON.stringify(v2))
		v2 = await drag(ox, box.y + box.height - 10, ox, 4)
		check('…and the south edge', near(v2.y, 1024 - half, 1e-6), JSON.stringify(v2))
		await settle(page)
		check('panning puts down and takes away no flakes', (await qa(page, () => window.__qa.alive())).length === nBefore && (await log(page)).length === logBefore, `${(await log(page))[0]?.text}`)
		let clicked = true
		await page.click('#fit', {timeout: 2500}).catch(async () => {
			clicked = false
			await page.keyboard.press('0')
		})
		v = await view(page)
		check('"Whole dish" can be clicked, zooms back out and hides', clicked && v.zoom === 1 && v.x === 512 && v.y === 512 && (await hidden(page, '#fit')), clicked ? JSON.stringify(v) : 'the button could not be clicked (something covers it)')
		await drag(ox, oy, ox + 150, oy + 40)
		await settle(page)
		v = await view(page)
		check('at zoom 1 a drag does nothing', v.zoom === 1 && v.x === 512 && v.y === 512 && (await qa(page, () => window.__qa.alive())).length === nBefore && (await log(page)).length === logBefore, JSON.stringify(v))

		// wheel limits
		await page.mouse.move(ox, oy)
		await page.mouse.wheel(0, -4000)
		await frames(page, 3)
		check('the wheel zooms in to 4× at most', (await view(page)).zoom === 4, JSON.stringify(await view(page)))
		await page.mouse.wheel(0, 4000)
		await frames(page, 3)
		v = await view(page)
		check('…and back out to the whole dish', v.zoom === 1 && v.x === 512 && v.y === 512, JSON.stringify(v))

		// light painted while zoomed lands under the cursor
		const alex = await qa(page, () => window.__qa.stations.find((s) => s.name === 'Alexanderplatz'))
		;[cx, cy] = await toClient(page, alex.x, alex.y)
		await page.mouse.move(cx, cy)
		await page.mouse.wheel(0, -500)
		await frames(page, 3)
		await page.keyboard.press('2')
		await page.evaluate(() => (window.__qa.paints.length = 0))
		const zc = await fromClient(page, cx, cy), zd = await fromClient(page, cx + 120, cy + 40)
		await page.mouse.move(cx, cy)
		await page.mouse.down()
		await page.mouse.move(cx + 120, cy + 40, {steps: 6})
		await page.mouse.up()
		const zp = await qa(page, () => window.__qa.paints.splice(0))
		check('light while zoomed starts under the cursor', zp.length > 0 && near(zp[0][0], zc[0], 0.5) && near(zp[0][1], zc[1], 0.5), `${fmt(zp[0]?.slice(0, 2))} vs ${fmt(zc)} (zoom ${fmt((await view(page)).zoom)})`)
		check('…and follows it', zp.length > 0 && near(zp.at(-1)[0], zd[0], 0.5) && near(zp.at(-1)[1], zd[1], 0.5), `${fmt(zp.at(-1)?.slice(0, 2))} vs ${fmt(zd)}`)
		check('…with the same 1 km brush', zp.every((p) => near(p[2], 1024 / 50.71, 0.01)), JSON.stringify(zp[0]))
		const lit = await qa(page, (c) => window.schleimpilz.renderer.lightAt(c[0], c[1]), zc)
		check('…and the light is there on the map', lit > 0.2, lit)
		await page.locator('#dish').screenshot({path: join(OUT, 'zoom-light.png')})
		await page.keyboard.press('r')
		await page.keyboard.press('1')
		await page.keyboard.press('0')
	})

	await section('resize', main, async () => {
		await reset(page)
		const measure = () =>
			page.evaluate(() => {
				const d = document.getElementById('dish').getBoundingClientRect()
				const o = document.getElementById('overlay'), g = document.getElementById('gl')
				const wide = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5 && el.offsetParent !== null && !el.closest('.bench'))
				return {
					w: d.width,
					h: d.height,
					overlay: [o.width, o.height],
					gl: [g.width, g.height],
					dpr: Math.min(devicePixelRatio || 1, 2),
					scrollW: document.documentElement.scrollWidth,
					clientW: document.documentElement.clientWidth,
					wide: wide.slice(0, 5).map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : '')),
				}
			})
		const sizes = (m, label) => {
			const want = Math.round(m.w * m.dpr)
			check(`${label}: the dish is square`, near(m.w, m.h, 0.5), `${m.w}×${m.h}`)
			check(`${label}: both canvases are the dish size × devicePixelRatio`, [...m.overlay, ...m.gl].every((v) => v === want), `${JSON.stringify(m.overlay)} ${JSON.stringify(m.gl)}, want ${want}`)
			check(`${label}: no horizontal scroll`, m.scrollW <= m.clientW, `${m.scrollW} > ${m.clientW}: ${m.wide.join(', ')}`)
		}
		const desk = await measure()
		sizes(desk, '1440×900')
		check('1440×900: the dish fills the bench height (860 px)', desk.w === 860, desk.w)

		await page.setViewportSize(PHONE)
		await waitFor(page, (w) => document.getElementById('dish').getBoundingClientRect().width !== w, desk.w)
		await frames(page, 4)
		const phone = await measure()
		sizes(phone, '390×844')
		check('390×844: the dish spans the width less the 16 px gutters', phone.w === PHONE.width - 32, phone.w)
		await page.screenshot({path: join(OUT, 'phone.png'), fullPage: true})

		// on the phone layout the wheel scrolls the page; only ctrl (a trackpad pinch) zooms
		const d = await page.locator('#overlay').boundingBox()
		await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2)
		await page.mouse.wheel(0, 120)
		await frames(page, 3)
		check('390×844: the wheel alone does not zoom', (await view(page)).zoom === 1, JSON.stringify(await view(page)))
		await page.evaluate(() => scrollTo(0, 0))
		await frames(page, 2)
		const d2 = await page.locator('#overlay').boundingBox()
		await page.mouse.move(d2.x + d2.width / 2, d2.y + d2.height / 2)
		await page.keyboard.down('Control')
		await page.mouse.wheel(0, -200)
		await page.keyboard.up('Control')
		await frames(page, 3)
		check('390×844: ctrl + wheel zooms', (await view(page)).zoom > 1.2, JSON.stringify(await view(page)))
		await page.keyboard.press('0')

		// a tooltip near the edge of the dish stays readable
		const east = (await qa(page, () => window.__qa.alive())).sort((a, b) => b.x - a.x)[0]
		await page.mouse.move(...(await toClient(page, east.x, east.y)))
		const tipBox = await page.evaluate(() => {
			const t = document.getElementById('tip')
			if (t.hidden) return null
			const r = t.getBoundingClientRect(), b = document.getElementById('bench').getBoundingClientRect()
			return {left: r.left, right: r.right, benchRight: b.right, text: t.textContent}
		})
		check(`390×844: the tooltip of ${east.name} (the easternmost flake) is not cut off`, tipBox && tipBox.right <= tipBox.benchRight + 0.5 && tipBox.left >= 0, JSON.stringify(tipBox))
		await page.mouse.move(2, 2)

		await page.setViewportSize(DESKTOP)
		await waitFor(page, (w) => document.getElementById('dish').getBoundingClientRect().width !== w, phone.w)
		await frames(page, 4)
		const again = await measure()
		sizes(again, 'back at 1440×900')
		check('back at 1440×900: the dish is as big as before', again.w === desk.w, again.w)
		const code = (await qa(page, () => window.__qa.alive()))[1]
		await clickMap(page, code.x, code.y)
		await settle(page)
		check('back at 1440×900: a click still hits the flake under it', (await log(page))[0]?.text === `You took away the oat flake at ${code.name}`, (await log(page))[0]?.text)
	})

	await section('code', main, async () => {
		// the slime starts at CODE; take CODE's flake away and put another down
		await reset(page)
		await page.click('label:has(#setup-none)')
		await settle(page)
		const code = (await qa(page, () => window.__qa.alive()))[0]
		await clickMap(page, code.x, code.y)
		await settle(page)
		check('CODE can be taken away (HUD "0 of 0")', (await hud(page)) === '0 of 0 oat flakes', await hud(page))
		const [spot] = await qa(page, (c) => window.__qa.emptyCity(1, {from: c, minFrom: 1.2, maxFrom: 2.5, minKm: 0.5}), [code.x, code.y])
		await clickMap(page, spot.x, spot.y)
		await settle(page)
		const km = Math.hypot(spot.x - code.x, spot.y - code.y) / (1024 / 50.71)
		await stepUntil(page, () => window.__qa.log().some((e) => e.text.startsWith('Reached ')), {chunk: 40, max: 480})
		const reachedNote = (await log(page)).find((e) => e.text.startsWith('Reached '))
		check('the slime reaches the new flake', !!reachedNote, JSON.stringify(await log(page)))
		check(`BUG slot 0: its distance is measured from CODE (${km.toFixed(1)} km)`, reachedNote && near(parseFloat(reachedNote.far), km, 0.051), `logged "${reachedNote?.text}  ${reachedNote?.far}"; flakes[0] is now ${JSON.stringify((await qa(page, () => window.__qa.flakes()))[0])}`)
		await page.click('label:has(#setup-hubs)')
		await blur(page)
	})

	await section('live', main, async () => {
		// without ?manual the dish runs on its own; Pause must stop its clock
		const live = await open({query: ''})
		await live.click('label:has(#setup-none)') // one flake: cheap steps, so the speed shows
		await blur(live)
		const st = () => live.evaluate(() => ({clock: window.schleimpilz.state.clock, steps: window.schleimpilz.state.steps, frame: window.schleimpilz.state.frame, hud: document.getElementById('hud-clock').textContent}))
		check('the clock runs', await waitFor(live, () => window.schleimpilz.state.clock > 1.2, null, 20000), JSON.stringify(await st()))
		check('…and the HUD shows it', await waitFor(live, () => document.getElementById('hud-clock').textContent !== '0:00', null, 5000), (await st()).hud)
		await live.click('#play')
		const p0 = await st()
		await live.waitForTimeout(1500)
		const p1 = await st()
		check('Pause stops the clock and the model', p1.clock === p0.clock && p1.steps === p0.steps && p1.hud === p0.hud && p1.frame > p0.frame, `${JSON.stringify(p0)} -> ${JSON.stringify(p1)}`)
		await live.click('#play')
		check('Play starts them again', await waitFor(live, (c) => window.schleimpilz.state.clock > c + 0.5, p1.clock, 10000), JSON.stringify(await st()))
		await blur(live)
		await live.keyboard.press('Space')
		const k0 = await st()
		await live.waitForTimeout(800)
		const k1 = await st()
		check('Space pauses the live dish', k1.steps === k0.steps && k1.clock === k0.clock, `${JSON.stringify(k0)} -> ${JSON.stringify(k1)}`)
		await live.keyboard.press('Space')
		const rate = async (speed) => {
			await live.focus('#speed')
			await live.keyboard.press(speed === 1 ? 'Home' : 'End')
			await blur(live)
			const a = await st()
			await live.waitForTimeout(1200)
			const b = await st()
			return (b.steps - a.steps) / Math.max(1, b.frame - a.frame)
		}
		const slow = await rate(1), fast = await rate(6)
		check('the Speed slider changes the steps per frame', slow <= 1.01 && fast > 3 * slow, `speed 1: ${fmt(slow)} steps a frame, speed 6: ${fmt(fast)}`)
		await done(live)
	})

	await section('dpr', main, async () => {
		for (const [vp, dsf] of [
			[PHONE, 3],
			[DESKTOP, 1.5],
		]) {
			const p = await open({viewport: vp, deviceScaleFactor: dsf})
			await frames(p, 3)
			const m = await p.evaluate(() => {
				const d = document.getElementById('dish').getBoundingClientRect()
				const o = document.getElementById('overlay'), g = document.getElementById('gl')
				return {w: d.width, h: d.height, overlay: [o.width, o.height], gl: [g.width, g.height]}
			})
			const want = Math.round(m.w * Math.min(dsf, 2))
			check(`${vp.width}×${vp.height} at devicePixelRatio ${dsf}: canvases are ${want} px (ratio capped at 2)`, [...m.overlay, ...m.gl].every((v) => v === want) && near(m.w, m.h, 0.5), JSON.stringify(m))
			await done(p)
		}
	})

	await section('touch', main, async () => {
		const t = await open({hasTouch: true})
		const cdp = await t.context().newCDPSession(t)
		const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: pts.map(([x, y], i) => ({x, y, id: i + 1, radiusX: 2, radiusY: 2, force: 1}))})
		const pinch = async (m, d0, d1, shift = [0, 0], steps = 10) => {
			await touch('touchStart', [[m[0] - d0, m[1]]])
			await touch('touchStart', [[m[0] - d0, m[1]], [m[0] + d0, m[1]]])
			for (let k = 1; k <= steps; k++) {
				const d = d0 + ((d1 - d0) * k) / steps, sx = (shift[0] * k) / steps, sy = (shift[1] * k) / steps
				await touch('touchMove', [[m[0] - d + sx, m[1] + sy], [m[0] + d + sx, m[1] + sy]])
			}
			await touch('touchEnd', [])
			await frames(t, 3)
		}
		const box = await t.locator('#overlay').boundingBox()
		const m = [box.x + box.width * 0.55, box.y + box.height * 0.45]
		const under = await fromClient(t, ...m)
		const n0 = (await qa(t, () => window.__qa.alive())).length, l0 = (await log(t)).length
		await pinch(m, 40, 100)
		let v = await view(t)
		const back = await toClient(t, ...under)
		check('spreading two fingers zooms in by their distance (×2.5)', near(v.zoom, 2.5, 0.05), JSON.stringify(v))
		check('…around the point between them', near(back[0], m[0], 1.5) && near(back[1], m[1], 1.5), `${fmt(back)} vs ${fmt(m)}`)
		const s = await qa(t, () => window.__qa.scale())
		await pinch(m, 60, 60, [80, 0], 8)
		const v2 = await view(t)
		check('moving two fingers together pans', near(v2.x, v.x - 80 / s, 1.5) && near(v2.zoom, v.zoom, 0.02), `x ${fmt(v.x)} -> ${fmt(v2.x)}, expected ${fmt(v.x - 80 / s)}`)
		await pinch(m, 120, 20)
		v = await view(t)
		check('pinching zooms back out, not below 1', v.zoom >= 1 && v.zoom < 1.2, JSON.stringify(v))
		await frames(t, 14)
		check('pinching puts down and takes away no flakes', (await qa(t, () => window.__qa.alive())).length === n0 && (await log(t)).length === l0, JSON.stringify((await log(t))[0]))
		await t.screenshot({path: join(OUT, 'touch.png')})

		// a tap puts down or takes away a flake
		await t.keyboard.press('0')
		const f = (await qa(t, () => window.__qa.alive())).find((x) => x.name === 'Friedrichstr.')
		await t.touchscreen.tap(...(await toClient(t, f.x, f.y)))
		await frames(t, 14)
		check('a tap on a flake takes it away', (await log(t))[0]?.text === 'You took away the oat flake at Friedrichstr.', (await log(t))[0]?.text)

		// pinching with the Light tool
		await t.keyboard.press('2')
		await t.evaluate(() => (window.__qa.paints.length = 0))
		const l1 = (await log(t)).length
		await pinch(m, 40, 90)
		const painted = await qa(t, () => window.__qa.paints.length)
		const notes = (await log(t)).slice(0, (await log(t)).length - l1).map((e) => e.text)
		check('BUG pinch: a pinch with the Light tool paints no light', painted === 0 && notes.length === 0, `${painted} paintLight calls, log: ${JSON.stringify(notes)}`)
		await done(t)
	})
} catch (err) {
	area = 'run'
	check('the test got through all areas', false, err.stack || err.message)
} finally {
	await browser.close().catch(() => {})
	server.close()
}

// --- Summary --------------------------------------------------------------------

await writeFile(join(OUT, 'results.json'), JSON.stringify({stubs: STUB, results}, null, '\t'))
const failed = results.filter((r) => !r.ok)
const byArea = new Map()
for (const r of results) {
	const a = byArea.get(r.area) || {ok: 0, fail: 0}
	r.ok ? a.ok++ : a.fail++
	byArea.set(r.area, a)
}
console.log('\nsummary')
for (const [name, a] of byArea) console.log(`  ${a.fail ? 'FAIL' : 'ok  '} ${name.padEnd(10)} ${a.ok} passed${a.fail ? `, ${a.fail} failed` : ''}`)
if (failed.length) {
	const bugs = failed.filter((r) => /^BUG /.test(r.name))
	console.error(`\nFAILED ${failed.length} of ${results.length} checks${bugs.length ? ` (${bugs.length} of them known bugs, marked BUG)` : ''}`)
	for (const r of failed) console.error(`  [${r.area}] ${r.name}${r.detail ? `\n      ${r.detail.split('\n').join('\n      ')}` : ''}`)
	console.error(`\nscreenshots and results.json in ${OUT}`)
	process.exit(1)
}
console.log(`\nok, ${results.length} checks; screenshots in ${OUT}`)
