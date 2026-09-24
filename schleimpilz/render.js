'use strict'

// The dish: a glass petri dish on the lab bench, agar lit through a mask the
// way Tero et al. (2010) lit theirs, and the slime's tubes growing on it.
//
// A frame is four draws:
//  1. explored, at map size and kept from frame to frame: everywhere the
//     slime has been. Only tubes grown since the last frame are added.
//  2. track, at half map size: the sheet of protoplasm the tubes grow out
//     of, the growing margin, faint marks where tubes have withered, and a
//     soft copy of the living tubes that their glow is made from.
//  3. tubes, at screen size: every living tube as a capsule. Blending keeps
//     the largest value of each channel, so tubes that meet become one smooth
//     surface, like one organism. Channels: signed distance to the nearest
//     tube wall, height of the round cross-section, the tube's radius, and
//     the granules streaming inside it.
//  4. the dish itself: agar lit through the mask, the slime glowing on it,
//     and the glass. Outside the glass the canvas stays transparent, with
//     only a faint contact shadow, so the page shows through.
//
// Everything is plain WebGL2 and needs EXT_color_buffer_float.

const DishRenderer = (() => {
	const MAX_PUDDLES = 64
	const COLORS = ['bench', 'rim', 'dish', 'park', 'outside', 'light', 'trace', 'slime', 'core']
	const COLOR_UNIFORMS = COLORS.map((key) => 'u_' + key)
	const DISH_TEXTURES = [
		['tubeTex', 'u_tubes'],
		['trackTex', 'u_track'],
		['exploredTex', 'u_explored'],
		['envTex', 'u_env'],
		['noiseTex', 'u_noise'],
	]
	const GRANULE = 2.6 // map px, length of a granule along a tube
	const WRAP = GRANULE * 64 // the granule pattern repeats after this many map px

	const DEFAULTS = {
		tubeRadius: 3.6, // map px, radius of a tube with conductivity refD
		refD: 2, // conductivity of the thickest trunks
		contrast: 0.5, // radius goes as (D / refD)^contrast; 0.25 would be Poiseuille, 0.5 sets trunks apart
		veinD: 0.15, // conductivity from which a tube shows as a vein, fully from 2.8 times that
		matureFrom: 1, // model time from which a tube starts to show, which is when the tubes nobody uses have thinned...
		matureBy: 2.5, // ...and by which it has its full width
		sheetFloor: 0.003, // conductivity from which the mesh carries a sheet of protoplasm...
		sheetD: 0.06, // ...and at which the sheet is whole; above that it gathers into brighter channels
		sheetRadius: 6.5, // map px
		youthFade: 0.3, // model time over which the growing margin glows
		exploreRadius: 5.5, // map px
		flowLow: 0.002, // smoothed |Q| from which a tube counts as carrying flow...
		flowHigh: 0.02, // ...and from which it fully does
		puddle: 8.5, // map px, radius of the slime on an oat flake
		ghostFade: 12, // model time for the mark of a withered tube to fade
		wetFade: 2.5, // model time for the track the slime leaves to dry
		smoothPaths: 4, // rounds of smoothing that turn the mesh's zigzags into curves
		breathe: 0.04, // how much tubes widen and narrow with each pulse
		pulse: 5.5, // seconds per pulse
		wave: 240, // crawl distance per wavelength of the pulse
		stream: 5, // map px per second, the fastest streaming
		streamRef: 1.5, // flow per sqrt(conductivity) at which streaming gets fast
		smoothing: 1.2, // seconds over which the flow is averaged
		smoothingModel: 0.3, // same, in model time
		minPx: 0.7, // device px, radius of the thinnest drawn line
		rimInset: 5, // map px between the edge of the map and the glass
		wall: 7, // map px, the glass wall seen from above
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
uniform vec4 u_tube; // radius at refD, refD, vein threshold, contrast
uniform vec4 u_life; // margin fade, breathing, pulse rate, pulse wavenumber
uniform vec2 u_mature; // model time from which a tube starts to show, and by which it has

const vec4 NOWHERE = vec4(-2.0, -2.0, 0.0, 1.0);

// A tube's radius in map px. Conductivity goes with the fourth power of the
// radius; drawn with its square root the trunks stand out from the branches.
// A tube shows once it is strong enough to be a vein, carries flow and has
// had a little while to build its walls; until then its protoplasm is part
// of the sheet (see the track pass).
float radiusOf(out float youth) {
	youth = 0.0;
	float born = a_dyn.y;
	if (born <= 0.0 || a_dyn.x < 0.0) return 0.0;
	float age = max(u_time - born, 0.0);
	youth = exp(-age / u_life.x);
	if (a_aux.w > 0.5) return a_dyn.x * smoothstep(0.0, 0.4, age);
	float D = a_dyn.x;
	float vein = smoothstep(u_tube.z, u_tube.z * 2.8, D);
	return u_tube.x * pow(D / u_tube.y, u_tube.w) * vein * a_flow.x * smoothstep(u_mature.x, u_mature.y, age);
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
	float wobble = texture(u_noise, v_world * (puddle ? 0.009 : 0.0045)).g - 0.5;
	float r = v_a.y * (1.0 + (puddle ? 0.3 : 0.22) * wobble);
	vec2 q = vec2(v_local.x - clamp(v_local.x, 0.0, len), v_local.y);
	float sdf = (r - length(q)) * u_scale;
	if (sdf < -u_margin) discard;
	float rpx = r * u_scale;
	float s = clamp(sdf, 0.0, rpx);
	float h = sqrt(s * (2.0 * rpx - s)); // a round cross-section
	if (puddle) h = min(h * 0.45, 2.2 * u_scale); // puddles are flat
	// granules in the streaming protoplasm, carried along by the offset
	vec2 cell = vec2((v_local.x - v_a.w) / ${GRANULE.toFixed(2)}, v_local.y / max(0.8 * r, 0.4));
	float grain = texture(u_noise, cell * (4.0 / 256.0) + v_b.x).g;
	// a puddle reads as a thick tube, not as the thickest there is
	float shown = puddle ? min(v_a.z, 1.7 * u_scale) : v_a.z;
	o = vec4(sdf, h, sdf > 0.0 ? shown : 0.0, grain * h);
}`

	const VS_TRACK = `#version 300 es
precision highp float;
${INSTANCE}
uniform vec4 u_track; // sheet radius, conductivity of a whole sheet, softness of the glow, sheet floor
out vec2 v_local;
flat out vec4 v_a; // length, sheet, mark of a withered tube, radius
flat out float v_young;
void main() {
	float youth;
	float r = radiusOf(youth);
	float grown = a_dyn.y > 0.0 && a_dyn.x >= 0.0 ? 1.0 : 0.0;
	float tube = grown * (1.0 - a_aux.w);
	// protoplasm spread over the mesh, as much as the conductivity says;
	// where it has gathered into a vein, less of it is left around
	// a thin film over most of it, and bright channels where more flows
	float D = a_dyn.x;
	float sheet = tube * (0.5 * smoothstep(u_track.w, u_track.y, D) + 0.5 * smoothstep(u_track.y, 0.3, D)) * (1.0 - smoothstep(0.15, 0.7, r));
	float ghost = grown * a_flow.y;
	float young = tube * youth;
	float ext = 0.0;
	if (sheet > 0.01 || young > 0.01) ext = u_track.x;
	if (ghost > 0.02) ext = max(ext, 3.0);
	if (r > 0.15) ext = max(ext, 1.6 * r + u_track.z);
	if (ext <= 0.0) {
		gl_Position = NOWHERE;
		return;
	}
	vec2 local;
	float len;
	vec2 p = corner(ext, local, len);
	v_local = local;
	v_a = vec4(len, sheet, ghost, r);
	v_young = young;
	gl_Position = clipOf(p);
}`

	const FS_TRACK = `#version 300 es
precision highp float;
in vec2 v_local;
flat in vec4 v_a;
flat in float v_young;
uniform vec4 u_track;
out vec4 o;
void main() {
	float d = length(vec2(v_local.x - clamp(v_local.x, 0.0, v_a.x), v_local.y));
	float k = 1.0 - smoothstep(u_track.x * 0.3, u_track.x, d);
	float gw = 0.7 + 1.1 * v_a.z;
	float ghost = v_a.z * (1.0 - smoothstep(gw * 0.25, gw, d));
	float r = v_a.w;
	float g = max(d - 0.5 * r, 0.0) / (0.5 * r + 0.45 * u_track.z);
	float soft = r > 0.0 ? exp(-g * g) * min(1.0, r / 1.4) : 0.0;
	o = vec4(v_a.y * k, ghost, soft, v_young * k);
}`

	const VS_EXPLORED = `#version 300 es
precision highp float;
${INSTANCE}
uniform float u_bornAfter;
uniform float u_reach;
out vec2 v_local;
flat out float v_len;
flat out float v_born;
flat out vec2 v_arrival;
void main() {
	v_born = a_dyn.y;
	v_arrival = a_aux.xy;
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
flat in float v_born;
flat in vec2 v_arrival;
uniform float u_reach;
out vec4 o;
// r: how surely the slime has been here, g: when, b: how far it crawled to get here
void main() {
	float t = clamp(v_local.x, 0.0, v_len);
	float d = length(vec2(v_local.x - t, v_local.y));
	float k = 1.0 - smoothstep(u_reach * 0.3, u_reach, d);
	float arrival = mix(v_arrival.x, v_arrival.y, v_len > 0.0 ? t / v_len : 0.0);
	o = vec4(k, k > 0.3 ? v_born : 0.0, k > 0.3 ? arrival : 0.0, 0.0);
}`

	const FS_DISH = `#version 300 es
precision highp float;
uniform sampler2D u_tubes; // screen size: distance to wall, height, radius, granules * height
uniform sampler2D u_track; // half map size, with mipmaps: sheet, withered marks, soft tubes, growing margin
uniform sampler2D u_explored; // map size: where the slime has been, when, and how far it crawled
uniform sampler2D u_env; // map size: light you shine, parkland, outside the city, mottling
uniform sampler2D u_noise;
uniform vec2 u_canvas;
uniform vec2 u_sim;
uniform vec4 u_view; // map point at the centre of the canvas, device px per map px
uniform float u_tap; // device px from the centre to each of four smoothing taps
uniform float u_margin;
uniform float u_rMax;
uniform float u_time;
uniform float u_wetFade;
uniform vec4 u_beat; // pulse rate, pulse wavenumber, clock, motion
uniform vec4 u_glass; // gap between map edge and glass, wall, hairline (device px), 0
uniform vec3 u_bench, u_rim, u_dish, u_park, u_outside, u_light, u_trace, u_slime, u_core;
out vec4 o;

// towards the light, in map coordinates (y down): up and to the left
const vec2 LAMP = vec2(-0.6, -0.8);

vec3 screen(vec3 a, vec3 b) {
	return 1.0 - (1.0 - a) * (1.0 - b);
}

// how much of a pixel px wide a line w wide covers, d from its middle
float hairline(float d, float w, float px) {
	float a = max(-0.5 * w, d - 0.5 * px), b = min(0.5 * w, d + 0.5 * px);
	return clamp((b - a) / px, 0.0, 1.0);
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
	float R = 0.5 * min(u_sim.x, u_sim.y) - u_glass.x; // outer edge of the glass
	float inner = R - u_glass.y; // inner edge of the glass, where the agar ends
	float facing = dot(outward, LAMP); // +1 on the side of the dish nearest the light
	float hair = max(u_glass.z * px, 0.35); // hairline, map px

	// --- the agar, lit through the mask: brighter means more light ------------
	vec4 env = texture(u_env, puv);
	vec4 far = textureLod(u_env, puv, 4.5);
	vec3 agar = mix(u_dish, u_park, env.g);
	agar = mix(agar, u_outside, env.b);
	// light scatters in the agar: a faint cool haze over what is lit
	vec3 cool = mix(u_outside, u_light, 0.65);
	agar += cool * (0.07 * far.b * far.b + 0.03 * far.g);
	// light you shine: a pool of it, with a soft bloom around
	float lamp = smoothstep(0.0, 0.9, textureLod(u_env, puv, 1.2).r);
	float bloom = 0.5 * textureLod(u_env, puv, 3.0).r + 0.5 * far.r;
	agar = mix(agar, u_light, lamp * 0.85);
	agar += u_light * bloom * 0.28;
	// a very fine grain, and the faintest unevenness
	float grain = texture(u_noise, p * 0.021).r - 0.5;
	agar += vec3(0.011 * grain + 0.007 * (env.a - 0.5));
	// the agar darkens where it meets the glass
	float m = inner - rr;
	agar *= 1.0 - 0.3 * exp(-max(m, 0.0) / 9.0);

	// --- the slime ----------------------------------------------------------
	vec3 ew = textureLod(u_explored, uv, 1.6).rgb;
	float lobe = texture(u_noise, p * 0.0036).g - 0.5;
	float explored = smoothstep(0.42, 0.58, ew.r + 0.3 * lobe);
	float wet = exp(-max(u_time - textureLod(u_explored, uv, 2.5).g, 0.0) / u_wetFade);
	// the track it leaves, barely there
	agar = mix(agar, u_trace, explored * (0.65 + 0.35 * wet));
	// the slow pulse that runs out from where it started, through all of it
	float beat = u_beat.w * cos(u_beat.z * u_beat.x - ew.b * u_beat.y) * explored;
	vec4 tr = mix(textureLod(u_track, uv, 0.7), textureLod(u_track, uv, 1.8), 0.45);
	vec3 gold = u_slime;
	vec3 hot = u_core;
	agar += gold * tr.g * 0.03; // marks of tubes that withered
	// the sheet it spreads as: a veil of light, brightest at the growing margin
	float sheet = smoothstep(0.03, 0.95, tr.r) * explored;
	float young = smoothstep(0.0, 0.8, tr.a) * explored;
	vec3 veil = mix(gold, hot, 0.2);
	float glowSheet = textureLod(u_track, uv, 3.0).r * explored;
	agar += mix(gold, hot, 0.3 * sheet) * (0.2 * sheet + 0.22 * young * young) * (1.0 + 0.2 * beat);
	agar = screen(agar, gold * 0.1 * glowSheet * glowSheet);
	// light from the tubes: a close glow and a wide one
	float near = textureLod(u_track, uv, 1.3).b;
	float wide = textureLod(u_track, uv, 3.4).b;
	agar = screen(agar, gold * (0.3 * near + 0.3 * wide) * (1.0 + 0.12 * beat));

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
		vec2 slope = vec2(B.g + D.g - A.g - C.g, C.g + D.g - A.g - B.g) / (4.0 * u_tap);
		vec3 n = normalize(vec3(-slope * 0.85, 1.0));
		vec3 H = normalize(normalize(vec3(LAMP.x, -LAMP.y, 1.2)) + vec3(0.0, 0.0, 1.0));
		float q = clamp(1.0 - T.r / max(rpx, 0.8), 0.0, 1.0); // 0 along the middle, 1 at the wall
		float thick = smoothstep(0.35, u_rMax, rs);
		// light: gold, with a hot line along the middle of the thicker tubes
		float core = pow(max(1.0 - q * q, 0.0), 4.0);
		vec3 tube = gold * mix(0.72, 1.0, thick) * (1.0 - 0.28 * q * q);
		tube = mix(tube, hot, core * mix(0.2, 0.85, thick));
		// packets of light streaming along
		float grains = T.a / max(T.g, 1e-3);
		tube *= 1.0 + 0.16 * (grains - 0.5) * smoothstep(0.5, 1.5, rs);
		tube *= 1.0 + 0.1 * beat;
		float alpha = cover * (1.0 - exp(-(0.8 + 2.0 * rs))) * (1.0 - 0.5 * pow(q, 2.5));
		col = mix(agar, tube, alpha);
		// the wet skin catches the light, just
		float spec = pow(max(dot(n, H), 0.0), 60.0) * smoothstep(1.0, 2.6, rs);
		col = screen(col, vec3(0.86, 0.92, 1.0) * spec * cover * 0.2);
	}
	// light you shine pales the slime a little
	col = mix(col, screen(col, u_light * 0.3), lamp);

	// --- the glass: a machined ring ----------------------------------------
	// seen from above the wall is a dark band; a faint light lives in it
	float x = clamp((rr - inner) / (R - inner), 0.0, 1.0);
	vec3 glass = mix(u_bench, u_rim, 0.12 + 0.06 * (1.0 - x));
	float kGlass = smoothstep(inner - 0.5 * px, inner + 0.5 * px, rr);
	vec3 inside = mix(col, glass, kGlass);
	// a faint sheen on the lid, towards the light
	inside = screen(inside, vec3(0.022 * smoothstep(0.1, 1.0, facing) * smoothstep(0.3 * R, R, rr)));
	// hairlines: the outer edge bright, where the light catches it brightest;
	// the inner edge faint, with a faint reflection on the far side
	float arc = smoothstep(0.3, 1.0, facing);
	float outerLine = hairline(rr - (R - 0.5 * hair), hair, px);
	float innerLine = hairline(rr - (inner + 0.5 * hair), hair, px);
	float echo = hairline(rr - (inner - 3.0 * hair), hair, px) * smoothstep(0.35, 1.0, -facing);
	float white = outerLine * (0.16 + 0.55 * arc) + innerLine * (0.07 + 0.08 * arc) + echo * 0.07;
	inside = mix(inside, vec3(1.0), white);

	// outside the glass the page shows through: only the dish's contact shadow
	// and the faintest light around the rim
	float d = rr - R;
	float shadowA = 0.55 * (1.0 - smoothstep(0.0, u_glass.x, d)) * (0.85 + 0.15 * smoothstep(-1.0, 0.2, facing));
	float halo = 0.045 * exp(-max(d, 0.0) / (hair + 1.5 * px));
	vec4 outer = vec4(u_bench * shadowA + vec3(halo), min(1.0, shadowA + halo));
	float kDisc = 1.0 - smoothstep(R - 0.5 * px, R + 0.5 * px, rr);
	vec4 res = mix(outer, vec4(inside, 1.0), kDisc);
	// dither away the banding in the dark gradients
	res.rgb += (fract(52.9829189 * fract(dot(frag, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0 * res.a;
	o = vec4(clamp(res.rgb, 0.0, res.a), res.a);
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

	// Distance to the nearest border between random cells, which tiles: small
	// on the borders, so thresholding it draws a lace of irregular polygons.
	function cellBorders(size, cell, seed) {
		const n = size / cell
		const fx = new Float32Array(n * n), fy = new Float32Array(n * n)
		for (let i = 0; i < n * n; i++) {
			fx[i] = ((i % n) + 0.12 + 0.76 * (hash(i * 2 + seed * 7717) / 4294967296)) * cell
			fy[i] = (Math.floor(i / n) + 0.12 + 0.76 * (hash(i * 2 + 1 + seed * 7717) / 4294967296)) * cell
		}
		const out = new Float32Array(size * size)
		for (let y = 0; y < size; y++) {
			const cy = Math.floor(y / cell)
			for (let x = 0; x < size; x++) {
				const cx = Math.floor(x / cell)
				let f1 = Infinity, f2 = Infinity
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						const i = cx + dx, j = cy + dy
						const k = ((j + n) % n) * n + ((i + n) % n)
						const px = fx[k] + (i - ((i + n) % n)) * cell, py = fy[k] + (j - ((j + n) % n)) * cell
						const d = Math.hypot(x + 0.5 - px, y + 0.5 - py)
						if (d < f1) (f2 = f1), (f1 = d)
						else if (d < f2) f2 = d
					}
				}
				out[y * size + x] = f2 - f1
			}
		}
		return out
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
			// transparent outside the glass, so the page shows through
			const gl = canvas.getContext('webgl2', {
				alpha: true,
				antialias: false,
				depth: false,
				stencil: false,
				premultipliedAlpha: true,
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

			// r fine grain, g smooth wobble, b granules, a lace of cell borders
			const S = 256
			const fine = valueNoise(S, 2, 4), fine2 = valueNoise(S, 4, 5), gran = valueNoise(S, 4, 6), gran2 = valueNoise(S, 2, 7)
			const soft = valueNoise(S, 16, 8), soft2 = valueNoise(S, 8, 9)
			const lace = cellBorders(S, 8, 10)
			const noise = new Uint8Array(S * S * 4)
			for (let i = 0; i < S * S; i++) {
				const g = smoothstep(0.3, 0.8, 0.7 * gran[i] + 0.3 * gran2[i])
				noise[i * 4] = Math.round(255 * (0.6 * fine[i] + 0.4 * fine2[i]))
				noise[i * 4 + 1] = Math.round(255 * Math.min(1, Math.max(0, (0.65 * soft[i] + 0.35 * soft2[i] - 0.5) * 1.7 + 0.5)))
				noise[i * 4 + 2] = Math.round(255 * g)
				noise[i * 4 + 3] = Math.round(255 * Math.min(1, lace[i] / 4))
			}
			this.noiseTex = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, S, S, {repeat: true, mipmaps: true, data: noise})

			this.exploredTex = this.texture(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, width, height, {mipmaps: true})
			this.exploredFbo = this.framebuffer(this.exploredTex)
			gl.generateMipmap(gl.TEXTURE_2D)
			this.trackSize = [Math.ceil(width / 2), Math.ceil(height / 2)]
			this.trackTex = this.texture(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, this.trackSize[0], this.trackSize[1], {mipmaps: true})
			this.trackFbo = this.framebuffer(this.trackTex)
			gl.generateMipmap(gl.TEXTURE_2D)
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
			this.maxD = 0
			this.cpuMs = 0
			this.viewOut = new Float64Array(6)
			this.clearTubes = new Float32Array(4)
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
			this.sizes = new Float32Array(E)
			this.visible = new Int32Array(E)
			// where each node is drawn: tubes through a node are smoothed into curves
			this.drawX = Float32Array.from(net.x)
			this.drawY = Float32Array.from(net.y)
			this.aimX = new Float32Array(N)
			this.aimY = new Float32Array(N)
			this.sumX = new Float32Array(N)
			this.sumY = new Float32Array(N)
			this.degree = new Uint8Array(N)
			this.pinned = new Uint8Array(N)
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
			this.drawX.set(net.x)
			this.drawY.set(net.y)
			this.geoDirty = true
			this.modelTime = net.time || 0
			this.start = net.start
			this.snap = true
			this.exploredClear = true
		}

		// Tubes run along a mesh, so a path zigzags from node to node. Where a
		// node carries just one tube through, draw it a little towards its
		// neighbours; a few rounds of that turn zigzags into curves. Junctions
		// and oat flakes stay put. Nodes glide to their new places.
		smoothPaths(count, snap) {
			const net = this.net
			const {visible, degree, pinned, aimX, aimY, sumX, sumY, drawX, drawY, geo} = this
			const {a, b} = net
			degree.fill(0)
			for (let i = 0; i < count; i++) degree[a[visible[i]]]++, degree[b[visible[i]]]++
			aimX.set(net.x)
			aimY.set(net.y)
			for (let round = 0; round < this.params.smoothPaths; round++) {
				sumX.fill(0)
				sumY.fill(0)
				for (let i = 0; i < count; i++) {
					const e = visible[i], p = a[e], q = b[e]
					sumX[p] += aimX[q]
					sumY[p] += aimY[q]
					sumX[q] += aimX[p]
					sumY[q] += aimY[p]
				}
				for (let i = 0; i < 2 * count; i++) {
					const e = visible[i >> 1]
					const n = i & 1 ? b[e] : a[e]
					if (degree[n] !== 2 || pinned[n] || sumX[n] === 0) continue
					aimX[n] = 0.5 * aimX[n] + 0.25 * sumX[n]
					aimY[n] = 0.5 * aimY[n] + 0.25 * sumY[n]
					sumX[n] = 0 // once per round
				}
			}
			const k = snap ? 1 : 0.12
			let moved = false
			for (let n = 0, N = this.nodeCount; n < N; n++) {
				const dx = aimX[n] - drawX[n], dy = aimY[n] - drawY[n]
				if (dx === 0 && dy === 0) continue
				if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
					drawX[n] = aimX[n]
					drawY[n] = aimY[n]
				} else {
					drawX[n] += dx * k
					drawY[n] += dy * k
				}
				moved = true
			}
			if (!moved && !this.geoDirty) return
			let lo = Infinity, hi = -1
			for (let e = 0, E = this.edgeCount; e < E; e++) {
				const o = e * 4, p = a[e], q = b[e]
				if (geo[o] === drawX[p] && geo[o + 1] === drawY[p] && geo[o + 2] === drawX[q] && geo[o + 3] === drawY[q]) continue
				geo[o] = drawX[p]
				geo[o + 1] = drawY[p]
				geo[o + 2] = drawX[q]
				geo[o + 3] = drawY[q]
				if (e < lo) lo = e
				hi = e
			}
			this.geoDirty = false
			if (hi < 0) return
			const gl = this.gl
			gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf)
			gl.bufferSubData(gl.ARRAY_BUFFER, lo * 16, geo, lo * 4, (hi - lo + 1) * 4)
			gl.bindBuffer(gl.ARRAY_BUFFER, null)
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
			this.pinned.fill(0)
			const E = this.edgeCount
			for (let i = 0; i < flakes.length && this.puddles.length < MAX_PUDDLES; i++) {
				const f = flakes[i]
				if (!f.alive || !(f.node >= 0)) continue
				this.pinned[f.node] = 1
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
			const {dynF, dynU, qMean, qAbs, ghost, phase, dir, mid, sizes, visible} = this
			let count = 0

			let dt = this.lastClock === null ? 0 : seconds - this.lastClock
			if (!(dt > 0)) dt = 0
			if (dt > 0.1) dt = 0.1
			this.lastClock = seconds
			const modelDt = Math.max(0, net.time - this.modelTime)
			this.modelTime = net.time
			const k = this.snap ? 1 : Math.max(1 - Math.exp(-dt / P.smoothing), 1 - Math.exp(-modelDt / P.smoothingModel))
			const keep = Math.exp(-modelDt / P.ghostFade)
			const clock = this.clockNow
			const omega = (2 * Math.PI) / P.pulse
			const waveK = (2 * Math.PI) / P.wave
			const move = still ? 0 : dt

			let maxD = 0
			for (let e = 0; e < E; e++) {
				const o = e * 4
				if (!(born[e] > 0) || !alive[a[e]] || !alive[b[e]]) {
					dynF[o] = -1
					sizes[e] = 0
					continue
				}
				const d = D[e]
				if (d > maxD) maxD = d
				const Q = flux ? flux[e] : flow ? flow[e] * dir[e] : 0
				const mean = (qMean[e] += (Q - qMean[e]) * k)
				const mag = (qAbs[e] += (Math.abs(Q) - qAbs[e]) * k)
				const carries = smoothstep(P.flowLow, P.flowHigh, mag)
				const mature = smoothstep(P.matureFrom, P.matureBy, net.time - born[e])
				const size = carries * mature * Math.pow(Math.max(d, 0) / P.refD, P.contrast) * smoothstep(P.veinD, P.veinD * 2.8, d)
				sizes[e] = size
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
				if (size > 0.12) visible[count++] = e
				dynF[o] = d
				dynF[o + 1] = born[e]
				dynF[o + 2] = phase[e]
				dynU[o * 2 + 6] = carries * 65535
				dynU[o * 2 + 7] = g * 65535
			}
			this.maxD = maxD
			// nodes glide to smoothed places, unless nothing may move or the model jumped ahead
			this.smoothPaths(count, this.snap || still || modelDt > 0.5)
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
			gl.uniform4f(u.u_tube, P.tubeRadius, P.refD, P.veinD, P.contrast)
			gl.uniform4f(u.u_life, P.youthFade, P.breathe, (2 * Math.PI) / P.pulse, (2 * Math.PI) / P.wave)
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
			const m = DishRenderer.viewMatrix(opts && opts.view, w, h, this.width, this.height, this.viewOut)
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
				this.exploredMips = true
			}
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.trackFbo)
			gl.viewport(0, 0, this.trackSize[0], this.trackSize[1])
			gl.clearColor(0, 0, 0, 0)
			gl.clear(gl.COLOR_BUFFER_BIT)

			if (net && this.instances > 0) {
				gl.bindVertexArray(this.vao)
				gl.enable(gl.BLEND)
				gl.blendEquation(gl.MAX)

				// 1. everywhere the slime has been, adding what grew since last time
				const time = Math.fround(net.time)
				if (time > this.exploredAfter) {
					const ex = this.programs.explored
					gl.bindFramebuffer(gl.FRAMEBUFFER, this.exploredFbo)
					gl.viewport(0, 0, this.width, this.height)
					gl.useProgram(ex.p)
					this.setInstanceUniforms(ex, 1, 0)
					gl.uniform1f(ex.u.u_bornAfter, this.exploredAfter)
					gl.uniform1f(ex.u.u_reach, P.exploreRadius)
					gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instances)
					this.exploredAfter = time
					this.exploredMips = true
				}

				// 2. the sheet, the growing margin, withered marks, soft tubes
				const tr = this.programs.track
				gl.bindFramebuffer(gl.FRAMEBUFFER, this.trackFbo)
				gl.viewport(0, 0, this.trackSize[0], this.trackSize[1])
				gl.useProgram(tr.p)
				this.setInstanceUniforms(tr, 1, 0)
				gl.uniform4f(tr.u.u_track, P.sheetRadius, P.sheetD, 4, P.sheetFloor)
				gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instances)
			}
			// the glow is made from blurred copies of the soft tubes
			gl.bindFramebuffer(gl.FRAMEBUFFER, null)
			gl.bindTexture(gl.TEXTURE_2D, this.trackTex)
			gl.generateMipmap(gl.TEXTURE_2D)

			if (this.exploredMips) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, null)
				gl.bindTexture(gl.TEXTURE_2D, this.exploredTex)
				gl.generateMipmap(gl.TEXTURE_2D)
				this.exploredMips = false
			}

			// 3. the tubes, at screen size
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.tubeFbo)
			gl.viewport(0, 0, w, h)
			this.clearTubes[0] = -margin
			gl.clearBufferfv(gl.COLOR, 0, this.clearTubes)
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
			for (let i = 0; i < DISH_TEXTURES.length; i++) {
				gl.activeTexture(gl.TEXTURE0 + i)
				gl.bindTexture(gl.TEXTURE_2D, this[DISH_TEXTURES[i][0]])
				gl.uniform1i(d.u[DISH_TEXTURES[i][1]], i)
			}
			gl.uniform2f(d.u.u_canvas, w, h)
			gl.uniform2f(d.u.u_sim, this.width, this.height)
			gl.uniform4f(d.u.u_view, cx, cy, scale, 0)
			gl.uniform1f(d.u.u_tap, tap)
			gl.uniform1f(d.u.u_margin, margin)
			gl.uniform1f(d.u.u_rMax, P.tubeRadius)
			gl.uniform1f(d.u.u_time, net ? net.time : 0)
			gl.uniform1f(d.u.u_wetFade, P.wetFade)
			gl.uniform4f(d.u.u_beat, (2 * Math.PI) / P.pulse, (2 * Math.PI) / P.wave, this.clockNow, still ? 0 : 1)
			gl.uniform4f(d.u.u_glass, P.rimInset, P.wall, Math.max(1, 0.75 * scale), 0)
			for (let i = 0; i < COLORS.length; i++) gl.uniform3fv(d.u[COLOR_UNIFORMS[i]], pal[COLORS[i]])
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
			let grown = 0, tubes = 0, sheet = 0, fragments = 0
			for (let e = 0; e < E; e++) {
				const o = e * 4
				const d = this.dynF[o]
				if (d < 0) continue
				grown++
				if (d > P.sheetFloor * 4) sheet++
				const age = Math.max(0, net.time - this.dynF[o + 1])
				const carries = this.dynU[o * 2 + 6] / 65535
				const r = P.tubeRadius * Math.pow(d / P.refD, P.contrast) * smoothstep(P.veinD, P.veinD * 2.8, d) * carries * smoothstep(P.matureFrom, P.matureBy, age)
				if (r * scale < 0.04) continue
				tubes++
				const len = Math.hypot(this.geo[o + 2] - this.geo[o], this.geo[o + 3] - this.geo[o + 1])
				const ext = Math.max(r * scale, P.minPx) * 1.1 + Math.min(3.5, Math.max(1, 0.8 * scale)) + 2
				fragments += (len * scale + 2 * ext) * 2 * ext
			}
			return {grown, tubes, sheet, tubeFragments: Math.round(fragments), instances: this.instances, maxD: this.maxD, cpuMs: this.cpuMs}
		}
	}

	DishRenderer.DEFAULTS = DEFAULTS

	// The view as a Canvas2D transform from map px to device px:
	//   ctx.setTransform(...DishRenderer.viewMatrix(view, canvas.width, canvas.height))
	// then draw in map px. A point on the canvas (device px) back on the map:
	//   x = (cx - m[4]) / m[0], y = (cy - m[5]) / m[3]
	// view: {x, y, zoom}, the map point at the centre of the canvas and the
	// zoom (1: the whole map fits, as without a view).
	DishRenderer.viewMatrix = (view, canvasWidth, canvasHeight, width = 1024, height = width, out = new Array(6)) => {
		const zoom = view && view.zoom > 0 ? view.zoom : 1
		const x = view && Number.isFinite(view.x) ? view.x : width / 2
		const y = view && Number.isFinite(view.y) ? view.y : height / 2
		const s = Math.min(canvasWidth / width, canvasHeight / height) * zoom
		out[0] = s
		out[1] = 0
		out[2] = 0
		out[3] = s
		out[4] = canvasWidth / 2 - x * s
		out[5] = canvasHeight / 2 - y * s
		return out
	}

	return DishRenderer
})()
