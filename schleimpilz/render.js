'use strict'

// The dish: a glass petri dish on the lab bench, agar lit through a mask the
// way Tero et al. (2010) lit theirs, and the slime's tubes growing on it.
//
// A frame is four draws:
//  1. explored, at map size and kept from frame to frame: everywhere the
//     slime has been. Only tubes grown since the last frame are added.
//  2. track, at map size: the fresh sheet at the growing edge, faint marks
//     where tubes have withered, and a soft copy of the living tubes for
//     their shadow and glow.
//  3. tubes, at screen size: every living tube as a capsule. Blending keeps
//     the largest value of each channel, so tubes that meet become one smooth
//     surface, like one organism. Channels: signed distance to the nearest
//     tube wall, height of the round cross-section, the tube's radius, and
//     the granules streaming inside it.
//  4. the dish itself: bench, glass, agar, and the tubes lit and shaded.
//
// Everything is plain WebGL2 and needs EXT_color_buffer_float.

const DishRenderer = (() => {
	const MAX_PUDDLES = 64
	const GRANULE = 1.6 // map px, length of a granule along a tube
	const WRAP = GRANULE * 64 // the granule pattern repeats after this many map px

	const DEFAULTS = {
		tubeRadius: 2.4, // map px, radius of the thickest trunk
		freshRadius: 0.6, // map px, the fine veins of a fresh sheet
		witheredD: 3e-4, // conductivity below which a tube has withered away
		veinFade: 2.2, // model time for a fresh vein to fade
		matureFrom: 0.5, // model time from which a tube starts to thicken...
		matureBy: 6, // ...and by which it has its full width
		filmFade: 1.1, // model time for the fresh sheet to dry into track
		filmRadius: 6.5, // map px
		exploreRadius: 5.5, // map px
		flowLow: 0.004, // smoothed |Q| from which a tube counts as carrying flow...
		flowHigh: 0.03, // ...and from which it fully does
		puddle: 9, // map px, radius of the slime on an oat flake
		ghostFade: 80, // model time for the mark of a withered tube to fade
		breathe: 0.045, // how much tubes widen and narrow with each pulse
		pulse: 5.5, // seconds per pulse
		wave: 240, // crawl distance per wavelength of the pulse
		stream: 5, // map px per second, the fastest streaming
		streamRef: 0.6, // flow per sqrt(conductivity) at which streaming gets fast
		smoothing: 1.2, // seconds over which the flow is averaged
		smoothingModel: 0.4, // same, in model time
		minPx: 0.7, // device px, radius of the thinnest drawn line
	}

	// --- Shaders ---------------------------------------------------------------

	const VS_QUAD = `#version 300 es
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

	// Every instance is one tube (or the puddle of slime on an oat flake).
	const INSTANCE = `
layout(location = 0) in vec4 a_seg; // x0, y0, x1, y1 in map px
layout(location = 1) in vec4 a_aux; // crawl distance at both ends, seed, kind (0 tube, 1 puddle)
layout(location = 2) in vec3 a_dyn; // conductivity (puddle: radius; < 0: not grown), born, streaming offset
layout(location = 3) in vec2 a_flow; // carries flow 0..1, mark of a withered tube 0..1

uniform vec2 u_sim;
uniform float u_scale; // device px per map px in the target
uniform float u_time; // model time
uniform float u_clock; // seconds
uniform float u_motion; // 0 when still
uniform vec4 u_tube; // thickest radius, reference rho, withered rho, fresh radius
uniform vec4 u_life; // vein fade, breathing, pulse rate, pulse wavenumber
uniform vec2 u_mature; // model time from which a tube starts to thicken, and by which it has

const vec4 NOWHERE = vec4(-2.0, -2.0, 0.0, 1.0);

// A tube's radius in map px, from its conductivity (D ~ r^4), its age and
// whether it carries flow. The fresh sheet has fine veins, mostly along the
// way it grows, that fade. A tube takes a while to build its walls, and only
// one that carries flow gets the radius its conductivity gives it; by then
// the ones nobody uses have withered.
float radiusOf(out float youth) {
	youth = 0.0;
	float born = a_dyn.y;
	if (born <= 0.0 || a_dyn.x < 0.0) return 0.0;
	float age = max(u_time - born, 0.0);
	if (a_aux.w > 0.5) return a_dyn.x * smoothstep(0.0, 1.2, age);
	float rho = pow(a_dyn.x, 0.25) / u_tube.y;
	float net = u_tube.x * rho * smoothstep(u_tube.z, u_tube.z * 1.9, rho);
	float len = distance(a_seg.xy, a_seg.zw);
	float along = clamp(abs(a_aux.y - a_aux.x) / max(len, 1e-3), 0.0, 1.0);
	youth = exp(-age / u_life.x);
	float vein = u_tube.w * (0.15 + 0.85 * smoothstep(0.3, 0.9, along)) * youth;
	return max(vein, net * a_flow.x * smoothstep(u_mature.x, u_mature.y, age));
}

// The slow pulse that runs out from where the slime started.
float pulse() {
	return cos(u_clock * u_life.z - 0.5 * (a_aux.x + a_aux.y) * u_life.w);
}

// A corner of the quad around the capsule, in map px, and the same point in
// the tube's own frame: along it from the first end, and across it.
vec2 corner(float ext, out vec2 local, out float len) {
	vec2 d = a_seg.zw - a_seg.xy;
	len = length(d);
	vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
	float u = (gl_VertexID & 1) == 1 ? len + ext : -ext;
	float v = (gl_VertexID & 2) == 2 ? ext : -ext;
	local = vec2(u, v);
	return a_seg.xy + dir * u + vec2(-dir.y, dir.x) * v;
}

vec4 clipOf(vec2 p) {
	return vec4(p.x / u_sim.x * 2.0 - 1.0, 1.0 - p.y / u_sim.y * 2.0, 0.0, 1.0);
}
`

	const VS_TUBE = `#version 300 es
precision highp float;
${INSTANCE}
uniform vec4 u_view; // map point at the centre of the canvas, device px per map px
uniform vec2 u_canvas;
uniform float u_minPx;
uniform float u_margin; // device px around each capsule, for smoothing
out vec2 v_local;
out vec2 v_world;
flat out vec4 v_a; // length, drawn radius (map px), true radius (device px), streaming offset
flat out vec4 v_b; // seed, kind
void main() {
	float youth;
	float r = radiusOf(youth) * (1.0 + u_motion * u_life.y * pulse());
	float rpx = r * u_scale;
	if (rpx < 0.04) {
		gl_Position = NOWHERE;
		return;
	}
	float drawn = max(rpx, u_minPx) / u_scale;
	vec2 local;
	float len;
	// room for tubes that bulge a little and puddles that spread
	float room = a_aux.w > 0.5 ? 1.25 : 1.1;
	vec2 p = corner(drawn * room + u_margin / u_scale, local, len);
	v_local = local;
	v_world = p;
	v_a = vec4(len, drawn, rpx, a_dyn.z);
	v_b = vec4(a_aux.z, a_aux.w, 0.0, 0.0);
	vec2 s = (p - u_view.xy) * u_view.z + 0.5 * u_canvas;
	gl_Position = vec4(s.x / u_canvas.x * 2.0 - 1.0, 1.0 - s.y / u_canvas.y * 2.0, 0.0, 1.0);
}`

	const FS_TUBE = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_world;
flat in vec4 v_a;
flat in vec4 v_b;
uniform float u_scale;
uniform float u_margin;
uniform sampler2D u_noise;
out vec4 o;
void main() {
	float len = v_a.x;
	bool puddle = v_b.y > 0.5;
	// tubes are a little uneven along their length, puddles ragged at the edge
	float wobble = texture(u_noise, v_world * (puddle ? 0.035 : 0.012)).g - 0.5;
	float r = v_a.y * (1.0 + (puddle ? 0.5 : 0.22) * wobble);
	vec2 q = vec2(v_local.x - clamp(v_local.x, 0.0, len), v_local.y);
	float sdf = (r - length(q)) * u_scale;
	if (sdf < -u_margin) discard;
	float rpx = r * u_scale;
	float s = clamp(sdf, 0.0, rpx);
	float h = sqrt(s * (2.0 * rpx - s)); // a round cross-section
	if (puddle) h = min(h * 0.45, 2.2 * u_scale); // puddles are flat
	// granules in the streaming protoplasm, carried along by the offset
	vec2 cell = vec2((v_local.x - v_a.w) / ${GRANULE.toFixed(2)}, v_local.y / max(r, 0.4));
	float grain = texture(u_noise, cell * (4.0 / 256.0) + v_b.x).b;
	o = vec4(sdf, h, sdf > 0.0 ? v_a.z : 0.0, grain * h);
}`

	const VS_TRACK = `#version 300 es
precision highp float;
${INSTANCE}
uniform vec4 u_track; // film radius, film fade, softness of shadow and glow, 0
out vec2 v_local;
flat out vec4 v_a; // length, film, mark of a withered tube, radius
void main() {
	float youth;
	float r = radiusOf(youth);
	float grown = a_dyn.y > 0.0 && a_dyn.x >= 0.0 ? 1.0 : 0.0;
	float film = grown * (1.0 - a_aux.w) * exp(-max(u_time - a_dyn.y, 0.0) / u_track.y);
	float ghost = grown * a_flow.y;
	float ext = 0.0;
	if (film > 0.01) ext = u_track.x;
	if (ghost > 0.02) ext = max(ext, 3.0);
	if (r > 0.15) ext = max(ext, r + u_track.z);
	if (ext <= 0.0) {
		gl_Position = NOWHERE;
		return;
	}
	vec2 local;
	float len;
	vec2 p = corner(ext, local, len);
	v_local = local;
	v_a = vec4(len, film, ghost, r);
	gl_Position = clipOf(p);
}`

	const FS_TRACK = `#version 300 es
precision highp float;
in vec2 v_local;
flat in vec4 v_a;
uniform vec4 u_track;
out vec4 o;
void main() {
	float d = length(vec2(v_local.x - clamp(v_local.x, 0.0, v_a.x), v_local.y));
	float film = v_a.y * (1.0 - smoothstep(u_track.x * 0.3, u_track.x, d));
	float gw = 0.7 + 1.1 * v_a.z;
	float ghost = v_a.z * (1.0 - smoothstep(gw * 0.25, gw, d));
	float r = v_a.w;
	float soft = 0.0;
	if (r > 0.0) {
		soft = (1.0 - smoothstep(r * 0.3, r + u_track.z, d)) * min(1.0, r / 1.4);
	}
	o = vec4(film, ghost, soft, 0.0);
}`

	const VS_EXPLORED = `#version 300 es
precision highp float;
${INSTANCE}
uniform float u_bornAfter;
uniform float u_reach;
out vec2 v_local;
flat out float v_len;
void main() {
	if (a_dyn.y <= u_bornAfter || a_dyn.x < 0.0) {
		gl_Position = NOWHERE;
		return;
	}
	vec2 local;
	float len;
	vec2 p = corner(u_reach, local, len);
	v_local = local;
	v_len = len;
	gl_Position = clipOf(p);
}`

	const FS_EXPLORED = `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_len;
uniform float u_reach;
out vec4 o;
void main() {
	float d = length(vec2(v_local.x - clamp(v_local.x, 0.0, v_len), v_local.y));
	o = vec4(1.0 - smoothstep(u_reach * 0.3, u_reach, d), 0.0, 0.0, 0.0);
}`

	const FS_DISH = `#version 300 es
precision highp float;
uniform sampler2D u_tubes; // screen size: distance to wall, height, radius, granules * height
uniform sampler2D u_track; // map size: fresh film, withered marks, soft tubes
uniform sampler2D u_explored; // map size: where the slime has been
uniform sampler2D u_env; // map size: light you shine, parkland, outside the city, mottling
uniform sampler2D u_noise;
uniform vec2 u_canvas;
uniform vec2 u_sim;
uniform vec4 u_view; // map point at the centre of the canvas, device px per map px
uniform float u_dark;
uniform float u_tap; // device px from the centre to each of four smoothing taps
uniform float u_margin;
uniform float u_rMax;
uniform vec3 u_bench, u_rim, u_dish, u_park, u_outside, u_light, u_trace, u_slime, u_core;
out vec4 o;

// towards the lamp, in map coordinates (y down): up and a little left
const vec2 LAMP = vec2(-0.47, -0.88);

vec3 screen(vec3 a, vec3 b) {
	return 1.0 - (1.0 - a) * (1.0 - b);
}

float band(float x, float centre, float width) {
	float t = (x - centre) / width;
	return exp(-t * t);
}

void main() {
	vec2 frag = gl_FragCoord.xy;
	vec2 p = u_view.xy + (vec2(frag.x, u_canvas.y - frag.y) - 0.5 * u_canvas) / u_view.z; // map px, y down
	vec2 uv = vec2(p.x / u_sim.x, 1.0 - p.y / u_sim.y); // for textures drawn at map size
	vec2 puv = p / u_sim; // for textures uploaded from the map
	float px = 1.0 / u_view.z; // one device pixel in map px

	vec2 c = p - 0.5 * u_sim;
	float rr = length(c);
	vec2 outward = c / max(rr, 1e-3);
	float R = 0.5 * min(u_sim.x, u_sim.y);
	float wall = 0.016 * R;
	float inner = R - wall;
	float facing = dot(outward, LAMP); // +1 on the side of the dish nearest the lamp

	// --- the agar, lit through the mask ---------------------------------------
	vec4 env = texture(u_env, puv);
	vec4 spread = textureLod(u_env, puv, 4.0);
	vec3 agar = mix(u_dish, u_park, env.g);
	agar = mix(agar, u_outside, env.b);
	// light scatters a little way into the agar in the shade
	float spill = max(spread.b - env.b, 0.0) + 0.4 * max(spread.g - env.g, 0.0);
	agar = mix(agar, u_outside, spill * mix(0.3, 0.55, u_dark));
	float lamp = clamp(env.r, 0.0, 1.0);
	agar = mix(agar, u_light, smoothstep(0.0, 1.0, lamp) * 0.92);
	agar = screen(agar, u_light * spread.r * mix(0.06, 0.16, u_dark));
	float grain = texture(u_noise, p * 0.011).r - 0.5;
	agar *= 1.0 + mix(0.05, 0.08, u_dark) * (env.a - 0.5) + mix(0.035, 0.05, u_dark) * grain;
	// the agar climbs the glass a little at the edge
	float m = inner - rr;
	agar *= 1.0 - 0.05 * smoothstep(0.55 * R, inner, rr) - mix(0.07, 0.0, u_dark) * exp(-max(m, 0.0) / 4.0);
	agar = screen(agar, vec3(mix(0.3, 0.22, u_dark) * band(m, 1.4, 0.6 + px)) * mix(u_outside, vec3(1.0), 0.5));

	// --- where the slime has been --------------------------------------------
	float ex = texture(u_explored, uv).r;
	float explored = smoothstep(0.3, 0.7, ex);
	vec4 tr = texture(u_track, uv);
	agar = mix(agar, u_trace, explored * 0.6);
	agar = mix(agar, mix(u_trace, u_core, 0.3), tr.g * 0.45);
	// the fresh sheet at the growing edge, thickest at its very front
	float film = smoothstep(0.0, 0.9, tr.r) * explored;
	float front = tr.r * explored * (1.0 - smoothstep(0.55, 0.95, ex));
	agar = mix(agar, mix(u_trace, u_slime, 0.6), film * 0.45 + front * 0.35);

	// shadow of the tubes, away from the lamp; in the dark they glow instead
	vec2 sp = p + LAMP * 2.4;
	float shade = texture(u_track, vec2(sp.x / u_sim.x, 1.0 - sp.y / u_sim.y)).b;
	vec3 tint = mix(vec3(1.0), u_slime, 0.45) * 0.8;
	agar *= mix(vec3(1.0), tint, shade * shade * 0.6 * (1.0 - u_dark));
	agar += u_dark * mix(u_slime, u_core, 0.3) * tr.b * tr.b * 0.42;

	// --- the tubes -----------------------------------------------------------
	vec3 col = agar;
	vec4 T = texelFetch(u_tubes, ivec2(frag), 0);
	if (T.r > 0.02 - u_margin) {
		vec4 A = texture(u_tubes, (frag + vec2(-u_tap, -u_tap)) / u_canvas);
		vec4 B = texture(u_tubes, (frag + vec2(u_tap, -u_tap)) / u_canvas);
		vec4 C = texture(u_tubes, (frag + vec2(-u_tap, u_tap)) / u_canvas);
		vec4 D = texture(u_tubes, (frag + vec2(u_tap, u_tap)) / u_canvas);
		// the average distance fills the corners where tubes meet
		float soft = 0.25 * (A.r + B.r + C.r + D.r);
		float cover = max(clamp(T.r + 0.5, 0.0, 1.0), clamp(soft + 0.3, 0.0, 1.0));
		float rpx = max(T.b, max(max(A.b, B.b), max(C.b, D.b)));
		float rs = rpx * px; // the tube's radius, map px
		// the surface, from the height of the cross-sections around
		vec2 slope = vec2(B.g + D.g - A.g - C.g, C.g + D.g - A.g - B.g) / (4.0 * u_tap);
		vec3 n = normalize(vec3(-slope * 0.85, 1.0));
		vec3 L = normalize(vec3(LAMP.x, -LAMP.y, 1.1));
		vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
		float q = clamp(1.0 - T.r / max(rpx, 0.8), 0.0, 1.0); // 0 on the ridge, 1 at the wall
		float thick = smoothstep(0.45, u_rMax * 0.95, rs);

		vec3 deep = mix(u_core, u_slime * vec3(1.06, 0.8, 0.3), u_dark);
		vec3 body = mix(u_slime, deep, thick * 0.85);
		vec3 lumen = mix(screen(body, mix(u_slime, vec3(1.0), 0.55) * 0.42), mix(body, u_core, 0.25 + 0.6 * thick), u_dark);
		vec3 wallCol = mix(body, body * body, 0.55) * 0.9;
		vec3 tube = mix(lumen, body, smoothstep(0.05, 0.65, q));
		tube = mix(tube, wallCol, smoothstep(0.5, 1.0, q) * (0.3 + 0.55 * thick));
		float grains = T.a / max(T.g, 1e-3);
		tube *= 1.0 + 0.18 * (grains - 0.5) * (1.0 - q * q) * smoothstep(0.8, 2.0, rs);
		tube *= 0.9 + 0.12 * clamp(dot(n, L), 0.0, 1.0);

		float alpha = cover * (1.0 - exp(-(0.45 + 1.5 * rs)));
		alpha *= 1.0 - 0.22 * pow(q, 4.0) * thick;
		col = mix(agar, tube, alpha);
		float spec = pow(max(dot(n, H), 0.0), 36.0) * smoothstep(0.9, 2.2, rs);
		col = screen(col, mix(vec3(1.0), u_light, 0.4) * spec * cover * mix(0.6, 0.38, u_dark));
	}
	// light you shine bleaches the slime a little too
	col = mix(col, screen(col, u_light * 0.45), smoothstep(0.0, 0.8, lamp));

	// --- glass and bench -----------------------------------------------------
	float x = clamp((rr - inner) / wall, 0.0, 1.0); // across the glass wall, inside to out
	float wpx = wall / px; // the wall in device px
	vec3 glass = mix(u_rim, u_outside, 0.25 + 0.2 * u_dark);
	glass *= 1.0 - 0.22 * (band(x, 0.0, 1.2 / wpx + 0.06) + band(x, 1.0, 1.2 / wpx + 0.05));
	float lit1 = band(x, 0.64, 0.9 / wpx + 0.08) * (0.2 + 0.8 * pow(max(facing, 0.0), 2.0));
	float lit2 = band(x, 0.3, 0.8 / wpx + 0.06) * pow(max(-facing, 0.0), 3.0);
	glass = screen(glass, mix(vec3(1.0), u_light, 0.5) * (0.8 * lit1 + 0.35 * lit2) * mix(1.0, 0.75, u_dark));
	glass = screen(glass, u_outside * mix(0.0, 0.35, u_dark) * band(x, 0.5, 0.45));

	float out1 = rr - R;
	float rs2 = length(c - vec2(3.0, 5.5)) - R; // the dish's shadow, away from the lamp
	vec3 bench = u_bench * (1.0 - (1.0 - u_dark) * (0.2 * exp(-max(rs2, 0.0) / 12.0) + 0.16 * exp(-max(out1, 0.0) / 1.8)));
	bench *= 1.0 - u_dark * 0.35 * exp(-max(out1, 0.0) / 2.5);
	bench += u_dark * u_outside * 0.16 * exp(-max(out1, 0.0) / 14.0);

	float kGlass = smoothstep(inner - 0.5 * px, inner + 0.5 * px, rr);
	float kBench = smoothstep(R - 0.5 * px, R + 0.5 * px, rr);
	vec3 outc = mix(mix(col, glass, kGlass), bench, kBench);
	outc += (texture(u_noise, frag / 256.0).a - 0.5) / 255.0;
	o = vec4(outc, 1.0);
}`

	// --- Helpers -----------------------------------------------------------------

	const smoothstep = (a, b, x) => {
		const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
		return t * t * (3 - 2 * t)
	}

	function hash(x) {
		x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
		x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
		return (x ^ (x >>> 16)) >>> 0
	}

	// Smooth noise that tiles, 0..1, on a size x size grid with features about
	// cell texels across.
	function valueNoise(size, cell, seed) {
		const n = size / cell
		const lattice = new Float32Array(n * n)
		for (let i = 0; i < n * n; i++) lattice[i] = hash(i * 7919 + seed * 104729 + 1) / 4294967296
		const out = new Float32Array(size * size)
		for (let y = 0; y < size; y++) {
			const gy = y / cell, iy = Math.floor(gy), fy = gy - iy, sy = fy * fy * (3 - 2 * fy)
			const y0 = (iy % n) * n, y1 = ((iy + 1) % n) * n
			for (let x = 0; x < size; x++) {
				const gx = x / cell, ix = Math.floor(gx), fx = gx - ix, sx = fx * fx * (3 - 2 * fx)
				const x0 = ix % n, x1 = (ix + 1) % n
				const a = lattice[y0 + x0], b = lattice[y0 + x1], c = lattice[y1 + x0], d = lattice[y1 + x1]
				out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
			}
		}
		return out
	}

	class DishRenderer {
		constructor(canvas, {width = 1024, height = 1024} = {}) {
			const gl = canvas.getContext('webgl2', {
				alpha: false,
				antialias: false,
				depth: false,
				stencil: false,
				premultipliedAlpha: false,
				preserveDrawingBuffer: false,
				powerPreference: 'high-performance',
			})
			if (!gl) throw new Error('This browser has no WebGL2.')
			if (!gl.getExtension('EXT_color_buffer_float')) {
				throw new Error('This browser cannot render to floating point textures (EXT_color_buffer_float).')
			}
			this.gl = gl
			this.canvas = canvas
			this.width = width
			this.height = height
			this.params = {...DEFAULTS}
			this.setPalette({})

			this.programs = {
				tube: this.program(VS_TUBE, FS_TUBE),
				track: this.program(VS_TRACK, FS_TRACK),
				explored: this.program(VS_EXPLORED, FS_EXPLORED),
				dish: this.program(VS_QUAD, FS_DISH),
			}

			// the ground: r light you shine, g parkland, b outside the city, a mottling
			this.env = new Uint8Array(width * height * 4)
			const mottle = [valueNoise(1024, 64, 1), valueNoise(1024, 24, 2), valueNoise(1024, 9, 3)]
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const k = (y & 1023) * 1024 + (x & 1023)
					const v = 0.55 * mottle[0][k] + 0.3 * mottle[1][k] + 0.15 * mottle[2][k]
					this.env[(y * width + x) * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, (v - 0.5) * 1.6 + 0.5)))
					this.env[(y * width + x) * 4 + 2] = 255
				}
			}
			this.envTex = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, width, height, {mipmaps: true})
			this.envDirty = [0, 0, width, height]

			// r fine grain, g smooth wobble, b granules, a dither
			const S = 256
			const fine = valueNoise(S, 2, 4), fine2 = valueNoise(S, 4, 5), gran = valueNoise(S, 4, 6), gran2 = valueNoise(S, 2, 7)
			const soft = valueNoise(S, 16, 8), soft2 = valueNoise(S, 8, 9)
			const noise = new Uint8Array(S * S * 4)
			for (let i = 0; i < S * S; i++) {
				const g = smoothstep(0.3, 0.8, 0.7 * gran[i] + 0.3 * gran2[i])
				noise[i * 4] = Math.round(255 * (0.6 * fine[i] + 0.4 * fine2[i]))
				noise[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, (0.65 * soft[i] + 0.35 * soft2[i] - 0.5) * 1.7 + 0.5)))
				noise[i * 4 + 2] = Math.round(255 * g)
				noise[i * 4 + 3] = hash(i + 99991) >>> 24
			}
			this.noiseTex = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, S, S, {repeat: true, mipmaps: true, data: noise})

			this.exploredTex = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, width, height)
			this.exploredFbo = this.framebuffer(this.exploredTex)
			this.trackTex = this.texture(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, width, height)
			this.trackFbo = this.framebuffer(this.trackTex)
			this.tubeTex = null
			this.tubeFbo = null
			this.tubeSize = [0, 0]

			this.emptyVao = gl.createVertexArray()
			this.vao = null
			this.net = null
			this.edgeCount = 0
			this.instances = 0
			this.puddles = [] // {node, x, y}
			this.flakeList = null
			this.clock0 = null
			this.lastClock = null
			this.modelTime = 0
			this.start = -1
			this.snap = true
			this.exploredAfter = -1
			this.exploredClear = true
			this.Dref = 0.4
			this.cpuMs = 0
		}

		program(vsSource, fsSource) {
			const gl = this.gl
			const compile = (type, source) => {
				const s = gl.createShader(type)
				gl.shaderSource(s, source)
				gl.compileShader(s)
				if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
					throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(s))
				}
				return s
			}
			const p = gl.createProgram()
			gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSource))
			gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSource))
			gl.linkProgram(p)
			if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
				throw new Error('Shader failed to link: ' + gl.getProgramInfoLog(p))
			}
			const u = {}
			const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
			for (let i = 0; i < n; i++) {
				const name = gl.getActiveUniform(p, i).name
				u[name] = gl.getUniformLocation(p, name)
			}
			return {p, u}
		}

		texture(internal, format, type, w, h, {repeat = false, mipmaps = false, data = null} = {}) {
			const gl = this.gl
			const t = gl.createTexture()
			gl.bindTexture(gl.TEXTURE_2D, t)
			gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
			const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
			if (mipmaps && data) gl.generateMipmap(gl.TEXTURE_2D)
			return t
		}

		framebuffer(texture) {
			const gl = this.gl
			const fbo = gl.createFramebuffer()
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
			const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
			gl.bindFramebuffer(gl.FRAMEBUFFER, null)
			if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + status.toString(16))
			return fbo
		}

		// --- The ground ----------------------------------------------------------

		// city and extent are Uint8 masks (255 = inside) at map resolution: near a
		// stop is city, in shade; between city and extent is parkland, dimly lit;
		// outside the extent the agar is brightly lit.
		setGround(city, extent) {
			const env = this.env
			for (let i = 0, n = this.width * this.height; i < n; i++) {
				const inside = extent[i] / 255
				env[i * 4 + 1] = Math.round(255 * inside * (1 - city[i] / 255))
				env[i * 4 + 2] = Math.round(255 * (1 - inside))
			}
			this.markDirty(0, 0, this.width, this.height)
		}

		// amount > 0 adds light, amount < 0 takes it away
		paintLight(cx, cy, radius, amount) {
			const {width: w, height: h, env} = this
			const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(w - 1, Math.ceil(cx + radius))
			const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(h - 1, Math.ceil(cy + radius))
			if (x1 < x0 || y1 < y0) return
			for (let y = y0; y <= y1; y++) {
				for (let x = x0; x <= x1; x++) {
					const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius
					if (d >= 1) continue
					const k = (y * w + x) * 4
					const soft = 1 - d * d
					env[k] = Math.max(0, Math.min(255, env[k] + amount * soft * 255))
				}
			}
			this.markDirty(x0, y0, x1 + 1, y1 + 1)
		}

		clearLight() {
			for (let i = 0; i < this.env.length; i += 4) this.env[i] = 0
			this.markDirty(0, 0, this.width, this.height)
		}

		// how much light you have shone on a point, 0..1
		lightAt(x, y) {
			const ix = Math.min(this.width - 1, Math.max(0, Math.floor(x)))
			const iy = Math.min(this.height - 1, Math.max(0, Math.floor(y)))
			return this.env[(iy * this.width + ix) * 4] / 255
		}

		markDirty(x0, y0, x1, y1) {
			const d = this.envDirty
			this.envDirty = d
				? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)]
				: [x0, y0, x1, y1]
		}

		uploadEnv() {
			if (!this.envDirty) return
			const gl = this.gl
			const [x0, y0, x1, y1] = this.envDirty
			this.envDirty = null
			gl.bindTexture(gl.TEXTURE_2D, this.envTex)
			gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.width)
			gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0)
			gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0)
			gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, this.env)
			gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
			gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
			gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
			gl.generateMipmap(gl.TEXTURE_2D)
		}

		// --- Colours -------------------------------------------------------------

		// RGB arrays, 0..1: bench, rim, dish (agar in shade), park (dim light),
		// outside (bright light), light (light you shine), trace, slime, core.
		// dark: true for the dark theme (guessed from the agar if left out).
		setPalette(p) {
			const pick = (key, fallback) => Float32Array.from(p[key] && p[key].length >= 3 ? p[key] : fallback)
			const dish = pick('dish', [0.894, 0.898, 0.843])
			const lum = 0.2126 * dish[0] + 0.7152 * dish[1] + 0.0722 * dish[2]
			const dark = typeof p.dark === 'boolean' ? p.dark : lum < 0.35
			const outside = pick('outside', dark ? [0.23, 0.267, 0.196] : [0.98, 0.984, 0.96])
			const bench = pick('bench', dark ? [0.051, 0.063, 0.039] : [0.867, 0.886, 0.831])
			this.palette = {
				dark,
				bench,
				rim: pick('rim', Array.from(bench, (v, i) => 0.5 * v + 0.5 * outside[i])),
				dish,
				park: pick('park', dark ? [0.137, 0.165, 0.11] : [0.933, 0.941, 0.902]),
				outside,
				light: pick('light', dark ? [0.81, 0.851, 0.969] : [1, 1, 1]),
				trace: pick('trace', dark ? [0.184, 0.176, 0.086] : [0.922, 0.875, 0.667]),
				slime: pick('slime', dark ? [0.769, 0.584, 0.067] : [0.937, 0.725, 0]),
				core: pick('core', dark ? [1, 0.91, 0.604] : [0.698, 0.439, 0]),
			}
		}

		// --- The slime -----------------------------------------------------------

		// Once, with the mesh of possible tubes.
		setMesh(net) {
			const gl = this.gl
			const E = net.edgeCount, N = net.nodeCount
			const count = E + MAX_PUDDLES
			this.edgeCount = E
			this.nodeCount = N
			this.geo = new Float32Array(count * 4)
			this.aux = new Float32Array(count * 4)
			this.dyn = new ArrayBuffer(count * 16)
			this.dynF = new Float32Array(this.dyn)
			this.dynU = new Uint16Array(this.dyn)
			this.dynBytes = new Uint8Array(this.dyn)
			this.qMean = new Float32Array(E)
			this.qAbs = new Float32Array(E)
			this.ghost = new Float32Array(E)
			this.phase = new Float32Array(E)
			this.dir = new Int8Array(E)
			this.mid = new Float32Array(E) // crawl distance at the middle of each tube
			const {x, y, a, b} = net
			for (let e = 0; e < E; e++) {
				this.geo.set([x[a[e]], y[a[e]], x[b[e]], y[b[e]]], e * 4)
				this.aux[e * 4 + 2] = hash(e + 1) / 4294967296
			}
			for (let k = 0; k < MAX_PUDDLES; k++) this.aux[(E + k) * 4 + 3] = 1
			// node -> tubes
			const start = new Int32Array(N + 1)
			for (let e = 0; e < E; e++) start[a[e] + 1]++, start[b[e] + 1]++
			for (let i = 0; i < N; i++) start[i + 1] += start[i]
			const fill = start.slice(0, N)
			const list = new Int32Array(2 * E)
			for (let e = 0; e < E; e++) (list[fill[a[e]]++] = e), (list[fill[b[e]]++] = e)
			this.adjStart = start
			this.adjEdge = list

			if (this.vao) {
				gl.deleteVertexArray(this.vao)
				for (const buf of [this.geoBuf, this.auxBuf, this.dynBuf]) gl.deleteBuffer(buf)
			}
			const buffer = (data, usage) => {
				const buf = gl.createBuffer()
				gl.bindBuffer(gl.ARRAY_BUFFER, buf)
				gl.bufferData(gl.ARRAY_BUFFER, data, usage)
				return buf
			}
			this.vao = gl.createVertexArray()
			gl.bindVertexArray(this.vao)
			this.geoBuf = buffer(this.geo, gl.STATIC_DRAW)
			gl.enableVertexAttribArray(0)
			gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0)
			gl.vertexAttribDivisor(0, 1)
			this.auxBuf = buffer(this.aux, gl.STATIC_DRAW)
			gl.enableVertexAttribArray(1)
			gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0)
			gl.vertexAttribDivisor(1, 1)
			this.dynBuf = buffer(this.dyn.byteLength, gl.DYNAMIC_DRAW)
			gl.enableVertexAttribArray(2)
			gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 16, 0)
			gl.vertexAttribDivisor(2, 1)
			gl.enableVertexAttribArray(3)
			gl.vertexAttribPointer(3, 2, gl.UNSIGNED_SHORT, true, 16, 12)
			gl.vertexAttribDivisor(3, 1)
			gl.bindVertexArray(null)
			gl.bindBuffer(gl.ARRAY_BUFFER, null)
			this.net = net
			this.puddles = []
			this.reset(net)
		}

		// Optional: the oat flakes as the page keeps them ({x, y, alive}), so the
		// slime on each sits right under it. Without this the puddles sit on the
		// mesh node nearest each flake.
		setFlakes(list) {
			this.flakeList = list ? list.map((f) => ({x: f.x, y: f.y, alive: !!f.alive})) : null
			this.flakeKey = null
		}

		reset(net) {
			this.qMean.fill(0)
			this.qAbs.fill(0)
			this.ghost.fill(0)
			this.phase.fill(0)
			const E = this.edgeCount
			const arr = net.arrival
			const at = (i) => (arr && Number.isFinite(arr[i]) ? arr[i] : 0)
			for (let e = 0; e < E; e++) {
				const p = at(net.a[e]), q = at(net.b[e])
				this.aux[e * 4] = p
				this.aux[e * 4 + 1] = q
				this.dir[e] = q >= p ? 1 : -1
				this.mid[e] = 0.5 * (p + q)
			}
			this.flakeKey = null
			this.syncPuddles(net)
			this.modelTime = net.time || 0
			this.start = net.start
			this.snap = true
			this.exploredClear = true
		}

		// the slime on the oat flakes it has reached
		syncPuddles(net) {
			const flakes = Array.isArray(net.flakes) ? net.flakes : []
			let key = ''
			for (let i = 0; i < flakes.length && i < MAX_PUDDLES; i++) {
				const f = flakes[i]
				const place = this.flakeList && this.flakeList[i]
				key += `${f.alive && f.node >= 0 ? f.node : -1}:${place ? place.x.toFixed(1) + ',' + place.y.toFixed(1) : ''};`
			}
			if (key === this.flakeKey) return
			this.flakeKey = key
			this.puddles = []
			const E = this.edgeCount
			for (let i = 0; i < flakes.length && this.puddles.length < MAX_PUDDLES; i++) {
				const f = flakes[i]
				if (!f.alive || !(f.node >= 0)) continue
				const place = this.flakeList && this.flakeList[i]
				const px = place ? place.x : net.x[f.node], py = place ? place.y : net.y[f.node]
				const k = this.puddles.length
				this.puddles.push({node: f.node})
				this.geo.set([px, py, px, py], (E + k) * 4)
				const arr = net.arrival && Number.isFinite(net.arrival[f.node]) ? net.arrival[f.node] : 0
				this.aux.set([arr, arr, hash(k + 77) / 4294967296, 1], (E + k) * 4)
			}
			const gl = this.gl
			gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf)
			gl.bufferSubData(gl.ARRAY_BUFFER, E * 16, this.geo, E * 4, MAX_PUDDLES * 4)
			gl.bindBuffer(gl.ARRAY_BUFFER, this.auxBuf)
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.aux)
			gl.bindBuffer(gl.ARRAY_BUFFER, null)
		}

		// Every frame, after the model has stepped.
		update(net) {
			if (net !== this.net || net.edgeCount !== this.edgeCount) this.setMesh(net)
			const again = net.time < this.modelTime - 1e-9 || net.start !== this.start
			if (again) this.reset(net)
			else this.syncPuddles(net)
			this.net = net
		}

		// Everything that changes from frame to frame goes into one buffer.
		pack(seconds, still) {
			const net = this.net
			const P = this.params
			const E = this.edgeCount
			const {D, born, alive, a, b, flow} = net
			const flux = net.flux && net.flux.length === E ? net.flux : null
			const minD = (net.params && net.params.minD) || 1e-4
			const {dynF, dynU, qMean, qAbs, ghost, phase, dir, mid} = this

			let dt = this.lastClock === null ? 0 : seconds - this.lastClock
			if (!(dt > 0)) dt = 0
			if (dt > 0.1) dt = 0.1
			this.lastClock = seconds
			const modelDt = Math.max(0, net.time - this.modelTime)
			this.modelTime = net.time
			const k = this.snap ? 1 : Math.max(1 - Math.exp(-dt / P.smoothing), 1 - Math.exp(-modelDt / P.smoothingModel))
			const keep = Math.exp(-modelDt / P.ghostFade)
			const Dref = this.Dref
			const rhoCut = Math.sqrt(Math.sqrt(P.witheredD / Dref))
			const clock = this.clockNow
			const omega = (2 * Math.PI) / P.pulse
			const waveK = (2 * Math.PI) / P.wave
			const move = still ? 0 : dt

			let maxD = 0
			for (let e = 0; e < E; e++) {
				const o = e * 4
				if (!(born[e] > 0) || !alive[a[e]] || !alive[b[e]]) {
					dynF[o] = -1
					continue
				}
				const d = D[e]
				if (d > maxD) maxD = d
				const Q = flux ? flux[e] : flow ? flow[e] * dir[e] : 0
				const mean = (qMean[e] += (Q - qMean[e]) * k)
				const mag = (qAbs[e] += (Math.abs(Q) - qAbs[e]) * k)
				const carries = smoothstep(P.flowLow, P.flowHigh, mag)
				const rho = Math.sqrt(Math.sqrt(Math.max(d, 0) / Dref))
				const mature = smoothstep(P.matureFrom, P.matureBy, net.time - born[e])
				const size = carries * mature * rho * smoothstep(rhoCut, rhoCut * 1.9, rho)
				const g = Math.max(ghost[e] * keep, Math.min(1, size))
				ghost[e] = g
				if (move > 0 && carries > 0.01 && mag > 0) {
					const speed = P.stream * (1 - Math.exp(-mag / Math.sqrt(Math.max(d, minD)) / P.streamRef))
					const bias = mean / mag
					const v = speed * (bias + (1 - 0.7 * Math.abs(bias)) * Math.sin(clock * omega - mid[e] * waveK))
					let ph = phase[e] + v * move
					if (ph >= WRAP) ph -= WRAP
					else if (ph < 0) ph += WRAP
					phase[e] = ph
				}
				dynF[o] = d
				dynF[o + 1] = born[e]
				dynF[o + 2] = phase[e]
				dynU[o * 2 + 6] = carries * 65535
				dynU[o * 2 + 7] = g * 65535
			}
			const target = Math.max(maxD, (net.params && net.params.fresh) || 0.05, 1e-3)
			this.Dref = this.snap ? target : Dref + (target - Dref) * k
			this.snap = false

			// puddles: the slime on reached oat flakes
			const {adjStart, adjEdge} = this
			for (let i = 0; i < this.puddles.length; i++) {
				const node = this.puddles[i].node
				const o = (E + i) * 4
				if (!alive[node]) {
					dynF[o] = -1
					continue
				}
				let t0 = Infinity
				for (let j = adjStart[node]; j < adjStart[node + 1]; j++) {
					const t = born[adjEdge[j]]
					if (t > 0 && t < t0) t0 = t
				}
				dynF[o] = P.puddle
				dynF[o + 1] = t0 < Infinity ? t0 : Math.max(net.time, 1e-6)
				dynF[o + 2] = 0
				dynU[o * 2 + 6] = 65535
				dynU[o * 2 + 7] = 0
			}
			this.instances = E + this.puddles.length
			const gl = this.gl
			gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf)
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dynBytes, 0, this.instances * 16)
			gl.bindBuffer(gl.ARRAY_BUFFER, null)
		}

		// --- Drawing -------------------------------------------------------------

		ensureTarget() {
			const gl = this.gl
			const w = Math.max(1, this.canvas.width), h = Math.max(1, this.canvas.height)
			if (this.tubeTex && this.tubeSize[0] === w && this.tubeSize[1] === h) return
			if (this.tubeTex) {
				gl.deleteFramebuffer(this.tubeFbo)
				gl.deleteTexture(this.tubeTex)
			}
			this.tubeTex = this.texture(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, w, h)
			this.tubeFbo = this.framebuffer(this.tubeTex)
			this.tubeSize = [w, h]
		}

		setInstanceUniforms(prog, scale, motion) {
			const gl = this.gl
			const P = this.params
			const u = prog.u
			gl.uniform2f(u.u_sim, this.width, this.height)
			gl.uniform1f(u.u_scale, scale)
			gl.uniform1f(u.u_time, this.net.time)
			gl.uniform1f(u.u_clock, this.clockNow)
			gl.uniform1f(u.u_motion, motion)
			const rhoRef = Math.sqrt(Math.sqrt(this.Dref))
			gl.uniform4f(u.u_tube, P.tubeRadius, rhoRef, Math.sqrt(Math.sqrt(P.witheredD / this.Dref)), P.freshRadius)
			gl.uniform4f(u.u_life, P.veinFade, P.breathe, (2 * Math.PI) / P.pulse, (2 * Math.PI) / P.wave)
			gl.uniform2f(u.u_mature, P.matureFrom, P.matureBy)
		}

		// seconds: a clock for the slow life in the tubes. {still: true} holds
		// everything that moves on its own (prefers-reduced-motion). view:
		// {x, y, zoom}, the map point shown at the centre of the canvas and how
		// far to zoom in (1: the whole map fits). See DishRenderer.viewMatrix.
		render(seconds = 0, opts = {}) {
			const gl = this.gl
			const P = this.params
			const still = !!(opts && opts.still)
			const t0 = performance.now()
			this.ensureTarget()
			this.uploadEnv()
			if (this.clock0 === null) this.clock0 = seconds
			// keep the clock small, so it stays precise as a float
			this.clockNow = (seconds - this.clock0) % (P.pulse * 1000)
			const net = this.net
			if (net) this.pack(seconds, still)
			this.cpuMs = performance.now() - t0

			const [w, h] = this.tubeSize
			const m = DishRenderer.viewMatrix(opts && opts.view, w, h, this.width, this.height)
			const scale = m[0]
			const cx = (w / 2 - m[4]) / scale, cy = (h / 2 - m[5]) / scale
			const tap = Math.min(3.5, Math.max(1, 0.8 * scale))
			const margin = tap + 2
			gl.disable(gl.DEPTH_TEST)
			gl.disable(gl.CULL_FACE)

			if (net && this.exploredClear) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, this.exploredFbo)
				gl.clearColor(0, 0, 0, 0)
				gl.clear(gl.COLOR_BUFFER_BIT)
				this.exploredAfter = -1
				this.exploredClear = false
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.trackFbo)
			gl.clearColor(0, 0, 0, 0)
			gl.clear(gl.COLOR_BUFFER_BIT)

			if (net && this.instances > 0) {
				gl.bindVertexArray(this.vao)
				gl.enable(gl.BLEND)
				gl.blendEquation(gl.MAX)
				gl.viewport(0, 0, this.width, this.height)

				// 1. everywhere the slime has been, adding what grew since last time
				const time = Math.fround(net.time)
				if (time > this.exploredAfter) {
					const ex = this.programs.explored
					gl.bindFramebuffer(gl.FRAMEBUFFER, this.exploredFbo)
					gl.useProgram(ex.p)
					this.setInstanceUniforms(ex, 1, 0)
					gl.uniform1f(ex.u.u_bornAfter, this.exploredAfter)
					gl.uniform1f(ex.u.u_reach, P.exploreRadius)
					gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instances)
					this.exploredAfter = time
				}

				// 2. fresh sheet, withered marks, soft tubes
				const tr = this.programs.track
				gl.bindFramebuffer(gl.FRAMEBUFFER, this.trackFbo)
				gl.useProgram(tr.p)
				this.setInstanceUniforms(tr, 1, 0)
				gl.uniform4f(tr.u.u_track, P.filmRadius, P.filmFade, 4, 0)
				gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instances)
			}

			// 3. the tubes, at screen size
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.tubeFbo)
			gl.viewport(0, 0, w, h)
			gl.clearBufferfv(gl.COLOR, 0, [-margin, 0, 0, 0])
			if (net && this.instances > 0) {
				const tu = this.programs.tube
				gl.useProgram(tu.p)
				this.setInstanceUniforms(tu, scale, still ? 0 : 1)
				gl.uniform4f(tu.u.u_view, cx, cy, scale, 0)
				gl.uniform2f(tu.u.u_canvas, w, h)
				gl.uniform1f(tu.u.u_minPx, P.minPx)
				gl.uniform1f(tu.u.u_margin, margin)
				gl.activeTexture(gl.TEXTURE0)
				gl.bindTexture(gl.TEXTURE_2D, this.noiseTex)
				gl.uniform1i(tu.u.u_noise, 0)
				gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instances)
			}
			gl.disable(gl.BLEND)
			gl.blendEquation(gl.FUNC_ADD)

			// 4. the dish
			const d = this.programs.dish
			const pal = this.palette
			gl.bindFramebuffer(gl.FRAMEBUFFER, null)
			gl.viewport(0, 0, w, h)
			gl.useProgram(d.p)
			const textures = [this.tubeTex, this.trackTex, this.exploredTex, this.envTex, this.noiseTex]
			const names = ['u_tubes', 'u_track', 'u_explored', 'u_env', 'u_noise']
			for (let i = 0; i < textures.length; i++) {
				gl.activeTexture(gl.TEXTURE0 + i)
				gl.bindTexture(gl.TEXTURE_2D, textures[i])
				gl.uniform1i(d.u[names[i]], i)
			}
			gl.uniform2f(d.u.u_canvas, w, h)
			gl.uniform2f(d.u.u_sim, this.width, this.height)
			gl.uniform4f(d.u.u_view, cx, cy, scale, 0)
			gl.uniform1f(d.u.u_dark, pal.dark ? 1 : 0)
			gl.uniform1f(d.u.u_tap, tap)
			gl.uniform1f(d.u.u_margin, margin)
			gl.uniform1f(d.u.u_rMax, P.tubeRadius)
			for (const key of ['bench', 'rim', 'dish', 'park', 'outside', 'light', 'trace', 'slime', 'core']) {
				gl.uniform3fv(d.u['u_' + key], pal[key])
			}
			gl.bindVertexArray(this.emptyVao)
			gl.drawArrays(gl.TRIANGLES, 0, 3)
			gl.bindVertexArray(null)
			gl.activeTexture(gl.TEXTURE0)
		}

		// Counts for tests and tuning; walks every tube, so not for every frame.
		stats() {
			const net = this.net
			if (!net) return null
			const P = this.params
			const E = this.edgeCount
			const scale = Math.min(this.tubeSize[0] / this.width, this.tubeSize[1] / this.height) || 1
			const rhoRef = Math.sqrt(Math.sqrt(this.Dref))
			const rhoCut = Math.sqrt(Math.sqrt(P.witheredD / this.Dref))
			let grown = 0, tubes = 0, veins = 0, fragments = 0
			for (let e = 0; e < E; e++) {
				const o = e * 4
				const d = this.dynF[o]
				if (d < 0) continue
				grown++
				const age = Math.max(0, net.time - this.dynF[o + 1])
				const carries = this.dynU[o * 2 + 6] / 65535
				const rho = Math.sqrt(Math.sqrt(d)) / rhoRef
				const rNet = P.tubeRadius * rho * smoothstep(rhoCut, rhoCut * 1.9, rho)
				const len = Math.hypot(this.geo[o + 2] - this.geo[o], this.geo[o + 3] - this.geo[o + 1])
				const along = Math.min(1, Math.abs(this.aux[o + 1] - this.aux[o]) / Math.max(len, 1e-3))
				const vein = P.freshRadius * (0.15 + 0.85 * smoothstep(0.3, 0.9, along)) * Math.exp(-age / P.veinFade)
				const r = Math.max(vein, rNet * carries * smoothstep(P.matureFrom, P.matureBy, age))
				if (r * scale < 0.04) continue
				if (r > vein) tubes++
				else veins++
				const ext = Math.max(r * scale, P.minPx) + Math.min(2, Math.max(1, 0.8 * scale)) + 2
				fragments += (len * scale + 2 * ext) * 2 * ext
			}
			return {grown, tubes, veins, tubeFragments: Math.round(fragments), instances: this.instances, Dref: this.Dref, cpuMs: this.cpuMs}
		}
	}

	DishRenderer.DEFAULTS = DEFAULTS

	// The view as a Canvas2D transform from map px to device px:
	//   ctx.setTransform(...DishRenderer.viewMatrix(view, canvas.width, canvas.height))
	// then draw in map px. A point on the canvas (device px) back on the map:
	//   x = (cx - m[4]) / m[0], y = (cy - m[5]) / m[3]
	// view: {x, y, zoom}, the map point at the centre of the canvas and the
	// zoom (1: the whole map fits, as without a view).
	DishRenderer.viewMatrix = (view, canvasWidth, canvasHeight, width = 1024, height = width) => {
		const zoom = view && view.zoom > 0 ? view.zoom : 1
		const x = view && Number.isFinite(view.x) ? view.x : width / 2
		const y = view && Number.isFinite(view.y) ? view.y : height / 2
		const s = Math.min(canvasWidth / width, canvasHeight / height) * zoom
		return [s, 0, 0, s, canvasWidth / 2 - x * s, canvasHeight / 2 - y * s]
	}

	return DishRenderer
})()
