// Renders tests/render-demo.html at a few moments of growth, at 1x and 2x
// device pixels, plus a few close-ups through the hand lens, and writes PNGs
// to tests/output/render/. The dish is drawn over the page's black and its
// amber glow, as it shows on the page.
//
//   node tests/render-shots.mjs
//   STEPS=150,600 node tests/render-shots.mjs
//   NET=path/to/network.js node tests/render-shots.mjs    another version of the model
//
// Headless Chromium draws WebGL on the CPU (SwiftShader), so render times
// printed here say little about a real GPU.

import {createServer} from 'node:http'
import {readFile, mkdir, writeFile} from 'node:fs/promises'
import {extname, join, normalize, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {chromium} from 'playwright'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'tests', 'output', 'render')
const STEPS = (process.env.STEPS || '300,600,1500,3000').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b)
const SIZE = Number(process.env.SIZE) || 900 // css px
const NET = process.env.NET ? resolve(process.env.NET) : null
const CHUNK = 50
const THEMES = process.env.LIGHT ? [true, false] : [true] // dark glass; LIGHT=1 adds the page's light tokens
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'}

const server = createServer(async (req, res) => {
	const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
	try {
		const file = NET && path === 'network.js' ? NET : join(ROOT, path || 'index.html')
		const body = await readFile(file)
		res.writeHead(200, {'content-type': TYPES[extname(path)] || 'application/octet-stream'})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base = `http://127.0.0.1:${server.address().port}`

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
const pad = (n) => String(n).padStart(4, '0')
const save = async (name, shot) => {
	await writeFile(join(OUT, name), Buffer.from(shot.png.split(',')[1], 'base64'))
	const s = shot.stats
	console.log(`  ${name}: ${Math.round(shot.ms)} ms${s ? `, ${s.tubes} tubes, ${s.sheet} in the sheet, ~${(s.tubeFragments / 1e6).toFixed(2)} M tube px, cpu ${s.cpuMs.toFixed(2)} ms` : ''}`)
}

try {
	const page = await browser.newPage({viewport: {width: SIZE, height: SIZE}, deviceScaleFactor: 1})
	page.on('console', (m) => {
		if (m.type() === 'error' || /GL_INVALID|WebGL:/.test(m.text())) failures.push(`console ${m.type()}: ${m.text()}`)
	})
	page.on('pageerror', (e) => failures.push(`page error: ${e.message}`))
	await page.goto(`${base}/tests/render-demo.html?manual&size=${SIZE}`)
	await page.waitForFunction(() => window.demo, null, {timeout: 60000})

	let done = 0
	for (const target of STEPS) {
		const t = Date.now()
		while (done < target) {
			const n = Math.min(CHUNK, target - done)
			await page.evaluate((n) => window.demo.step(n), n)
			done += n
		}
		const reached = await page.evaluate(() => window.demo.net.reachedFlakes().length)
		console.log(`step ${done}: ${reached} oat flakes reached (model ${((Date.now() - t) / 1000).toFixed(1)} s)`)
		for (const dark of THEMES) {
			const theme = dark ? '' : '-light'
			for (const dpr of [1, 2]) {
				const shot = await page.evaluate((o) => window.demo.capture(o), {dark, dpr})
				await save(`dish-${pad(done)}${theme}@${dpr}x.png`, shot)
			}
			// close-ups at 2x: the hand lens on the middle of the city, on CODE, and on the rim
			const code = await page.evaluate(() => window.demo.flakes[0])
			for (const [name, view] of [
				['centre', {x: 470, y: 400, zoom: 3}],
				['code', {x: code.x, y: code.y, zoom: 4}],
				['rim', {x: 190, y: 190, zoom: 3}],
			]) {
				const shot = await page.evaluate((o) => window.demo.capture(o), {dark, dpr: 2, view})
				await save(`lens-${pad(done)}-${name}${theme}.png`, shot)
			}
		}
	}

	// a lamp on the settled dish
	await page.evaluate(() => {
		for (let i = 0; i <= 12; i++) window.demo.paintLight(560 + i * 9, 600 - i * 4, 20, 0.35)
	})
	for (const dark of THEMES) {
		const shot = await page.evaluate((o) => window.demo.capture(o), {dark, dpr: 1})
		await save(`dish-${pad(done)}-lamp${dark ? '' : '-light'}@1x.png`, shot)
	}
} finally {
	await browser.close()
	server.close()
}

if (failures.length) {
	console.error('\nFAILED\n' + [...new Set(failures)].map((f) => '  ' + f).join('\n'))
	process.exit(1)
}
console.log(`\nok, screenshots in ${OUT}`)
