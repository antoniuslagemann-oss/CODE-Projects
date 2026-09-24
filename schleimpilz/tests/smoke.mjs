// Loads the page in headless Chromium, runs the slime for a while and checks
// that nothing broke and that it actually spreads. Screenshots go to
// tests/output/.
//
//   npm test
//   STEPS=3000 npm test

import {createServer} from 'node:http'
import {readFile, mkdir} from 'node:fs/promises'
import {extname, join, normalize} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'output')
const STEPS = Number(process.env.STEPS) || 2400
const CHUNK = 400
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}

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
const url = `http://127.0.0.1:${server.address().port}/index.html?manual`

await mkdir(OUT, {recursive: true})
const browser = await chromium.launch({
	args: [
		'--use-angle=swiftshader',
		'--enable-unsafe-swiftshader',
		'--ignore-gpu-blocklist',
		...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean),
	],
})
const failures = []
try {
	const page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1})
	page.on('console', (m) => {
		const text = m.text()
		// the synchronous probe that the test uses makes the driver grumble
		if (/GPU stall due to ReadPixels/.test(text)) return
		// fonts come from Google, which a sandbox may not reach
		if (m.location().url.includes('fonts.g')) return
		if (m.type() === 'error' || /GL_INVALID|WebGL:/.test(text)) failures.push(`console ${m.type()}: ${text}`)
	})
	page.on('pageerror', (e) => failures.push(`page error: ${e.message}`))
	page.on('requestfailed', (r) => {
		// fonts come from Google, which a sandbox may not reach
		if (!r.url().includes('fonts.g')) failures.push(`request failed: ${r.url()}`)
	})

	await page.goto(url)
	if (await page.locator('#error').isVisible()) {
		throw new Error(`page shows an error: ${await page.locator('#error').textContent()}`)
	}
	await page.waitForFunction(() => window.schleimpilz)

	const reachedOf = async () => Number((await page.locator('#hud-reached').textContent()).split(' ')[0])
	for (let done = 0; done < STEPS; done += CHUNK) {
		const t = Date.now()
		const steps = await page.evaluate((n) => window.schleimpilz.step(n), Math.min(CHUNK, STEPS - done))
		console.log(`step ${steps}: ${await page.locator('#hud-reached').textContent()} reached (${Date.now() - t} ms)`)
		await page.locator('#dish').screenshot({path: join(OUT, `dish-${String(steps).padStart(5, '0')}.png`)})
	}

	await page.evaluate(() => window.schleimpilz.setShowRail(true))
	await page.evaluate(() => window.schleimpilz.step(1))
	await page.locator('#dish').screenshot({path: join(OUT, 'dish-compare.png')})
	await page.screenshot({path: join(OUT, 'page.png')})

	// the same moment in the dark theme and on a phone
	await page.evaluate(() => window.schleimpilz.setShowRail(false))
	await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
	await page.evaluate(() => window.schleimpilz.step(1))
	await page.screenshot({path: join(OUT, 'page-dark.png')})
	await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
	await page.setViewportSize({width: 390, height: 844})
	await page.waitForTimeout(300)
	await page.evaluate(() => window.schleimpilz.step(1))
	await page.screenshot({path: join(OUT, 'phone.png'), fullPage: true})

	const reached = await reachedOf()
	if (reached < 3) failures.push(`the slime reached only ${reached} oat flakes`)
} finally {
	await browser.close()
	server.close()
}

if (failures.length) {
	console.error('\nFAILED\n' + failures.map((f) => '  ' + f).join('\n'))
	process.exit(1)
}
console.log(`\nok, screenshots in ${OUT}`)
