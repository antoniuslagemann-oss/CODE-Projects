// Screenshots of the page for design review, on the real renderer and
// metrics: the stage at 1440×900, 1280×800, 1920×1080 and in between, and a
// phone at 390×844 (the whole page), plus states (real S+U on, zoomed in,
// the popovers, the waiting panel, keyboard focus) and close-ups at twice
// the pixels. They go to tests/output/design2/. It also reports layout
// problems it can measure: panels that overlap the dish or each other,
// horizontal scroll, touch targets under 44 px on the phone.
//
//   node tests/design-glass.mjs
//   SHOTS=1440,phone node tests/design-glass.mjs    only some of them
//   STEPS=1200 node tests/design-glass.mjs          let the slime grow longer
//
// Google Fonts come through the sandbox proxy when CHROMIUM_ARGS carries
// --ignore-certificate-errors-spki-list for its CA.

import {createServer} from 'node:http'
import {readFile, mkdir} from 'node:fs/promises'
import {extname, join, normalize} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'output', 'design2')
const STEPS = Number(process.env.STEPS) || 900
const ONLY = (process.env.SHOTS || '').split(',').filter(Boolean)
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}
const want = (name) => !ONLY.length || ONLY.some((o) => name.startsWith(o))

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
const browser = await chromium.launch({
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean)],
})

const problems = []
const shot = (name) => join(OUT, `${name}.png`)
const t0 = Date.now()
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a)

async function open({width, height, phone = false, dpr = 1, motion = false}) {
	const context = await browser.newContext({
		viewport: {width, height},
		deviceScaleFactor: dpr,
		isMobile: phone,
		hasTouch: phone,
		colorScheme: 'dark',
		reducedMotion: motion ? 'no-preference' : 'reduce',
	})
	const page = await context.newPage()
	page.on('pageerror', (e) => problems.push(`page error (${width}×${height}): ${e.message}`))
	page.on('console', (m) => {
		if (m.type() === 'error' && !m.location().url.includes('fonts.g')) problems.push(`console (${width}×${height}): ${m.text()}`)
	})
	await page.goto(URL_)
	await page.waitForFunction(() => window.schleimpilz, null, {timeout: 60000})
	await page.evaluate(() => document.fonts.ready)
	const fonts = await page.evaluate(() => [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')))])
	if (!fonts.includes('Unbounded') || !fonts.includes('Geist')) problems.push(`fonts (${width}×${height}): only ${fonts.join(', ') || 'none'} loaded`)
	return {context, page}
}

// Grow the slime, and do what a visitor would near the end: put down a flake
// and shine a light, so the log has their entries at the top.
async function grow(page, steps, {visit: doVisit = true} = {}) {
	const at = Math.max(60, steps - 120)
	let visited = !doVisit
	for (let done = 0; done < steps; ) {
		const n = Math.min(100, steps - done, visited ? Infinity : at - done)
		await page.evaluate((k) => window.schleimpilz.step(k), n)
		done += n
		if (!visited && done >= at) {
			await visit(page)
			visited = true
		}
	}
	await page.evaluate(() => window.schleimpilz.step(1))
}

async function visit(page) {
	const box = await page.locator('#overlay').boundingBox()
	const at = (u, v) => [box.x + u * box.width, box.y + v * box.height]
	await page.mouse.click(...at(0.47, 0.5))
	await page.evaluate(() => window.schleimpilz.setTool('light'))
	await page.mouse.move(...at(0.5, 0.43))
	await page.mouse.down()
	await page.mouse.move(...at(0.53, 0.44), {steps: 4})
	await page.mouse.up()
	await page.mouse.move(0, 0)
	await page.evaluate(() => window.schleimpilz.setTool('food'))
}

// Boxes of the parts of the stage, and what overlaps what.
async function measure(page, label) {
	const m = await page.evaluate(() => {
		const box = (sel) => {
			const el = document.querySelector(sel)
			if (!el || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return null
			const r = el.getBoundingClientRect()
			return r.width && r.height ? {sel, x: r.left, y: r.top, w: r.width, h: r.height} : null
		}
		const dish = box('#dish')
		const parts = ['.masthead', '.hud', '.setup', '.card-verdict', '.card-log', '.corner', '.key', '.dock', '#hint'].map(box).filter(Boolean)
		return {
			dish,
			parts,
			scrollW: document.documentElement.scrollWidth,
			clientW: document.documentElement.clientWidth,
			scrollH: document.documentElement.scrollHeight,
			clientH: document.documentElement.clientHeight,
		}
	})
	const lines = [`${label}: dish ${m.dish ? `${Math.round(m.dish.w)} px at ${Math.round(m.dish.x)},${Math.round(m.dish.y)}` : 'missing'}`]
	if (m.scrollW > m.clientW) problems.push(`${label}: horizontal scroll, ${m.scrollW} > ${m.clientW}`)
	if (m.dish) {
		const cx = m.dish.x + m.dish.w / 2, cy = m.dish.y + m.dish.h / 2, r = m.dish.w / 2 + 10
		for (const p of m.parts) {
			// the nearest point of the box to the middle of the dish
			const nx = Math.max(p.x, Math.min(cx, p.x + p.w)), ny = Math.max(p.y, Math.min(cy, p.y + p.h))
			const d = Math.hypot(nx - cx, ny - cy)
			if (d < r && !['#hint'].includes(p.sel)) problems.push(`${label}: ${p.sel} reaches ${Math.round(r - d)} px into the lens ring`)
		}
	}
	for (let i = 0; i < m.parts.length; i++) {
		for (let j = i + 1; j < m.parts.length; j++) {
			const a = m.parts[i], b = m.parts[j]
			if (a.sel === '.masthead' && b.sel === '.hud') continue
			if (a.sel === '.corner' && b.sel === '.key') continue
			if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) problems.push(`${label}: ${a.sel} overlaps ${b.sel}`)
		}
	}
	for (const p of m.parts) lines.push(`    ${p.sel.padEnd(14)} ${Math.round(p.x)},${Math.round(p.y)} ${Math.round(p.w)}×${Math.round(p.h)}`)
	log(lines.join('\n'))
	return m
}

async function stage(width, height, extra = {}) {
	const name = `${width}`
	const {context, page} = await open({width, height})
	await grow(page, STEPS)
	log(`${width}×${height}: ${await page.locator('#hud-reached').textContent()}`)
	await page.screenshot({path: shot(`stage-${name}`)})
	await measure(page, `${width}×${height}`)
	if (extra.states) {
		await page.evaluate(() => window.schleimpilz.setShowRail(true))
		await page.evaluate(() => window.schleimpilz.step(1))
		await page.screenshot({path: shot(`stage-${name}-rail`)})
		await page.evaluate(() => {
			const d = document.getElementById('dish').getBoundingClientRect()
			window.schleimpilz.zoomAt(d.width * 0.5, d.height * 0.46, 2.4)
			window.schleimpilz.step(1)
		})
		await page.screenshot({path: shot(`stage-${name}-zoomed`)})
		await page.evaluate(() => {
			window.schleimpilz.resetView()
			window.schleimpilz.setShowRail(false)
			window.schleimpilz.step(1)
		})
		await page.click('#lab summary')
		await page.waitForTimeout(100)
		await page.screenshot({path: shot(`stage-${name}-lab`)})
		await page.click('#about summary')
		await page.waitForTimeout(100)
		await page.screenshot({path: shot(`stage-${name}-about`)})
		await page.keyboard.press('Escape')
		// the light tool, with the brush under the pointer
		await page.evaluate(() => window.schleimpilz.setTool('light'))
		const box = await page.locator('#overlay').boundingBox()
		await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.4)
		await page.evaluate(() => window.schleimpilz.step(1))
		await page.hover('#restart')
		await page.waitForTimeout(500)
		await page.screenshot({path: shot(`stage-${name}-light-hover`)})
		await page.evaluate(() => window.schleimpilz.setTool('food'))
		// keyboard focus in the dock
		await page.mouse.move(0, 0)
		await page.locator('#tool-food').focus()
		await page.keyboard.press('Tab')
		await page.locator('.dock').screenshot({path: shot(`stage-${name}-focus-play`)})
		await page.locator('#show-rail').focus()
		await page.keyboard.press('Shift+Tab')
		await page.keyboard.press('Tab')
		await page.locator('.dock').screenshot({path: shot(`stage-${name}-focus-switch`)})
		await page.locator('#setup-ring').focus()
		await page.keyboard.press('ArrowUp')
		await page.locator('.setup').screenshot({path: shot(`stage-${name}-focus-setup`)})
	}
	await context.close()
}

try {
	for (const [w, h, states] of [
		[1440, 900, true],
		[1280, 800, false],
		[1920, 1080, false],
		[1024, 768, false],
	]) {
		if (want(String(w))) await stage(w, h, {states})
	}

	if (want('wait')) {
		// the first seconds: nothing to measure yet
		const {context, page} = await open({width: 1440, height: 900})
		await page.evaluate(() => window.schleimpilz.step(40))
		await page.screenshot({path: shot('stage-1440-start')})
		await context.close()
		log('waiting state')
	}

	if (want('detail')) {
		// close-ups at twice the pixels
		const {context, page} = await open({width: 1440, height: 900, dpr: 2})
		await grow(page, STEPS)
		await page.locator('.masthead').screenshot({path: shot('detail-masthead')})
		await page.locator('.card-verdict').screenshot({path: shot('detail-verdict')})
		await page.locator('.card-log').screenshot({path: shot('detail-log')})
		await page.locator('.controls').screenshot({path: shot('detail-dock')})
		await page.locator('.corner').screenshot({path: shot('detail-corner')})
		await page.locator('#dish').screenshot({path: shot('detail-dish')})
		await page.evaluate(() => window.schleimpilz.setShowRail(true))
		await page.evaluate(() => window.schleimpilz.step(1))
		const d = await page.locator('#dish').boundingBox()
		await page.screenshot({path: shot('detail-dish-rail-center'), clip: {x: d.x + d.width * 0.25, y: d.y + d.height * 0.22, width: d.width * 0.5, height: d.height * 0.5}})
		await context.close()
		log('details')
	}

	if (want('phone')) {
		const {context, page} = await open({width: 390, height: 844, phone: true, dpr: 2})
		await grow(page, STEPS)
		await page.evaluate(() => window.scrollTo(0, 0))
		await page.screenshot({path: shot('phone-top')})
		await measure(page, '390×844')
		const small = await page.evaluate(() =>
			[...document.querySelectorAll('button, summary, a, .seg label, .switch, input[type="range"]')]
				.filter((el) => el.offsetParent !== null && !(el.tagName === 'A' && el.closest('p')))
				.map((el) => ({el, r: el.getBoundingClientRect()}))
				.filter(({r}) => r.height < 44 || (r.width < 44 && r.width > 0))
				.map(({el, r}) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ${Math.round(r.width)}×${Math.round(r.height)}`),
		)
		if (small.length) problems.push(`phone: under 44 px: ${small.join(', ')}`)
		// the whole page, by making the screen as tall as the page for a moment
		const total = await page.evaluate(() => document.documentElement.scrollHeight)
		await page.setViewportSize({width: 390, height: total})
		await page.waitForTimeout(400)
		await page.evaluate(() => window.schleimpilz.step(1))
		await page.screenshot({path: shot('phone-full')})
		await page.setViewportSize({width: 390, height: 844})
		await page.waitForTimeout(400)
		await page.locator('#bench').scrollIntoViewIfNeeded()
		await page.evaluate(() => document.getElementById('bench').scrollIntoView({block: 'start'}))
		await page.screenshot({path: shot('phone-dish')})
		await page.click('#lab summary')
		await page.waitForTimeout(150)
		await page.screenshot({path: shot('phone-lab')})
		await page.keyboard.press('Escape')
		// looking closer, with "Whole dish" under the lens
		await page.evaluate(() => {
			window.schleimpilz.zoomAt(179, 170, 2.4)
			window.schleimpilz.step(1)
		})
		await page.evaluate(() => document.getElementById('bench').scrollIntoView({block: 'start'}))
		await page.screenshot({path: shot('phone-zoomed')})
		const fit = await page.evaluate(() => {
			const f = document.getElementById('fit').getBoundingClientRect(), h = document.getElementById('hint').getBoundingClientRect()
			return {overlapsHint: f.bottom > h.top && f.top < h.bottom && f.right > h.left && f.left < h.right, f: [f.left, f.top, f.width, f.height].map(Math.round), h: [h.left, h.top, h.width, h.height].map(Math.round)}
		})
		if (fit.overlapsHint) problems.push(`phone: "Whole dish" overlaps the hint ${JSON.stringify(fit)}`)
		await context.close()
		log(`phone: page is ${total} px tall`)
	}

	if (want('motion')) {
		// the way in, caught part way
		const {context, page} = await open({width: 1440, height: 900, motion: true})
		for (const ms of [250, 700]) {
			await page.reload()
			await page.waitForTimeout(ms)
			await page.screenshot({path: shot(`motion-${ms}`)})
		}
		await context.close()
		log('motion')
	}
} finally {
	await browser.close()
	server.close()
}

if (problems.length) console.error('\nproblems\n' + [...new Set(problems)].map((p) => '  ' + p).join('\n'))
console.log(`\nscreenshots in ${OUT}`)
