'use strict'

// Physarum polycephalum, the many-headed slime mould, as a few hundred
// thousand tiny agents on the GPU.
//
// The movement rules follow Jeff Jones (2010). Each agent smells the trail
// ahead of it with three sensors, turns toward the strongest smell, takes a
// step and leaves a little trail behind. The trail spreads and fades.
//
// Two additions make it build a network between food instead of a mesh
// everywhere:
//  - Agents live on what they eat. One that crawls too far without reaching
//    an oat flake dies and grows back at the last flake it ate from.
//  - Oat flakes give off a smell that seeps through the agar. Hungry agents
//    follow it, fed ones mostly follow each other.

const TAU = Math.PI * 2
const MAX_FLAKES = 64
const AGENT_FLOATS = 5 // x, y, heading, energy, home
const AGENT_BYTES = AGENT_FLOATS * 4

const DEFAULTS = {
	sensorAngle: 0.5, // radians, between the middle sensor and the side ones
	sensorDist: 9, // px
	turn: 0.45, // radians per step
	wobble: 0.2, // random steering, radians
	speed: 1, // px per step
	lifespan: 280, // steps an agent survives without eating
	saturation: 4, // trail level at which the smell is half as strong as it gets
	appetite: 6, // how strongly hungry agents follow oat smell
	lightFear: 3,
	parkFear: 0.35,
	lightCost: 5, // extra hunger per step in bright light
	deposit: 0.02, // trail per agent per step, at 2^19 agents
	trailDecay: 0.93,
	smellDecay: 0.999,
	smellSource: 0.03,
	traceFade: 0.9993,
	exposure: 0.3,
}

const VS_QUAD = `#version 300 es
out vec2 v_uv;
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	v_uv = vec2(p.x, 1.0 - p.y);
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const VS_UPDATE = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec4 a_agent; // x, y (px), heading, energy (steps left)
layout(location = 1) in float a_home; // the oat flake this agent last ate from

out vec4 v_agent;
out float v_home;

uniform sampler2D u_trail; // r: slime trail, g: trace, b: oat smell
uniform sampler2D u_env;   // r: oat flake id + 1, g: light, b: parkland, a: outside
uniform vec2 u_size;
uniform uint u_seed;
uniform float u_sensorAngle;
uniform float u_sensorDist;
uniform float u_turn;
uniform float u_wobble;
uniform float u_speed;
uniform float u_lifespan;
uniform float u_saturation;
uniform float u_appetite;
uniform float u_lightFear;
uniform float u_parkFear;
uniform float u_lightCost;
uniform vec4 u_flakes[${MAX_FLAKES}]; // x, y, alive, 0
uniform int u_fallback; // flake to grow back at when the home flake is gone, -1 if none

const float TAU = 6.28318530718;

uint state;
uint hash(uint x) {
	x ^= x >> 16u; x *= 0x7feb352du;
	x ^= x >> 15u; x *= 0x846ca68bu;
	x ^= x >> 16u;
	return x;
}
float rand() {
	state = hash(state);
	return float(state >> 8u) / 16777216.0;
}

vec4 envAt(vec2 p) {
	return texelFetch(u_env, clamp(ivec2(p), ivec2(0), ivec2(u_size) - 1), 0);
}

float smell(vec2 p, float hunger) {
	vec4 t = texture(u_trail, p / u_size);
	vec4 e = envAt(p);
	float s = t.r / (t.r + u_saturation);
	s += u_appetite * hunger * t.b;
	s -= u_lightFear * e.g + u_parkFear * e.b + 8.0 * e.a;
	return s;
}

void main() {
	state = hash(uint(gl_VertexID) * 747796405u + u_seed);
	vec2 p = a_agent.xy;
	float heading = a_agent.z;
	float energy = a_agent.w;
	float home = a_home;
	float hunger = smoothstep(0.3, 0.9, 1.0 - energy / u_lifespan);

	float l = smell(p + u_sensorDist * vec2(cos(heading - u_sensorAngle), sin(heading - u_sensorAngle)), hunger);
	float c = smell(p + u_sensorDist * vec2(cos(heading), sin(heading)), hunger);
	float r = smell(p + u_sensorDist * vec2(cos(heading + u_sensorAngle), sin(heading + u_sensorAngle)), hunger);

	float coin = rand();
	float amount = u_turn * (0.6 + 0.4 * rand());
	if (c > l && c > r) {
		// straight on
	} else if (c < l && c < r) {
		heading += coin < 0.5 ? -amount : amount;
	} else if (l > r) {
		heading -= amount;
	} else if (r > l) {
		heading += amount;
	}
	heading += (rand() - 0.5) * u_wobble;

	vec2 next = p + u_speed * vec2(cos(heading), sin(heading));
	vec4 e = envAt(next);
	bool blocked = e.a > 0.5 || next.x < 0.5 || next.y < 0.5 || next.x > u_size.x - 0.5 || next.y > u_size.y - 0.5;
	if (blocked) {
		next = p;
		heading = rand() * TAU;
		e = envAt(p);
	}

	int id = int(e.r * 255.0 + 0.5) - 1;
	if (id >= 0 && id < ${MAX_FLAKES} && u_flakes[id].z > 0.5) {
		energy = u_lifespan;
		home = float(id);
	} else {
		energy -= 1.0 + u_lightCost * e.g;
	}

	if (energy <= 0.0) {
		int h = int(home + 0.5);
		if (h < 0 || h >= ${MAX_FLAKES} || u_flakes[h].z < 0.5) h = u_fallback;
		if (h < 0) {
			energy = u_lifespan;
		} else {
			float a = rand() * TAU;
			float d = sqrt(rand()) * 3.0;
			next = u_flakes[h].xy + d * vec2(cos(a), sin(a));
			heading = rand() * TAU;
			energy = u_lifespan * (0.6 + 0.4 * rand());
			home = float(h);
		}
	}

	v_agent = vec4(next, mod(heading, TAU), energy);
	v_home = home;
}`

const FS_NOTHING = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`

// Well-fed agents lay more trail than starving ones, so paths that lead to
// food stay strong and dead ends fade from the tip.
const VS_DEPOSIT = `#version 300 es
layout(location = 0) in vec4 a_agent;
uniform vec2 u_size;
uniform float u_lifespan;
flat out float v_weight;
void main() {
	v_weight = 0.2 + 0.8 * clamp(a_agent.w / u_lifespan, 0.0, 1.0);
	gl_Position = vec4(a_agent.xy / u_size * 2.0 - 1.0, 0.0, 1.0);
	gl_PointSize = 1.0;
}`

const FS_DEPOSIT = `#version 300 es
precision highp float;
uniform float u_deposit;
flat in float v_weight;
out vec4 o;
void main() { o = vec4(u_deposit * v_weight, 0.0, 0.0, 0.0); }`

const FS_DIFFUSE = `#version 300 es
precision highp float;
uniform sampler2D u_trail;
uniform sampler2D u_env;
uniform float u_trailDecay;
uniform float u_smellDecay;
uniform float u_smellSource;
uniform float u_traceFade;
out vec4 o;

const float CAP = 2000.0;

void main() {
	ivec2 p = ivec2(gl_FragCoord.xy);
	vec2 texel = 1.0 / vec2(textureSize(u_trail, 0));
	vec2 uv = gl_FragCoord.xy * texel;
	vec4 here = min(texelFetch(u_trail, p, 0), vec4(CAP));
	// four bilinear taps between the texels make a 1-2-1 blur over 3x3
	vec2 sum = vec2(0.0);
	sum += min(texture(u_trail, uv + vec2(-0.5, -0.5) * texel).rb, vec2(CAP));
	sum += min(texture(u_trail, uv + vec2(0.5, -0.5) * texel).rb, vec2(CAP));
	sum += min(texture(u_trail, uv + vec2(-0.5, 0.5) * texel).rb, vec2(CAP));
	sum += min(texture(u_trail, uv + vec2(0.5, 0.5) * texel).rb, vec2(CAP));
	vec4 e = texelFetch(u_env, p, 0);
	float outside = step(0.5, e.a);
	float trail = sum.x / 4.0 * u_trailDecay * (1.0 - 0.25 * e.g) * (1.0 - outside);
	float smell = (sum.y / 4.0 * u_smellDecay + (e.r > 0.0 ? u_smellSource : 0.0)) * (1.0 - outside);
	float trace = max(here.g * u_traceFade, clamp(trail * 0.25, 0.0, 1.0));
	o = vec4(trail, trace, smell, 1.0);
}`

const FS_DISPLAY = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_trail;
uniform sampler2D u_env;
uniform vec3 u_dish;
uniform vec3 u_park;
uniform vec3 u_outside;
uniform vec3 u_trace;
uniform vec3 u_slime;
uniform vec3 u_core;
uniform vec3 u_light;
uniform float u_exposure;
out vec4 o;
void main() {
	vec4 t = texture(u_trail, v_uv);
	vec4 e = texture(u_env, v_uv);
	vec3 col = mix(u_dish, u_park, e.b);
	col = mix(col, u_outside, smoothstep(0.25, 0.75, e.a));
	col = mix(col, u_trace, t.g * 0.55 * (1.0 - e.a));
	float s = 1.0 - exp(-t.r * u_exposure);
	col = mix(col, u_slime, smoothstep(0.0, 0.5, s));
	col = mix(col, u_core, smoothstep(0.5, 1.0, s));
	col = mix(col, u_light, clamp(e.g, 0.0, 1.0) * 0.55);
	o = vec4(col, 1.0);
}`

// Reads the trail under every oat flake, so the page can tell which ones the
// slime has reached.
const VS_PROBE = `#version 300 es
precision highp float;
uniform sampler2D u_trail;
uniform vec2 u_size;
uniform vec4 u_flakes[${MAX_FLAKES}];
out float v_value;
void main() {
	vec4 f = u_flakes[gl_VertexID];
	float v = 0.0;
	for (int i = 0; i < 8; i++) {
		float a = float(i) * 0.785398;
		v = max(v, texture(u_trail, (f.xy + 5.0 * vec2(cos(a), sin(a))) / u_size).r);
	}
	v_value = v * f.z;
	gl_Position = vec4((float(gl_VertexID) + 0.5) / ${MAX_FLAKES}.0 * 2.0 - 1.0, 0.0, 0.0, 1.0);
	gl_PointSize = 1.0;
}`

const FS_PROBE = `#version 300 es
precision highp float;
in float v_value;
out vec4 o;
void main() { o = vec4(v_value, 0.0, 0.0, 1.0); }`

class Physarum {
	constructor(canvas, {width, height, agents}) {
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
		this.agentCount = agents
		this.params = {...DEFAULTS}
		this.flakes = new Float32Array(MAX_FLAKES * 4)
		this.fallback = -1
		this.steps = 0
		this.seed = 1
		this.palette = null

		this.env = new Uint8Array(width * height * 4)
		this.envDirty = null

		this.programs = {
			update: this.program(VS_UPDATE, FS_NOTHING, ['v_agent', 'v_home']),
			deposit: this.program(VS_DEPOSIT, FS_DEPOSIT),
			diffuse: this.program(VS_QUAD, FS_DIFFUSE),
			display: this.program(VS_QUAD, FS_DISPLAY),
			probe: this.program(VS_PROBE, FS_PROBE),
		}

		this.trail = [0, 1].map(() => this.texture(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR))
		this.trailFbo = this.trail.map((t) => this.framebuffer(t))
		this.envTex = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
		this.probeTex = this.texture(gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, MAX_FLAKES, 1)
		this.probeFbo = this.framebuffer(this.probeTex)
		this.probeOut = new Float32Array(MAX_FLAKES * 4)
		this.probePbo = gl.createBuffer()
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
		gl.bufferData(gl.PIXEL_PACK_BUFFER, this.probeOut.byteLength, gl.STREAM_READ)
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
		this.probeSync = null

		this.buffers = [0, 1].map(() => {
			const b = gl.createBuffer()
			gl.bindBuffer(gl.ARRAY_BUFFER, b)
			gl.bufferData(gl.ARRAY_BUFFER, agents * AGENT_BYTES, gl.DYNAMIC_COPY)
			return b
		})
		this.vaos = this.buffers.map((b) => {
			const vao = gl.createVertexArray()
			gl.bindVertexArray(vao)
			gl.bindBuffer(gl.ARRAY_BUFFER, b)
			gl.enableVertexAttribArray(0)
			gl.vertexAttribPointer(0, 4, gl.FLOAT, false, AGENT_BYTES, 0)
			gl.enableVertexAttribArray(1)
			gl.vertexAttribPointer(1, 1, gl.FLOAT, false, AGENT_BYTES, 16)
			return vao
		})
		this.emptyVao = gl.createVertexArray()
		gl.bindVertexArray(null)
		gl.bindBuffer(gl.ARRAY_BUFFER, null)
		this.tf = gl.createTransformFeedback()
		this.current = 0
	}

	program(vsSource, fsSource, varyings) {
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
		if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS)
		gl.linkProgram(p)
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
			throw new Error('Shader failed to link: ' + gl.getProgramInfoLog(p))
		}
		const uniforms = {}
		const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS)
		for (let i = 0; i < n; i++) {
			const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '')
			uniforms[name] = gl.getUniformLocation(p, name)
		}
		return {p, u: uniforms}
	}

	texture(internal, format, type, filter, w = this.width, h = this.height) {
		const gl = this.gl
		const t = gl.createTexture()
		gl.bindTexture(gl.TEXTURE_2D, t)
		gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
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

	// --- The dish ------------------------------------------------------------

	// city and extent are Uint8 masks (255 = inside) at sim resolution.
	setGround(city, extent) {
		const env = this.env
		for (let i = 0, n = this.width * this.height; i < n; i++) {
			const inside = extent[i] / 255
			env[i * 4 + 2] = Math.round(255 * inside * (1 - city[i] / 255))
			env[i * 4 + 3] = Math.round(255 * (1 - inside))
		}
		this.markDirty(0, 0, this.width, this.height)
	}

	setFlakes(list) {
		const env = this.env
		const {width: w, height: h} = this
		for (let i = 0; i < w * h; i++) env[i * 4] = 0
		this.flakes.fill(0)
		list.forEach((f, i) => {
			if (i >= MAX_FLAKES) return
			this.flakes.set([f.x, f.y, f.alive ? 1 : 0, 0], i * 4)
			if (!f.alive) return
			const r = 3.5
			for (let y = Math.floor(f.y - r); y <= Math.ceil(f.y + r); y++) {
				for (let x = Math.floor(f.x - r); x <= Math.ceil(f.x + r); x++) {
					if (x < 0 || y < 0 || x >= w || y >= h) continue
					if ((x + 0.5 - f.x) ** 2 + (y + 0.5 - f.y) ** 2 > r * r) continue
					env[(y * w + x) * 4] = i + 1
				}
			}
		})
		this.markDirty(0, 0, w, h)
	}

	setFallback(index) {
		this.fallback = index
	}

	// amount > 0 adds light, amount < 0 takes it away
	paintLight(cx, cy, radius, amount) {
		const {width: w, height: h, env} = this
		const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(w - 1, Math.ceil(cx + radius))
		const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(h - 1, Math.ceil(cy + radius))
		for (let y = y0; y <= y1; y++) {
			for (let x = x0; x <= x1; x++) {
				const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius
				if (d >= 1) continue
				const k = (y * w + x) * 4 + 1
				const soft = 1 - d * d
				env[k] = Math.max(0, Math.min(255, env[k] + amount * soft * 255))
			}
		}
		this.markDirty(x0, y0, x1 + 1, y1 + 1)
	}

	clearLight() {
		for (let i = 1; i < this.env.length; i += 4) this.env[i] = 0
		this.markDirty(0, 0, this.width, this.height)
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
	}

	// Put every agent on one oat flake, as if the dish had just been inoculated.
	inoculate(index) {
		const gl = this.gl
		const n = this.agentCount
		const data = new Float32Array(n * AGENT_FLOATS)
		const fx = this.flakes[index * 4], fy = this.flakes[index * 4 + 1]
		const life = this.params.lifespan
		for (let i = 0; i < n; i++) {
			const a = Math.random() * TAU
			const d = Math.sqrt(Math.random()) * 4
			const o = i * AGENT_FLOATS
			data[o] = fx + d * Math.cos(a)
			data[o + 1] = fy + d * Math.sin(a)
			data[o + 2] = Math.random() * TAU
			data[o + 3] = life * (0.6 + 0.4 * Math.random())
			data[o + 4] = index
		}
		for (const b of this.buffers) {
			gl.bindBuffer(gl.ARRAY_BUFFER, b)
			gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, null)
		for (const fbo of this.trailFbo) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
			gl.clearColor(0, 0, 0, 0)
			gl.clear(gl.COLOR_BUFFER_BIT)
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		this.steps = 0
	}

	// --- Running -------------------------------------------------------------

	step(count = 1) {
		const gl = this.gl
		const P = this.params
		this.uploadEnv()
		gl.disable(gl.DEPTH_TEST)
		gl.viewport(0, 0, this.width, this.height)
		for (let s = 0; s < count; s++) {
			const cur = this.current, next = 1 - cur

			// 1. every agent smells, turns, steps, eats or dies. No framebuffer
			// may hold the trail we read, even with rasterising switched off.
			gl.bindFramebuffer(gl.FRAMEBUFFER, null)
			const up = this.programs.update
			gl.useProgram(up.p)
			gl.activeTexture(gl.TEXTURE0)
			gl.bindTexture(gl.TEXTURE_2D, this.trail[cur])
			gl.activeTexture(gl.TEXTURE1)
			gl.bindTexture(gl.TEXTURE_2D, this.envTex)
			gl.uniform1i(up.u.u_trail, 0)
			gl.uniform1i(up.u.u_env, 1)
			gl.uniform2f(up.u.u_size, this.width, this.height)
			gl.uniform1ui(up.u.u_seed, (this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0))
			gl.uniform1f(up.u.u_sensorAngle, P.sensorAngle)
			gl.uniform1f(up.u.u_sensorDist, P.sensorDist)
			gl.uniform1f(up.u.u_turn, P.turn)
			gl.uniform1f(up.u.u_wobble, P.wobble)
			gl.uniform1f(up.u.u_speed, P.speed)
			gl.uniform1f(up.u.u_lifespan, P.lifespan)
			gl.uniform1f(up.u.u_saturation, P.saturation)
			gl.uniform1f(up.u.u_appetite, P.appetite)
			gl.uniform1f(up.u.u_lightFear, P.lightFear)
			gl.uniform1f(up.u.u_parkFear, P.parkFear)
			gl.uniform1f(up.u.u_lightCost, P.lightCost)
			gl.uniform4fv(up.u.u_flakes, this.flakes)
			gl.uniform1i(up.u.u_fallback, this.fallback)
			gl.bindVertexArray(this.vaos[cur])
			gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf)
			gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.buffers[next])
			gl.enable(gl.RASTERIZER_DISCARD)
			gl.beginTransformFeedback(gl.POINTS)
			gl.drawArrays(gl.POINTS, 0, this.agentCount)
			gl.endTransformFeedback()
			gl.disable(gl.RASTERIZER_DISCARD)
			gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
			gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)

			// 2. they leave trail where they now stand
			const dep = this.programs.deposit
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo[cur])
			gl.useProgram(dep.p)
			gl.uniform2f(dep.u.u_size, this.width, this.height)
			gl.uniform1f(dep.u.u_deposit, P.deposit * (524288 / this.agentCount))
			gl.uniform1f(dep.u.u_lifespan, P.lifespan)
			gl.bindVertexArray(this.vaos[next])
			gl.enable(gl.BLEND)
			gl.blendFunc(gl.ONE, gl.ONE)
			gl.drawArrays(gl.POINTS, 0, this.agentCount)
			gl.disable(gl.BLEND)

			// 3. the trail and the oat smell spread and fade
			const dif = this.programs.diffuse
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo[next])
			gl.useProgram(dif.p)
			gl.activeTexture(gl.TEXTURE0)
			gl.bindTexture(gl.TEXTURE_2D, this.trail[cur])
			gl.uniform1i(dif.u.u_trail, 0)
			gl.uniform1i(dif.u.u_env, 1)
			gl.uniform1f(dif.u.u_trailDecay, P.trailDecay)
			gl.uniform1f(dif.u.u_smellDecay, P.smellDecay)
			gl.uniform1f(dif.u.u_smellSource, P.smellSource)
			gl.uniform1f(dif.u.u_traceFade, P.traceFade)
			gl.bindVertexArray(this.emptyVao)
			gl.drawArrays(gl.TRIANGLES, 0, 3)

			this.current = next
			this.steps++
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		gl.bindVertexArray(null)
	}

	setPalette(palette) {
		this.palette = palette
	}

	render() {
		const gl = this.gl
		const d = this.programs.display
		const pal = this.palette
		this.uploadEnv()
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		gl.viewport(0, 0, this.canvas.width, this.canvas.height)
		gl.useProgram(d.p)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.trail[this.current])
		gl.activeTexture(gl.TEXTURE1)
		gl.bindTexture(gl.TEXTURE_2D, this.envTex)
		gl.uniform1i(d.u.u_trail, 0)
		gl.uniform1i(d.u.u_env, 1)
		for (const key of ['dish', 'park', 'outside', 'trace', 'slime', 'core', 'light']) {
			gl.uniform3fv(d.u['u_' + key], pal[key])
		}
		gl.uniform1f(d.u.u_exposure, this.params.exposure)
		gl.bindVertexArray(this.emptyVao)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
		gl.bindVertexArray(null)
	}

	// The whole trail texture as floats (r, g, b, a per texel). Slow; for tests.
	readTrail() {
		const gl = this.gl
		const out = new Float32Array(this.width * this.height * 4)
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo[this.current])
		gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, out)
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		return out
	}

	drawProbe() {
		const gl = this.gl
		const pr = this.programs.probe
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo)
		gl.viewport(0, 0, MAX_FLAKES, 1)
		gl.useProgram(pr.p)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.trail[this.current])
		gl.uniform1i(pr.u.u_trail, 0)
		gl.uniform2f(pr.u.u_size, this.width, this.height)
		gl.uniform4fv(pr.u.u_flakes, this.flakes)
		gl.bindVertexArray(this.emptyVao)
		gl.drawArrays(gl.POINTS, 0, MAX_FLAKES)
		gl.bindVertexArray(null)
	}

	probeValues() {
		const out = new Float32Array(MAX_FLAKES)
		for (let i = 0; i < MAX_FLAKES; i++) out[i] = this.probeOut[i * 4]
		return out
	}

	// Trail strength around each oat flake, right now. Stalls the GPU.
	probe() {
		const gl = this.gl
		this.drawProbe()
		gl.readPixels(0, 0, MAX_FLAKES, 1, gl.RGBA, gl.FLOAT, this.probeOut)
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		return this.probeValues()
	}

	// The same without waiting: returns the last reading once the GPU has it
	// (or null) and starts the next one.
	probeLater() {
		const gl = this.gl
		let result = null
		if (this.probeSync) {
			const status = gl.clientWaitSync(this.probeSync, 0, 0)
			if (status === gl.TIMEOUT_EXPIRED) return null
			gl.deleteSync(this.probeSync)
			this.probeSync = null
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
			gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeOut)
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
			result = this.probeValues()
		}
		this.drawProbe()
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probePbo)
		gl.readPixels(0, 0, MAX_FLAKES, 1, gl.RGBA, gl.FLOAT, 0)
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		this.probeSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
		gl.flush()
		return result
	}
}

Physarum.MAX_FLAKES = MAX_FLAKES
Physarum.DEFAULTS = DEFAULTS
