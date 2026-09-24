// Screenshots of the page shell for design review: desktop and phone, light
// and dark, plus close-ups of the notebook and a few states (real network on,
// zoomed in, keyboard focus, lab settings open). They go to
// tests/output/design/.
//
//   node tests/design-shots.mjs
//   SHOTS=desktop,phone node tests/design-shots.mjs   only some of them
//   STEPS=600 node tests/design-shots.mjs              let the slime grow longer
//   STUB=render node tests/design-shots.mjs            use the stand-in renderer
//
// render.js and metrics.js may still be being written. When one is missing
// (or named in STUB), a stand-in is served in its place: a DishRenderer that
// draws a plausible dish with a 2D context, and a NetworkMetrics.compare()
// that returns sample numbers. The shots are for looking at the shell, not
// the model.
//
// Google Fonts come through the sandbox proxy, if there is one, when
// CHROMIUM_ARGS carries --ignore-certificate-errors-spki-list for its CA.

import {createServer} from 'node:http'
import {existsSync} from 'node:fs'
import {readFile, mkdir} from 'node:fs/promises'
import {extname, join, normalize} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'output', 'design')
const STEPS = Number(process.env.STEPS) || 420
const ONLY = (process.env.SHOTS || '').split(',').filter(Boolean)
const FORCE = (process.env.STUB || '').split(',').filter(Boolean)
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}
const want = (name) => !ONLY.length || ONLY.some((o) => name.startsWith(o))

// --- Stand-ins --------------------------------------------------------------

// A dish drawn with a 2D context: bench, a round glass dish, agar that is dim
// in the parks and bright outside the city, and the slime from the model.
const RENDER_STUB = String.raw`'use strict'
class DishRenderer {
	constructor(canvas, {width, height}) {
		this.canvas = canvas
		this.W = width
		this.H = height
		this.ctx = canvas.getContext('2d')
		if (!this.ctx) throw new Error('no 2D context')
		this.pal = null
		this.palVersion = 0
		this.net = null
		this.ground = null
	}
	setGround(city, extent) { this.city = city; this.extent = extent; this.ground = null }
	setMesh(net) { this.net = net }
	update(net) { this.net = net }
	setPalette(p) { this.pal = p; this.palVersion++; this.ground = null }
	paintLight() {}
	clearLight() {}
	lightAt() { return 0 }
	buildGround() {
		const {W, H, pal} = this
		const c = document.createElement('canvas')
		c.width = W
		c.height = H
		const g = c.getContext('2d')
		const img = g.createImageData(W, H)
		const ease = (t) => t * t * (3 - 2 * t)
		for (let i = 0; i < W * H; i++) {
			const city = ease(this.city[i] / 255), ext = ease(this.extent[i] / 255)
			for (let k = 0; k < 3; k++) {
				const park = pal.outside[k] + (pal.park[k] - pal.outside[k]) * ext
				img.data[i * 4 + k] = 255 * (park + (pal.dish[k] - park) * city)
			}
			img.data[i * 4 + 3] = 255
		}
		g.putImageData(img, 0, 0)
		this.ground = c
	}
	render(t, opts = {}) {
		if (!this.pal || !this.city) return
		if (!this.ground) this.buildGround()
		const {ctx, canvas, pal, net, W} = this
		const w = canvas.width, h = canvas.height
		const view = opts.view || {x: W / 2, y: W / 2, zoom: 1}
		const key = [w, h, view.x, view.y, view.zoom, net && net.time, net && net.grown, this.palVersion].join()
		if (key === this.key) return
		this.key = key
		const rgb = (c, a = 1) => 'rgba(' + c.map((v) => Math.round(v * 255)).join(',') + ',' + a + ')'
		const TAU = Math.PI * 2
		const s = (w / W) * view.zoom
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.fillStyle = rgb(pal.bench)
		ctx.fillRect(0, 0, w, h)
		ctx.setTransform(s, 0, 0, s, w / 2 - view.x * s, h / 2 - view.y * s)
		const cx = W / 2, cy = W / 2, R = W / 2 - 8
		// the dish's shadow on the bench, and the glass
		ctx.save()
		ctx.shadowColor = pal.dark ? 'rgba(0,0,0,0.6)' : 'rgba(40,50,30,0.22)'
		ctx.shadowBlur = 18 * s
		ctx.shadowOffsetY = 6 * s
		ctx.beginPath()
		ctx.arc(cx, cy, R, 0, TAU)
		ctx.fillStyle = rgb(pal.rim)
		ctx.fill()
		ctx.restore()
		ctx.save()
		ctx.beginPath()
		ctx.arc(cx, cy, R - 9, 0, TAU)
		ctx.clip()
		ctx.drawImage(this.ground, 0, 0)
		if (net) {
			let maxD = 0
			for (let e = 0; e < net.edgeCount; e++) if (net.alive[net.a[e]] && net.alive[net.b[e]] && net.D[e] > maxD) maxD = net.D[e]
			ctx.lineCap = 'round'
			// where it has been
			ctx.beginPath()
			for (let e = 0; e < net.edgeCount; e++) {
				const a = net.a[e], b = net.b[e]
				if (!net.alive[a] || !net.alive[b]) continue
				ctx.moveTo(net.x[a], net.y[a])
				ctx.lineTo(net.x[b], net.y[b])
			}
			ctx.strokeStyle = rgb(pal.trace)
			ctx.lineWidth = net.spacing * 0.9
			ctx.stroke()
			// the tubes, thin to thick
			const bins = 6
			for (let k = 0; k < bins; k++) {
				ctx.beginPath()
				for (let e = 0; e < net.edgeCount; e++) {
					const a = net.a[e], b = net.b[e]
					if (!net.alive[a] || !net.alive[b] || maxD <= 0) continue
					const rel = net.D[e] / maxD
					if (rel < 0.004) continue
					if (Math.min(bins - 1, Math.floor(Math.pow(rel, 0.35) * bins)) !== k) continue
					ctx.moveTo(net.x[a], net.y[a])
					ctx.lineTo(net.x[b], net.y[b])
				}
				const f = (k + 1) / bins
				ctx.strokeStyle = rgb(pal.slime, 0.35 + 0.65 * f)
				ctx.lineWidth = 0.8 + 4.6 * f
				ctx.stroke()
				if (k >= bins - 2) {
					ctx.strokeStyle = rgb(pal.core, 0.8)
					ctx.lineWidth = 0.4 + 1.2 * f
					ctx.stroke()
				}
			}
		}
		ctx.restore()
		// the rim: a glass wall with a lit edge
		ctx.beginPath()
		ctx.arc(cx, cy, R - 4.5, 0, TAU)
		ctx.strokeStyle = pal.dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)'
		ctx.lineWidth = 5
		ctx.stroke()
		ctx.beginPath()
		ctx.arc(cx, cy, R, 0, TAU)
		ctx.strokeStyle = pal.dark ? 'rgba(0,0,0,0.5)' : 'rgba(60,70,50,0.28)'
		ctx.lineWidth = 1
		ctx.stroke()
	}
}
`

const METRICS_STUB = String.raw`'use strict'
const NetworkMetrics = {
	compare({flakes}) {
		const alive = flakes.filter((f) => f.alive).length
		return {
			slime: {cost: 1.9, detour: 0.21, tolerance: 0.82},
			rail: {cost: 2.6, detour: 0.17, tolerance: 0.95},
			railCoverage: null,
			overlap: {railBuilt: 0.58, slimeOnRail: 0.66},
			foot: 'So far the slime links 9 of ' + alive + ' flakes with 27% less track than the S+U, but a single cut strands a flake more often.',
		}
	},
}
`

const STUBS = {'render.js': RENDER_STUB, 'metrics.js': METRICS_STUB}
const stubbed = Object.keys(STUBS).filter((f) => FORCE.includes(f.replace('.js', '')) || !existsSync(join(ROOT, f)))

// --- A static server ----------------------------------------------------------

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
const URL_ = `http://127.0.0.1:${server.address().port}/index.html?manual`

await mkdir(OUT, {recursive: true})
// Chromium takes the proxy from HTTPS_PROXY and NO_PROXY itself; Playwright's
// own proxy option would send the local server through it too.
const browser = await chromium.launch({
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean)],
})

const problems = []
const shot = (name) => join(OUT, `${name}.png`)
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`, ...a)

async function open({width, height, phone = false, scheme = 'light', dpr = 1}) {
	const context = await browser.newContext({
		viewport: {width, height},
		deviceScaleFactor: dpr,
		isMobile: phone,
		hasTouch: phone,
		colorScheme: scheme,
		reducedMotion: 'reduce', // no fade-ins caught half way
	})
	for (const file of stubbed) {
		await context.route(`**/${file}`, (route) => route.fulfill({status: 200, contentType: 'text/javascript', body: STUBS[file]}))
	}
	const page = await context.newPage()
	page.on('pageerror', (e) => problems.push(`page error (${width}×${height} ${scheme}): ${e.message}`))
	page.on('console', (m) => {
		if (m.type() === 'error' && !m.location().url.includes('fonts.g')) problems.push(`console: ${m.text()}`)
	})
	await page.goto(URL_)
	await page.waitForFunction(() => window.schleimpilz, null, {timeout: 60000})
	await page.evaluate(() => document.fonts.ready)
	return {context, page}
}

// Grow the slime, and do what a visitor would: put down a flake, shine a light.
async function grow(page, steps) {
	for (let done = 0; done < steps; ) {
		const n = Math.min(60, steps - done)
		await page.evaluate((k) => window.schleimpilz.step(k), n)
		done += n
		if (done === 120) await visit(page)
	}
	await page.evaluate(() => window.schleimpilz.step(1))
}

async function visit(page) {
	await page.locator('#overlay').scrollIntoViewIfNeeded()
	const box = await page.locator('#overlay').boundingBox()
	// an oat flake near Tempelhof, and a light over Kreuzberg
	const at = (u, v) => [box.x + u * box.width, box.y + v * box.height]
	await page.mouse.click(...at(0.47, 0.5))
	await page.evaluate(() => window.schleimpilz.setTool('light'))
	await page.mouse.move(...at(0.5, 0.43))
	await page.mouse.down()
	await page.mouse.move(...at(0.53, 0.44), {steps: 4})
	await page.mouse.up()
	await page.mouse.move(0, 0)
	await page.evaluate(() => window.schleimpilz.setTool('food'))
	await page.evaluate(() => window.scrollTo(0, 0))
}

async function scrollTo(page, selector) {
	await page.evaluate((sel) => {
		const el = document.querySelector(sel)
		el.scrollIntoView({block: 'start'})
	}, selector)
	await page.waitForTimeout(150)
}

// Sections of a tall screenshot, so each can be looked at in full.
async function sections(page, name, height) {
	const total = await page.evaluate(() => document.documentElement.scrollHeight)
	const width = page.viewportSize().width
	for (let y = 0, i = 1; y < total; y += height, i++) {
		await page.screenshot({path: shot(`${name}-${i}`), fullPage: true, clip: {x: 0, y, width, height: Math.min(height, total - y)}})
	}
}

try {
	log(`stand-ins: ${stubbed.join(', ') || 'none'}; steps: ${STEPS}`)

	for (const scheme of ['light', 'dark']) {
		if (!want('desktop') && !want('detail') && !want('state')) break
		const {context, page} = await open({width: 1440, height: 900, scheme})
		await grow(page, STEPS)
		log(`desktop ${scheme}: ${await page.locator('#hud-reached').textContent()}`)
		if (want('desktop')) {
			await page.screenshot({path: shot(`desktop-1440-${scheme}`)})
			await scrollTo(page, '[aria-labelledby="verdict-title"]')
			await page.screenshot({path: shot(`desktop-1440-${scheme}-results`)})
			await page.evaluate(() => window.scrollTo(0, 0))
			await page.screenshot({path: shot(`desktop-1440-${scheme}-full`), fullPage: true})
		}
		if (want('detail')) {
			// close-ups of the notebook, at twice the pixels
			const detail = await browser.newContext({viewport: {width: 1440, height: 900}, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: 'reduce'})
			for (const file of stubbed) await detail.route(`**/${file}`, (r) => r.fulfill({status: 200, contentType: 'text/javascript', body: STUBS[file]}))
			const p2 = await detail.newPage()
			p2.on('pageerror', (e) => problems.push(`page error (detail ${scheme}): ${e.message}`))
			await p2.goto(URL_)
			await p2.waitForFunction(() => window.schleimpilz, null, {timeout: 60000})
			await p2.evaluate(() => document.fonts.ready)
			await grow(p2, STEPS)
			await p2.locator('.masthead').screenshot({path: shot(`detail-masthead-${scheme}`)})
			const groups = p2.locator('.notebook > .group')
			const names = ['food', 'hand', 'compare', 'verdict', 'log']
			for (let i = 0; i < Math.min(names.length, await groups.count()); i++) {
				await groups.nth(i).screenshot({path: shot(`detail-${names[i]}-${scheme}`)})
			}
			await p2.locator('.hud').screenshot({path: shot(`detail-hud-${scheme}`)})
			await p2.locator('#dish-label').screenshot({path: shot(`detail-label-${scheme}`)})
			await p2.evaluate(() => (document.getElementById('lab').open = true))
			await p2.locator('#lab').screenshot({path: shot(`detail-lab-${scheme}`)})
			await p2.locator('.notes').screenshot({path: shot(`detail-notes-${scheme}`)})
			await p2.locator('#keys').screenshot({path: shot(`detail-keys-${scheme}`)}).catch(() => {})
			await detail.close()
		}
		if (want('state')) {
			// the real network on
			await page.evaluate(() => window.schleimpilz.setShowRail(true))
			await page.evaluate(() => window.schleimpilz.step(1))
			await page.evaluate(() => window.scrollTo(0, 0))
			await page.screenshot({path: shot(`state-rail-${scheme}`)})
			await page.locator('.notebook > .group').nth(2).screenshot({path: shot(`state-legend-${scheme}`)})
			// zoomed in on the middle of town
			await page.evaluate(() => {
				const d = document.getElementById('dish').getBoundingClientRect()
				window.schleimpilz.zoomAt(d.width * 0.48, d.height * 0.44, 2.6)
				window.schleimpilz.step(1)
			})
			await page.screenshot({path: shot(`state-zoomed-${scheme}`)})
			await page.locator('#dish').screenshot({path: shot(`state-zoomed-dish-${scheme}`)})
			await page.evaluate(() => {
				window.schleimpilz.resetView()
				window.schleimpilz.setShowRail(false)
			})
			// keyboard focus on the food choice, and hover on a button
			await page.evaluate(() => window.scrollTo(0, 0))
			await page.locator('#setup-ring').focus()
			await page.keyboard.press('ArrowLeft')
			await page.keyboard.press('ArrowRight')
			await page.locator('#restart').hover()
			await page.locator('.notebook > .group').first().screenshot({path: shot(`state-focus-${scheme}`)})
			await page.locator('#show-rail').focus()
			await page.keyboard.press('Shift+Tab')
			await page.keyboard.press('Tab')
			await page.locator('.notebook > .group').nth(2).screenshot({path: shot(`state-focus-switch-${scheme}`)})
		}
		await context.close()
	}

	if (want('desktop')) {
		const {context, page} = await open({width: 1280, height: 800})
		await grow(page, STEPS)
		await page.screenshot({path: shot('desktop-1280-light')})
		await context.close()
		log('desktop 1280')
	}

	for (const scheme of ['light', 'dark']) {
		if (!want('phone')) break
		const {context, page} = await open({width: 390, height: 844, phone: true, scheme})
		await grow(page, STEPS)
		await page.screenshot({path: shot(`phone-${scheme}`), fullPage: true})
		await page.screenshot({path: shot(`phone-${scheme}-top`)})
		await sections(page, `phone-${scheme}-part`, 844)
		// the dish at the top of the screen, with what fits under it
		await scrollTo(page, '#bench')
		await page.screenshot({path: shot(`phone-${scheme}-dish`)})
		const wide = await page.evaluate(() => document.documentElement.scrollWidth)
		if (wide > 390) problems.push(`phone ${scheme}: the page is ${wide} px wide, wider than the screen`)
		// what is too small to hit with a finger
		const small = await page.evaluate(() =>
			[...document.querySelectorAll('button, summary, a, .seg label, .switch, input[type="range"]')]
				// links inside a sentence are exempt; everything else wants a finger's width
				.filter((el) => el.offsetParent !== null && !(el.tagName === 'A' && el.closest('p')))
				.map((el) => ({el, r: el.getBoundingClientRect()}))
				.filter(({r}) => r.height < 44 || (r.width < 44 && r.width > 0))
				.map(({el, r}) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ')[0] : ''} ${Math.round(r.width)}×${Math.round(r.height)}`),
		)
		if (small.length) log(`phone ${scheme}: under 44 px: ${small.join(', ')}`)
		await page.evaluate(() => window.schleimpilz.zoomAt(180, 170, 2.4))
		await page.evaluate(() => window.schleimpilz.step(1))
		await page.locator('#bench').screenshot({path: shot(`phone-${scheme}-zoomed`)})
		await context.close()
		log(`phone ${scheme}`)
	}
} finally {
	await browser.close()
	server.close()
}

if (problems.length) console.error('\nproblems\n' + [...new Set(problems)].map((p) => '  ' + p).join('\n'))
console.log(`\nscreenshots in ${OUT}`)
