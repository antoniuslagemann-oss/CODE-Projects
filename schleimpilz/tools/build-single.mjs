#!/usr/bin/env node
// Builds the page as one file, to publish as a claude.ai Artifact.
//
//   node tools/build-single.mjs
//
// dist/schleimpilz.html is the file to publish. The host puts it inside its
// own skeleton (doctype, <html>, a <head> with charset, viewport and a small
// reset, <body>), so it has none of those tags. It holds, in this order:
//   - the <title>, which the host looks for in the first 8 KB,
//   - the font preconnects and the Google Fonts stylesheet,
//   - the local stylesheets, in one <style>,
//   - the markup between <!-- page --> and <!-- /page --> in index.html,
//   - the scripts, in their order, in one classic <script>.
// dist/preview.html is the same file inside a skeleton like the host's, with
// its reset and a Content-Security-Policy like its, to try it out locally
// (tools/check-single.mjs does that).
//
// The stylesheets and scripts are the ones index.html names, so new ones are
// picked up. Anything the Artifact couldn't load, like a relative image, a
// stylesheet from another host or a module, stops the build with a message
// instead of breaking quietly once published.

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT = 'schleimpilz.html'
export const SCRIPT_NAME = 'schleimpilz.js' // what stack traces call the one <script>
const MAX_BYTES = 16 * 1024 * 1024 // the host's limit for a page
const FONT_CSS = /^https:\/\/fonts\.googleapis\.com\//

// The host's skeleton, as the Artifact rules describe it. The policy is our
// reading of them: scripts from a few CDNs, stylesheets from Google Fonts,
// fonts from its gstatic host, workers from blob: URLs, and everything else
// only from the artifact itself, which here is this one file.
const HOST_CSP = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' data: https://fonts.gstatic.com",
	"img-src 'self' data: blob:",
	"media-src 'self' data: blob:",
	"worker-src 'self' blob:",
].join('; ')
const HOST_RESET = `:root { color-scheme: light; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #fafaf8; }
img { max-width: 100%; }
[hidden] { display: none !important; }`

const fail = (message) => {
	throw new Error(message)
}

// Comments and whitespace don't count as content.
const stray = (html) => html.replace(/<!--[\s\S]*?-->/g, '').trim()

// Lines the way JavaScript counts them.
const lineCount = (text) => text.split(/\r\n|[\n\r\u2028\u2029]/).length

// A URL that points at another file of the site. The Artifact is one file.
const isLocal = (url) => url.trim() !== '' && !/^([a-z][a-z\d+.-]*:|\/\/|#)/i.test(url.trim())

// The attributes of a start tag, as {name: value}.
function attrs(tag) {
	const out = {}
	const inside = tag.replace(/^<[^\s>]+|\/?>$/g, '')
	for (const [, name, ...values] of inside.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
		out[name.toLowerCase()] = values.find((v) => v !== undefined) ?? ''
	return out
}

// The only match of a /g regex in index.html.
function one(html, re, what) {
	const found = [...html.matchAll(re)]
	if (found.length !== 1) fail(`index.html should have one ${what}, and has ${found.length}`)
	return found[0]
}

function read(root, url, what) {
	try {
		return readFileSync(join(root, decodeURIComponent(url.split(/[?#]/)[0])), 'utf8')
	} catch {
		fail(`${what} in index.html points at ${url}, which isn't there`)
	}
}

// Compiles a script without running it, so a syntax error can name the file
// and line it's in. `locate` turns a line number into such a name.
function compile(code, locate, hint = '') {
	try {
		new vm.Script(code)
	} catch (err) {
		if (err.name !== 'SyntaxError') throw err
		const line = Number(/:(\d+)$/.exec(err.stack.split('\n')[0])?.[1])
		fail(`${locate(line)}: ${err.message}${hint}`)
	}
}

// A file is strict if it starts with 'use strict', after any comments.
const isStrict = (code) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])use strict\1/.test(code)

// Inside <script>, the HTML parser stops at the first "</script", and after a
// "<!--" a later "<script" can keep it from stopping where it should. Both can
// only be in strings, regexes and comments, where "<\/script" and "\x3C!--"
// mean the same thing (only String.raw would notice). Anywhere else they are
// a syntax error, which compiling the bundle catches.
const escapeJs = (code) => code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\x3C!--')

// Inside <style>, only "</style" matters, and in CSS "\/" is "/".
const escapeCss = (css) => css.replace(/<\/(style)/gi, '<\\/$1')

// Calls that load another file at runtime, going by a string argument.
const LOADS = /\b(fetch|import|importScripts|Worker|SharedWorker|EventSource)\s*\(\s*(['"`])(?![a-z][a-z\d+.-]*:|\/\/)/g

// url() and @import in CSS. The Artifact has no other files, and its CSP only
// lets stylesheets and fonts come from Google Fonts.
function checkCss(css, what) {
	for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi)) {
		const url = m[2] ?? m[4]
		if (/^(data:|#)/i.test(url) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) continue
		fail(`${what} loads ${url}, which the Artifact can't. Put it in as a data: URI.`)
	}
}

// Attributes that load or link to a URL. A relative one points at a file the
// Artifact doesn't have.
function checkMarkup(markup) {
	if (/<!doctype|<\/?(html|head|body)\b/i.test(markup)) fail('The markup between <!-- page --> and <!-- /page --> has a doctype, <html>, <head> or <body> tag, and the host brings its own.')
	for (const [tag] of markup.matchAll(/<[a-z][^>]*>/gi)) {
		const a = attrs(tag)
		for (const name of ['src', 'href', 'srcset', 'poster', 'data', 'action', 'formaction'])
			if (a[name] !== undefined && isLocal(a[name])) fail(`${tag} in the page markup points at ${a[name]}, which the Artifact won't have. Inline it (a data: URI) or link to a full https:// URL.`)
		if (a.style) checkCss(a.style, `A style attribute in ${tag}`)
	}
}

// All scripts in one. Each gets a banner, and a ; after it so its last line
// can't run on into the next file's first. The comment on top says which
// lines of SCRIPT_NAME are which file, since that's what errors will name.
function bundle(scripts, strict, lang) {
	const width = Math.max(...scripts.map((s) => s.name.length))
	const top = [
		`// ${SCRIPT_NAME}: the scripts of index.html in one, made by tools/build-single.mjs.`,
		`// Errors give a line of ${SCRIPT_NAME}, counted from the <script> tag:`,
		...scripts.map(() => ''), // one per file, filled in below
	]
	if (strict) top.push(`'use strict' // for all of it: the files' own 'use strict' only counts at the very top of a script`)
	if (lang) top.push(`document.documentElement.lang ||= ${JSON.stringify(lang)} // <html lang> in index.html, which the host's skeleton replaces`)

	let line = 2 + top.length // line 1 is the rest of the <script> line, then the first banner
	const parts = scripts.map((s) => {
		const code = escapeJs(s.text).trimEnd()
		s.first = line + 1
		s.last = line + lineCount(code)
		line = s.last + 2
		return `// --- ${s.name} ---\n${code}\n;`
	})
	scripts.forEach((s, i) => (top[2 + i] = `//   ${s.name.padEnd(width)}  lines ${s.first}-${s.last}`))
	return `\n${[...top, ...parts, `//# sourceURL=${SCRIPT_NAME}`].join('\n')}\n`
}

export function build({root = ROOT, out = join(root, 'dist')} = {}) {
	const html = readFileSync(join(root, 'index.html'), 'utf8')
	const notes = [] // what was left out, on purpose
	const warnings = []

	// --- The parts of index.html ---
	const head = one(html, /<head\b[^>]*>([\s\S]*?)<\/head>/gi, '<head>')
	const body = one(html, /<body\b[^>]*>/gi, '<body>')
	const start = one(html, /<!--\s*page\s*-->/g, '<!-- page --> marker')
	const end = one(html, /<!--\s*\/page\s*-->/g, '<!-- /page --> marker')
	if (!(body.index < start.index && start.index < end.index)) fail('index.html should have <body>, then <!-- page -->, then <!-- /page -->')
	if (stray(html.slice(body.index + body[0].length, start.index))) fail('index.html has content between <body> and <!-- page -->, which the single file would leave out. Move it inside the markers.')
	const markup = html.slice(start.index + start[0].length, end.index).trim()
	const after = html.slice(end.index + end[0].length).replace(/<\/body>[\s\S]*$/i, '')
	const lang = attrs(/<html\b[^>]*>/i.exec(html)?.[0] ?? '<html>').lang

	// --- The head: title, fonts and stylesheets ---
	let title, description
	const links = []
	const styles = []
	const HEAD = /<title\b[^>]*>([\s\S]*?)<\/title>|<style\b[^>]*>([\s\S]*?)<\/style>|<script\b[\s\S]*?<\/script>|<(?:meta|link|base)\b[^>]*>|<!--[\s\S]*?-->/gi
	for (const [tag, titleText, styleText] of head[1].matchAll(HEAD)) {
		const name = /^<(\w+)/.exec(tag)?.[1].toLowerCase()
		const a = attrs(tag.slice(0, tag.indexOf('>') + 1))
		// a stylesheet for some media only gets to keep that when inlined
		const media = (css) => (a.media && a.media !== 'all' ? `@media ${a.media} {\n${css}\n}` : css)
		if (name === 'title') title = titleText.trim()
		else if (name === 'style') styles.push({name: 'index.html <style>', text: media(styleText)})
		else if (name === 'script') fail('index.html has a <script> in <head>. The single file runs all scripts at the end of the page, so put it with the others after <!-- /page -->.')
		else if (name === 'base') fail('index.html has a <base>, which would change what its URLs mean in the Artifact.')
		else if (name === 'meta') {
			// the host brings charset and viewport; the description is for publishing
			if (a.name === 'description') description = a.content
			else if (a.charset === undefined && a.name !== 'viewport') notes.push(tag)
		} else if (name === 'link') {
			const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
			const href = a.href ?? ''
			if (rel.includes('stylesheet') && isLocal(href)) styles.push({name: href, text: media(read(root, href, '<link rel="stylesheet">'))})
			else if (rel.includes('stylesheet') && !FONT_CSS.test(href)) fail(`index.html loads the stylesheet ${href}, and the Artifact's CSP only lets stylesheets come from fonts.googleapis.com. Copy it into the project and link that.`)
			else if (rel.includes('stylesheet') || rel.includes('preconnect') || rel.includes('dns-prefetch')) links.push(tag)
			else notes.push(tag)
		}
	}
	if (stray(head[1].replace(HEAD, ''))) fail(`index.html has something in <head> this build doesn't know: ${stray(head[1].replace(HEAD, '')).slice(0, 80)}`)
	if (!title) fail('index.html has no <title>, and the Artifact takes its name from it')

	// --- The scripts after the markup ---
	const scripts = []
	const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
	for (const [tag, inline] of after.matchAll(SCRIPT)) {
		const a = attrs(tag.slice(0, tag.indexOf('>') + 1))
		if (a.type && !/^(text|application)\/javascript$/i.test(a.type)) fail(`index.html has <script type="${a.type}">, and only classic scripts can share one <script>.`)
		if ('async' in a || 'defer' in a) fail(`A <script> in index.html is async or defer, which would run in another order once the scripts are one. Leave the attribute out; the scripts are at the end of the page anyway.`)
		if (a.src && !isLocal(a.src)) fail(`index.html loads the script ${a.src}. This build doesn't handle scripts from other hosts yet (the Artifact's CSP allows cdnjs.cloudflare.com, cdn.jsdelivr.net/npm and unpkg.com).`)
		scripts.push(a.src ? {name: a.src, text: read(root, a.src, '<script src>')} : {name: `index.html <script> ${scripts.length + 1}`, text: inline})
	}
	if (stray(after.replace(SCRIPT, ''))) fail(`index.html has something after <!-- /page --> besides scripts, which the single file would leave out: ${stray(after.replace(SCRIPT, '')).slice(0, 80)}`)
	if (!scripts.length) fail('index.html has no <script> after <!-- /page -->')

	// --- Checks, so a mistake names its file instead of breaking the Artifact ---
	checkMarkup(markup)
	for (const s of styles) checkCss(s.text, s.name)
	for (const s of scripts) {
		compile(s.text, (line) => `${s.name}:${line}`)
		for (const m of s.text.matchAll(LOADS))
			warnings.push(`${s.name}:${lineCount(s.text.slice(0, m.index))} calls ${m[1]}() with what looks like a relative URL, and the Artifact has no other files`)
	}
	// One script has one mode. The page's own files ask for strict mode, so
	// the bundle is strict, and a file that doesn't ask has to cope with it.
	const strict = scripts.some((s) => isStrict(s.text))
	if (strict)
		for (const s of scripts.filter((s) => !isStrict(s.text)))
			compile(`'use strict';${s.text}`, (line) => `${s.name}:${line}`, ` (${s.name} has no 'use strict', but runs in strict mode in the single file)`)

	const js = bundle(scripts, strict, lang)
	const locate = (line) => {
		const s = scripts.find((s) => line >= s.first && line <= s.last)
		return s ? `${s.name}:${line - s.first + 1}` : `${SCRIPT_NAME}:${line}`
	}
	compile(js, locate, ' (this only happens with the scripts put together: two files declare the same name, or there is a "<!--" or "</script" outside a string)')
	const css = styles.map((s) => `/* --- ${s.name} --- */\n${s.text.trim()}`).join('\n\n')

	// --- Put it together ---
	const single = [
		`<title>${title}</title>`,
		'<!-- Made from index.html by tools/build-single.mjs. Edit the sources, not this file. -->',
		...links,
		`<style>\n${escapeCss(css)}\n</style>`,
		markup,
		`<script>${js}</script>`,
		'',
	].join('\n')
	const bytes = Buffer.byteLength(single)
	if (bytes > MAX_BYTES) fail(`The single file is ${(bytes / 1048576).toFixed(1)} MB, and the host takes at most 16 MB.`)

	const preview = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${HOST_CSP}">
<style>
${HOST_RESET}
</style>
</head>
<body>
${single}</body>
</html>
`
	mkdirSync(out, {recursive: true})
	writeFileSync(join(out, OUTPUT), single)
	writeFileSync(join(out, 'preview.html'), preview)

	return {root, dir: out, file: join(out, OUTPUT), preview: join(out, 'preview.html'), bytes, title, description, links, styles, scripts, notes, warnings, locate}
}

// What was built, for the terminal.
export function summary(r) {
	const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
	const row = (label, text) => `  ${label.padEnd(12)} ${text}`
	const files = [relative(r.root, r.file), relative(r.root, r.preview)]
	const w = Math.max(...files.map((f) => f.length))
	const width = Math.max(...r.scripts.map((s) => s.name.length), ...r.styles.map((s) => s.name.length))
	const fonts = r.links
		.map((tag) => attrs(tag).href?.replace(/&amp;/g, '&') ?? '')
		.filter((href) => FONT_CSS.test(href))
		.flatMap((href) => new URL(href).searchParams.getAll('family').map((f) => f.split(':')[0]))
	return [
		`${files[0].padEnd(w)}  ${kb(r.bytes)}, the file to publish (the host takes up to 16 MB)`,
		`${files[1].padEnd(w)}  the same in a skeleton like the host's, to open locally`,
		row('title', r.title),
		row('description', `${r.description ?? '(none)'}  <- for the Artifact's description`),
		row('fonts', fonts.join(', ') || '(none)'),
		...r.styles.map((s, i) => row(i ? '' : 'style', `${s.name.padEnd(width)}  ${kb(Buffer.byteLength(s.text))}`)),
		...r.scripts.map((s, i) => row(i ? '' : 'script', `${s.name.padEnd(width)}  ${kb(Buffer.byteLength(s.text))}  lines ${s.first}-${s.last} of ${SCRIPT_NAME}`)),
		...r.notes.map((tag) => row('left out', tag)),
		...r.warnings.map((text) => row('warning', text)),
	].join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		console.log(summary(build()))
	} catch (err) {
		console.error(`build-single: ${err.message}`)
		process.exit(1)
	}
}
