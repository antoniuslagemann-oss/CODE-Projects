#!/usr/bin/env node
// Builds the single file and tries it the way the Artifact host will show it.
// dist/preview.html has the host's skeleton and a CSP like its. This opens it
// in headless Chromium and fails on console errors, page errors and whatever
// the CSP blocks, and when the title isn't the Artifact's name, the dish
// canvases are missing or empty, or app.js doesn't get through starting up.
// The screenshot goes to tests/output/single/.
//
//   node tools/check-single.mjs
//   CHROMIUM_ARGS="--ignore-certificate-errors-spki-list=..." node tools/check-single.mjs
//
// Google Fonts may be out of reach, in a sandbox say. Failed font requests
// don't count; the fonts that did load are listed.

import {createServer} from 'node:http'
import {mkdir, readFile} from 'node:fs/promises'
import {basename, join, relative} from 'node:path'
import {chromium} from 'playwright'
import {SCRIPT_NAME, build, summary} from './build-single.mjs'

const TITLE = 'Schleimpilz' // the Artifact's name, which should stay the same
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//
const WAIT_MS = 30000

let built
try {
	built = build()
} catch (err) {
	console.error(`build-single: ${err.message}`)
	process.exit(1)
}
console.log(summary(built) + '\n')
const OUT = join(built.root, 'tests', 'output', 'single')

// Errors name lines of the one script; this says which file they're in.
const where = (text) => text.replaceAll(new RegExp(`\\b${SCRIPT_NAME.replace('.', '\\.')}:(\\d+)`, 'g'), (_, line) => built.locate(Number(line)))

// dist/ as the host has it: these files and nothing else
const server = createServer(async (req, res) => {
	try {
		const name = basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)) || 'preview.html'
		const body = await readFile(join(built.dir, name))
		res.writeHead(200, {'content-type': name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream'})
		res.end(body)
	} catch {
		res.writeHead(404)
		res.end()
	}
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))

await mkdir(OUT, {recursive: true})
const browser = await chromium.launch({
	// as in tests/smoke.mjs: WebGL2 in software
	args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...(process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean)],
})
const problems = []
try {
	const page = await browser.newPage({viewport: {width: 1440, height: 900}, deviceScaleFactor: 1})
	page.on('console', (m) => {
		const text = m.text().trim()
		const at = m.location()
		if (FONTS.test(at.url)) return // Google Fonts out of reach
		if (/GPU stall due to ReadPixels/.test(text)) return // the driver grumbling about a readback, as in tests/smoke.mjs
		// where it came from: a line of the one script, or the URL that didn't load
		const from = at.url === SCRIPT_NAME ? built.locate(at.lineNumber + 1) : at.url && !at.url.endsWith('/preview.html') ? at.url : ''
		if (m.type() === 'error' || /GL_INVALID|WebGL:/.test(text)) problems.push(`console ${m.type()}: ${where(text)}${from ? ` (at ${from})` : ''}`)
	})
	page.on('pageerror', (err) => problems.push(`page error: ${where(err.stack || err.message)}`))
	page.on('requestfailed', (r) => {
		if (!FONTS.test(r.url())) problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`)
	})

	const t0 = Date.now()
	await page.goto(`http://127.0.0.1:${server.address().port}/preview.html`)
	// app.js sets up window.schleimpilz, the hook tests/smoke.mjs uses, once it has started
	const started = await page.waitForFunction(() => window.schleimpilz, null, {timeout: WAIT_MS}).then(() => true, () => false)
	const startMs = Date.now() - t0
	if (started) await page.waitForTimeout(2000) // let it run for a bit
	await page.screenshot({path: join(OUT, 'page.png'), fullPage: true})

	const info = await page.evaluate(async () => {
		await Promise.race([document.fonts.ready, new Promise((ok) => setTimeout(ok, 5000))])
		const error = document.getElementById('error')
		return {
			title: document.title,
			error: error && !error.hidden ? error.textContent : null,
			canvases: [...document.querySelectorAll('#dish canvas')].map((c) => ({id: c.id, box: [c.clientWidth, c.clientHeight], buffer: [c.width, c.height]})),
			fonts: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')))],
		}
	})

	if (info.title !== TITLE) problems.push(`document.title is ${JSON.stringify(info.title)}, not ${JSON.stringify(TITLE)}`)
	if (info.error) problems.push(`the page shows an error: ${info.error}`)
	if (!info.canvases.length) problems.push('there is no canvas in #dish')
	for (const c of info.canvases)
		if (!c.box.every(Boolean) || !c.buffer.every(Boolean)) problems.push(`canvas #${c.id} in #dish is ${c.box.join('×')} px on the page, drawing buffer ${c.buffer.join('×')}`)
	if (!started) problems.push(`app.js didn't finish starting within ${WAIT_MS / 1000} s (no window.schleimpilz)`)

	console.log(`preview      ${relative(built.root, built.preview)}, served at 127.0.0.1`)
	console.log(`title        ${info.title}`)
	console.log(`canvases     ${info.canvases.map((c) => `#${c.id} ${c.box.join('×')} (buffer ${c.buffer.join('×')})`).join(', ') || '(none)'}`)
	console.log(`started      ${started ? `in ${(startMs / 1000).toFixed(1)} s` : 'no'}`)
	console.log(`fonts        ${info.fonts.join(', ') || 'none loaded, so the fallbacks show (is Google Fonts reachable?)'}`)
	console.log(`screenshot   ${relative(built.root, join(OUT, 'page.png'))}`)
} finally {
	await browser.close()
	server.close()
}

if (problems.length) {
	console.error('\nFAILED\n' + problems.map((p) => '  ' + p).join('\n'))
	process.exit(1)
}
console.log('\nok')
