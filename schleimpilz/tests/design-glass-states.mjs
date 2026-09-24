// More states for design review, at 1440×900: the tooltip on a flake, the
// light brush, the Ringbahn and Only CODE setups, and the error message.
// Screenshots go to tests/output/design2/.
//
//   node tests/design-glass-states.mjs

import {createServer} from 'node:http'
import {readFile, mkdir} from 'node:fs/promises'
import {extname, join, normalize} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'output', 'design2')
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css'}
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
await mkdir(OUT, {recursive: true})
const browser = await chromium.launch({
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean)],
})
const problems = []
const shot = (name) => join(OUT, `${name}.png`)
const grow = async (page, n) => {
	for (let done = 0; done < n; done += 100) await page.evaluate((k) => window.schleimpilz.step(k), Math.min(100, n - done))
}
try {
	const context = await browser.newContext({viewport: {width: 1440, height: 900}, colorScheme: 'dark', reducedMotion: 'reduce'})
	const page = await context.newPage()
	page.on('pageerror', (e) => problems.push(e.message))
	await page.goto(`http://127.0.0.1:${server.address().port}/index.html?manual`)
	await page.waitForFunction(() => window.schleimpilz)
	await page.evaluate(() => document.fonts.ready)
	await grow(page, 1400)

	// the tooltip over Ostkreuz
	const at = await page.evaluate(() => {
		const S = window.schleimpilz, d = document.getElementById('dish').getBoundingClientRect()
		const f = S.state.flakes.find((f) => f.name === 'Ostkreuz')
		const s = (d.width / 1024) * S.view.zoom
		return [d.left + (f.x - S.view.x) * s + d.width / 2, d.top + (f.y - S.view.y) * s + d.height / 2]
	})
	await page.mouse.move(at[0] + 1, at[1])
	await page.mouse.move(at[0], at[1])
	const d = await page.locator('#dish').boundingBox()
	await page.screenshot({path: shot('state-tip'), clip: {x: at[0] - 200, y: at[1] - 120, width: 400, height: 200}})

	// the light brush
	await page.evaluate(() => window.schleimpilz.setTool('light'))
	await page.mouse.move(d.x + d.width * 0.36, d.y + d.height * 0.58)
	await page.evaluate(() => window.schleimpilz.step(1))
	await page.screenshot({path: shot('state-brush'), clip: {x: d.x + d.width * 0.36 - 160, y: d.y + d.height * 0.58 - 120, width: 320, height: 240}})
	await page.mouse.move(0, 0)
	await page.evaluate(() => window.schleimpilz.setTool('food'))

	// the Ringbahn
	await page.click('label:has(#setup-ring)')
	await grow(page, 1400)
	await page.screenshot({path: shot('state-ring')})

	// only CODE, early on
	await page.click('label:has(#setup-none)')
	await grow(page, 200)
	await page.screenshot({path: shot('state-none')})

	// the error, as app.js would show it
	await page.evaluate(() => {
		const e = document.getElementById('error')
		e.textContent = 'This dish needs WebGL2, which this browser doesn’t offer. A recent Chrome, Firefox or Safari will do.'
		e.hidden = false
	})
	await page.locator('#dish').screenshot({path: shot('state-error')})
	await context.close()
} finally {
	await browser.close()
	server.close()
}
if (problems.length) console.error('problems\n  ' + problems.join('\n  '))
console.log(`screenshots in ${OUT}`)
