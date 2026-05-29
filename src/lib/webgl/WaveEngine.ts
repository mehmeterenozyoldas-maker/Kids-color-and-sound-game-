const simVertexShaderSource = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const simFragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_state;
uniform vec2 u_resolution;
uniform float u_damping;
uniform float u_c;
uniform vec4 u_interactions[4]; // x,y = pos, z = force, w = radius
uniform vec2 u_interactionsPhase[4]; // re, im

in vec2 v_uv;
out vec4 outColor;

vec2 getComplex(vec2 uv, vec2 offset) {
    vec2 p = uv + offset / u_resolution;
    // Toroidal wrap is automatic if texture wrap mode is REPEAT
    return texture(u_state, p).rg;
}

void main() {
    vec4 state = texture(u_state, v_uv);
    vec2 curr = state.rg;
    vec2 prev = state.ba;

    vec2 laplacian = vec2(0.0);

    // Scale 1
    laplacian += 1.0 * (
        getComplex(v_uv, vec2(1.0, 0.0)) +
        getComplex(v_uv, vec2(-1.0, 0.0)) +
        getComplex(v_uv, vec2(0.0, 1.0)) +
        getComplex(v_uv, vec2(0.0, -1.0)) -
        4.0 * curr
    );

    // Scale 2
    laplacian += 0.5 * (
        getComplex(v_uv, vec2(2.0, 0.0)) +
        getComplex(v_uv, vec2(-2.0, 0.0)) +
        getComplex(v_uv, vec2(0.0, 2.0)) +
        getComplex(v_uv, vec2(0.0, -2.0)) -
        4.0 * curr
    );

    // Scale 4
    laplacian += 0.25 * (
        getComplex(v_uv, vec2(4.0, 0.0)) +
        getComplex(v_uv, vec2(-4.0, 0.0)) +
        getComplex(v_uv, vec2(0.0, 4.0)) +
        getComplex(v_uv, vec2(0.0, -4.0)) -
        4.0 * curr
    );

    vec2 vel = (curr - prev) * (1.0 - u_damping);
    vec2 next = curr + vel + laplacian * u_c;

    for (int i = 0; i < 4; i++) {
        vec4 inter = u_interactions[i];
        if (abs(inter.z) > 0.001) {
            float dist = distance(v_uv * u_resolution, inter.xy * u_resolution);
            if (dist < inter.w) {
                float falloff = 1.0 - (dist / inter.w);
                float influence = smoothstep(0.0, 1.0, falloff);
                if (inter.z > 0.0) {
                    next += u_interactionsPhase[i] * inter.z * influence;
                } else {
                    // Dampen (erase) field locally when force is negative
                    next *= (1.0 - min(abs(inter.z), 1.0) * influence);
                }
            }
        }
    }

    // Dampen extreme values
    if (length(next) > 20.0) {
        next = normalize(next) * 20.0;
    }

    outColor = vec4(next, curr);
}`;

const renderFragmentShaderSource = `#version 300 es
precision highp float;

uniform sampler2D u_state;
uniform float u_brightnessScale;
uniform float u_chromaScale;

in vec2 v_uv;
out vec4 outColor;

vec3 hsb2rgb(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x*6.0+vec3(0.0,4.0,2.0), 6.0)-3.0)-1.0, 0.0, 1.0);
    rgb = rgb*rgb*(3.0-2.0*rgb);
    return c.z * mix(vec3(1.0), rgb, c.y);
}

void main() {
    vec4 state = texture(u_state, v_uv);
    vec2 curr = state.rg;

    float re = curr.x;
    float im = curr.y;

    float amp = sqrt(re * re + im * im);
    float phase = atan(im, re);

    float hue = (phase / 3.14159265359 + 1.0) * 0.5;
    
    float brightness = clamp(amp * u_brightnessScale, 0.0, 1.0);
    brightness = pow(brightness, 0.9); // Slight non-linear curve

    vec3 color = hsb2rgb(vec3(hue, u_chromaScale, brightness));
    
    outColor = vec4(color, 1.0);
}`;

export class WaveEngine {
  public gl: WebGL2RenderingContext;
  private simProgram: WebGLProgram;
  private renderProgram: WebGLProgram;

  private fboA: WebGLFramebuffer;
  private fboB: WebGLFramebuffer;
  private texA: WebGLTexture;
  private texB: WebGLTexture;

  private width: number;
  private height: number;
  private flip: boolean = false;

  private uSimState: WebGLUniformLocation | null;
  private uSimResolution: WebGLUniformLocation | null;
  private uSimDamping: WebGLUniformLocation | null;
  private uSimC: WebGLUniformLocation | null;
  private uSimInteractions: WebGLUniformLocation | null;
  private uSimInteractionsPhase: WebGLUniformLocation | null;

  private uRenderState: WebGLUniformLocation | null;
  private uRenderBrightness: WebGLUniformLocation | null;
  private uRenderChroma: WebGLUniformLocation | null;

  private quadVAO: WebGLVertexArrayObject;

  constructor(canvas: HTMLCanvasElement, simScale: number = 0.5) {
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false });
    if (!gl) throw new Error("WebGL2 required");
    this.gl = gl;

    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error(
        "EXT_color_buffer_float required for saving simulation states.",
      );
    }

    this.width = Math.floor(canvas.width * simScale);
    this.height = Math.floor(canvas.height * simScale);

    this.simProgram = this.createProgram(
      gl,
      simVertexShaderSource,
      simFragmentShaderSource,
    );
    this.renderProgram = this.createProgram(
      gl,
      simVertexShaderSource,
      renderFragmentShaderSource,
    );

    // Uniform locations - SIMULATION
    this.uSimState = gl.getUniformLocation(this.simProgram, "u_state");
    this.uSimResolution = gl.getUniformLocation(
      this.simProgram,
      "u_resolution",
    );
    this.uSimDamping = gl.getUniformLocation(this.simProgram, "u_damping");
    this.uSimC = gl.getUniformLocation(this.simProgram, "u_c");
    this.uSimInteractions = gl.getUniformLocation(
      this.simProgram,
      "u_interactions",
    );
    this.uSimInteractionsPhase = gl.getUniformLocation(
      this.simProgram,
      "u_interactionsPhase",
    );

    // Uniform locations - RENDER
    this.uRenderState = gl.getUniformLocation(this.renderProgram, "u_state");
    this.uRenderBrightness = gl.getUniformLocation(
      this.renderProgram,
      "u_brightnessScale",
    );
    this.uRenderChroma = gl.getUniformLocation(
      this.renderProgram,
      "u_chromaScale",
    );

    // Set up ping-pong framebuffers
    [this.texA, this.fboA] = this.createFBO();
    [this.texB, this.fboB] = this.createFBO();

    // Quad geometry
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const posBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    this.quadVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVAO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Initial state clear
    this.clearStates();
  }

  private createProgram(
    gl: WebGL2RenderingContext,
    vSource: string,
    fSource: string,
  ): WebGLProgram {
    const vShader = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vShader, vSource);
    gl.compileShader(vShader);
    if (!gl.getShaderParameter(vShader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(vShader));
    }

    const fShader = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fShader, fSource);
    gl.compileShader(fShader);
    if (!gl.getShaderParameter(fShader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(fShader));
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vShader);
    gl.attachShader(prog, fShader);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
    }

    return prog;
  }

  private createFBO(): [WebGLTexture, WebGLFramebuffer] {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.FLOAT,
      null,
    );

    // Repeat wrapping is CRITICAL for the toroidal topology
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error("Framebuffer not complete:", status);
    }

    return [tex, fbo];
  }

  public resize(width: number, height: number, simScale: number = 0.5) {
    this.width = Math.floor(width * simScale);
    this.height = Math.floor(height * simScale);

    const gl = this.gl;

    const recreateTex = (tex: WebGLTexture, fbo: WebGLFramebuffer) => {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        this.width,
        this.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      );
    };

    recreateTex(this.texA, this.fboA);
    recreateTex(this.texB, this.fboB);
    this.clearStates();
  }

  public clearStates() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  public step(
    damping: number,
    c: number,
    interactions: {
      x: number;
      y: number;
      force: number;
      radius: number;
      phaseRe: number;
      phaseIm: number;
    }[],
  ) {
    const gl = this.gl;

    gl.useProgram(this.simProgram);
    gl.bindVertexArray(this.quadVAO);

    const destFBO = this.flip ? this.fboB : this.fboA;
    const srcTex = this.flip ? this.texA : this.texB;

    gl.bindFramebuffer(gl.FRAMEBUFFER, destFBO);
    gl.viewport(0, 0, this.width, this.height);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.uSimState, 0);

    gl.uniform2f(this.uSimResolution, this.width, this.height);
    gl.uniform1f(this.uSimDamping, damping);
    gl.uniform1f(this.uSimC, c);

    const interData = new Float32Array(16); // 4 * 4
    const phaseData = new Float32Array(8); // 4 * 2

    for (let i = 0; i < 4; i++) {
      if (i < interactions.length) {
        const inf = interactions[i];
        interData[i * 4 + 0] = inf.x;
        interData[i * 4 + 1] = 1.0 - inf.y; // flip Y
        interData[i * 4 + 2] = inf.force;
        interData[i * 4 + 3] = inf.radius;

        phaseData[i * 2 + 0] = inf.phaseRe;
        phaseData[i * 2 + 1] = inf.phaseIm;
      }
    }

    gl.uniform4fv(this.uSimInteractions, interData);
    gl.uniform2fv(this.uSimInteractionsPhase, phaseData);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    this.flip = !this.flip; // Toggle
  }

  public render(brightnessScale: number, chromaScale: number) {
    const gl = this.gl;

    gl.useProgram(this.renderProgram);
    gl.bindVertexArray(this.quadVAO);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    const srcTex = this.flip ? this.texA : this.texB;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.uRenderState, 0);

    gl.uniform1f(this.uRenderBrightness, brightnessScale);
    gl.uniform1f(this.uRenderChroma, chromaScale);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  public destroy() {
    // cleanup webgl resources if component unmounts
  }
}
