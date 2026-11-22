// The landing page's WebGL layer: a noise-driven gradient, a silk ribbon and
// floating toggle switches behind the page, plus the 3D switch in the demo.
// Bundled into public/scene.js by `npm run build:site`.
import {
  ACESFilmicToneMapping, CapsuleGeometry, Color, DirectionalLight, DoubleSide, Group, Mesh,
  MeshPhysicalMaterial, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, ShaderMaterial,
  SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = matchMedia('(max-width: 820px)').matches;
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ---- Theme: every colour comes from the CSS variables on <html> -------------------
// The shaders write straight to the screen, so their colours stay in display space.
let style = getComputedStyle(document.documentElement);
const cssVar = (name) => style.getPropertyValue(name).trim();
const screenColor = (name, target) => {
  const n = parseInt(cssVar(name).slice(1), 16);
  return target.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
const colorUniforms = (names) => Object.fromEntries(names.map((name) => [name, { value: new Vector3() }]));
const themed = [];
const applyTheme = () => { style = getComputedStyle(document.documentElement); themed.forEach((update) => update()); };
addEventListener('flagport:theme', applyTheme);

const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
`;

// ---- Background: domain-warped noise gradient with film grain ------------------
function makeBackground() {
  const material = new ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uRes: { value: new Vector2(1, 1) }, uScroll: { value: 0 }, uEnergy: { value: 1 }, uPointer: { value: new Vector2() }, uVignette: { value: 0.4 }, ...colorUniforms(['uBase', 'uC1', 'uC2', 'uC3', 'uC4']) },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uScroll, uEnergy, uVignette; uniform vec2 uRes, uPointer; uniform vec3 uBase, uC1, uC2, uC3, uC4; varying vec2 vUv;
      ${NOISE}
      void main(){
        vec2 p = vUv - .5; p.x *= uRes.x / uRes.y;
        float t = uTime * .055;
        vec2 q = p * 1.05 + vec2(0., -uScroll * 1.6) + uPointer * .06;
        float n1 = snoise(vec3(q * .8, t));
        float n2 = snoise(vec3(q * 1.35 + n1 * .55, t * 1.4 + 7.));
        float n3 = snoise(vec3(q * .6 - n2 * .4 + 3., t * .8 + 19.));
        vec3 base = uBase;
        vec3 c = base;
        c = mix(c, uC1, smoothstep(-.35, .8, n1) * .9);
        c = mix(c, uC2, smoothstep(.0, .9, n2) * .5);
        c = mix(c, uC3, smoothstep(.22, .95, n3) * .85);
        c = mix(c, uC4, smoothstep(.7, 1., n3) * smoothstep(.1, .8, n2) * .75);
        // Colour gathers in a soft pool and falls away to near-black, so type stays readable.
        float pool = smoothstep(1.25, .05, length(p - vec2(.18 + sin(uScroll * 9.) * .45, .16 + sin(uScroll * 14.) * .22) - uPointer * .04));
        c = mix(base, c, clamp(pool * uEnergy + (1. - pool) * uEnergy * .18, 0., 1.));
        c *= 1. - uVignette * dot(p, p);
        c += (hash(gl_FragCoord.xy + fract(uTime) * 317.) - .5) * .06;
        gl_FragColor = vec4(c, 1.);
      }`,
  });
  const u = material.uniforms;
  const recolor = () => {
    screenColor('--s0', u.uBase.value); screenColor('--s1', u.uC1.value); screenColor('--s2', u.uC2.value);
    screenColor('--s3', u.uC3.value); screenColor('--s4', u.uC4.value);
    u.uVignette.value = parseFloat(cssVar('--vig'));
  };
  recolor();
  themed.push(recolor);
  const mesh = new Mesh(new PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  return { mesh, uniforms: material.uniforms };
}

// ---- Ribbon: a strip of silk that twists and flows ------------------------------
function makeRibbon() {
  const material = new ShaderMaterial({
    side: DoubleSide,
    transparent: true,
    uniforms: { uTime: { value: 0 }, uTwist: { value: 0 }, uOpacity: { value: 1 }, ...colorUniforms(['uR1', 'uR2', 'uR3', 'uR4', 'uSheen']) },
    vertexShader: /* glsl */ `
      uniform float uTime, uTwist; varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      vec3 warp(vec3 p){
        float x = p.x, t = uTime;
        float a = sin(x * .5 + t * .22 + uTwist) * 1.3 + sin(x * .21 - t * .15) * .7;
        float c = cos(a), s = sin(a);
        vec3 r = vec3(x, p.y * c, p.y * s);
        r.y += sin(x * .42 + t * .35) * .85 + sin(x * 1.05 - t * .5) * .2;
        r.z += cos(x * .36 + t * .3) * 1.05 + sin(x * 1.6 + t * .8 + p.y * 1.3) * .1;
        return r;
      }
      void main(){
        vUv = uv;
        vec3 p = warp(position);
        vec3 n = normalize(cross(warp(position + vec3(.02, 0., 0.)) - p, warp(position + vec3(0., .02, 0.)) - p));
        vN = normalize(mat3(modelMatrix) * n);
        vec4 w = modelMatrix * vec4(p, 1.);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime, uOpacity; uniform vec3 uR1, uR2, uR3, uR4, uSheen; varying vec3 vN; varying vec3 vW; varying vec2 vUv;
      float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
      vec3 ramp(float t){
        t = fract(t) * 4.;
        vec3 c1 = uR1, c2 = uR2, c3 = uR3, c4 = uR4;
        if (t < 1.) return mix(c1, c2, t);
        if (t < 2.) return mix(c2, c3, t - 1.);
        if (t < 3.) return mix(c3, c4, t - 2.);
        return mix(c4, c1, t - 3.);
      }
      void main(){
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vW);
        if (dot(n, v) < 0.) n = -n;
        float fres = pow(1. - max(dot(n, v), 0.), 2.4);
        // The hue slides with the viewing angle, which is what makes it read as silk.
        vec3 col = ramp(vUv.x * 1.25 + vUv.y * .22 + uTime * .012 + fres * .38);
        vec3 l1 = normalize(vec3(.5, .9, .7)), l2 = normalize(vec3(-.7, -.25, .6));
        float d = max(dot(n, l1), 0.) * .85 + max(dot(n, l2), 0.) * .3;
        float nh = max(dot(n, normalize(l1 + v)), 0.);
        vec3 c = col * (.1 + d) + col * pow(nh, 10.) * .4 + vec3(1.) * pow(nh, 110.) * .85;
        c += mix(col, uSheen, .6) * fres * .85;
        c *= .96 + .04 * sin(vUv.y * 520.);
        c += (hash(gl_FragCoord.xy) - .5) * .045;
        gl_FragColor = vec4(c, uOpacity);
      }`,
  });
  const u = material.uniforms;
  const recolor = () => {
    screenColor('--r1', u.uR1.value); screenColor('--r2', u.uR2.value); screenColor('--r3', u.uR3.value);
    screenColor('--r4', u.uR4.value); screenColor('--sheen', u.uSheen.value);
  };
  recolor();
  themed.push(recolor);
  const mesh = new Mesh(new PlaneGeometry(18, 2.3, small ? 150 : 280, small ? 28 : 48), material);
  mesh.frustumCulled = false;
  return { mesh, uniforms: material.uniforms };
}

// ---- A chunky toggle switch -----------------------------------------------------
const OFF = new Color(cssVar('--sw-off'));
const ON = new Color(cssVar('--sw-on'));
themed.push(() => { OFF.set(cssVar('--sw-off')); ON.set(cssVar('--sw-on')); });
const trackGeometry = new CapsuleGeometry(0.5, 1, 16, 48);
const knobGeometry = new SphereGeometry(0.4, 48, 32);

function makeSwitch(on = false) {
  const group = new Group();
  const trackMaterial = new MeshPhysicalMaterial({ color: OFF.clone(), roughness: 0.22, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08, emissive: ON.clone(), emissiveIntensity: 0 });
  const track = new Mesh(trackGeometry, trackMaterial);
  track.rotation.z = Math.PI / 2;
  track.scale.z = 0.62;
  const knob = new Mesh(knobGeometry, new MeshPhysicalMaterial({ color: '#f6f7fb', roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 }));
  knob.position.z = 0.16;
  group.add(track, knob);

  let x = on ? 1 : 0, velocity = 0, target = x;
  const apply = () => {
    knob.position.x = mix(-0.5, 0.5, x);
    knob.scale.setScalar(1 + Math.abs(velocity) * 0.012);
    const t = clamp(x);
    trackMaterial.color.lerpColors(OFF, ON, t);
    trackMaterial.emissiveIntensity = t * 0.55;
  };
  apply();
  themed.push(() => { trackMaterial.emissive.copy(ON); apply(); });
  return {
    group,
    set(value) { target = value ? 1 : 0; if (reduced) { x = target; velocity = 0; apply(); } },
    get on() { return target === 1; },
    update(dt) {
      if (Math.abs(target - x) < 0.0005 && Math.abs(velocity) < 0.0005) return false;
      velocity += ((target - x) * 210 - velocity * 17) * dt;
      x += velocity * dt;
      apply();
      return true;
    },
  };
}

function lightScene(scene, renderer) {
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.85;
  const key = new DirectionalLight('#ffffff', 2.2);
  key.position.set(3, 5, 6);
  const rim = new DirectionalLight(cssVar('--rim'), 1.6);
  themed.push(() => rim.color.set(cssVar('--rim')));
  rim.position.set(-5, -2, 2);
  scene.add(key, rim);
  pmrem.dispose();
}

function createRenderer(canvas, alpha) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.5 : 1.75));
  renderer.toneMapping = ACESFilmicToneMapping;
  return renderer;
}

// ---- The page-wide scene ----------------------------------------------------------
function startBackdrop() {
  const canvas = document.getElementById('bg');
  const renderer = createRenderer(canvas, false);
  renderer.autoClear = false;

  const camera = new PerspectiveCamera(35, 1, 0.1, 60);
  camera.position.z = 9;
  const backScene = new Scene();
  const background = makeBackground();
  backScene.add(background.mesh);

  const scene = new Scene();
  lightScene(scene, renderer);
  const ribbon = makeRibbon();
  const ribbonGroup = new Group();
  ribbonGroup.add(ribbon.mesh);
  scene.add(ribbonGroup);

  // Switches drift in the margins at different depths and flip now and then.
  const spots = [
    [-4.4, 1.5, -1.5, 0.5, 1.6], [4.3, -1.3, 0.6, 0.62, 2.6], [3.5, 2.3, -3.2, 0.5, 1.1],
    [-3.7, -2.1, 0.9, 0.42, 3.1], [6.4, 3.1, -4.5, 0.5, 0.8],
  ].slice(0, small ? 3 : 5);
  const tokens = spots.map(([x, y, z, scale, speed], i) => {
    const toggle = makeSwitch(i % 2 === 0);
    toggle.group.scale.setScalar(scale * (small ? 0.6 : 1));
    scene.add(toggle.group);
    return { toggle, x, y, z, speed, phase: i * 1.7, nextFlip: 2.5 + i * 1.9 };
  });

  const pointer = new Vector2();
  const eased = new Vector2();
  addEventListener('pointermove', (event) => pointer.set((event.clientX / innerWidth) * 2 - 1, -((event.clientY / innerHeight) * 2 - 1)), { passive: true });

  let aspect = 1;
  function resize() {
    const width = innerWidth, height = innerHeight;
    renderer.setSize(width, height, false);
    aspect = width / height;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    background.uniforms.uRes.value.set(width, height);
  }
  addEventListener('resize', resize);
  resize();

  let time = reduced ? 14 : 0, last = performance.now(), scroll = scrollY;
  function draw(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!reduced) time += dt;
    scroll = reduced ? scrollY : mix(scroll, scrollY, 1 - Math.exp(-dt * 9));
    eased.lerp(pointer, 1 - Math.exp(-dt * 4));

    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const page = clamp(scroll / max);                       // 0 at the top, 1 at the bottom
    const hero = clamp(scroll / innerHeight);               // 0..1 across the first screen
    const end = clamp((scroll - (max - innerHeight)) / innerHeight); // 0..1 across the last screen
    const energy = clamp(1 - 0.58 * smooth(0.15, 0.95, hero) + 0.6 * smooth(0, 1, end));

    background.uniforms.uTime.value = time;
    background.uniforms.uScroll.value = page;
    background.uniforms.uEnergy.value = energy;
    background.uniforms.uPointer.value.copy(eased);

    const narrow = Math.min(1, aspect / 1.6);
    ribbon.uniforms.uTime.value = time;
    ribbon.uniforms.uTwist.value = page * 7;
    ribbon.uniforms.uOpacity.value = clamp(1 - 0.6 * smooth(0.2, 1, hero) + 0.6 * end);
    ribbonGroup.position.set(0.4 * narrow + eased.x * 0.25, mix(mix(-3.0, 3.7, smooth(0, 1.7, scroll / innerHeight)), -2.7, smooth(0, 1, end)) + eased.y * 0.15, -2.2);
    // It tumbles as the page scrolls, then settles flat under the closing call to action.
    const settle = smooth(0, 1, end);
    ribbonGroup.rotation.set(mix(0.25 + page * 2.2, 0.45, settle) + eased.y * 0.08, eased.x * 0.12, mix(-0.16 + page * 1.2, 0.14, settle));
    ribbonGroup.scale.setScalar(mix(0.62, 1, narrow));

    const travelled = scroll / innerHeight;
    // Beside the centred hero they sit close in; further down they move out to the page edges, clear of the text.
    const spread = (aspect / 1.6) * (small ? 1.25 : 1);
    const outward = mix(1, 1.3, smooth(0.3, 1, hero) * (1 - settle));
    for (const token of tokens) {
      if (!reduced && time > token.nextFlip) { token.toggle.set(!token.toggle.on); token.nextFlip = time + 4 + Math.random() * 5; }
      token.toggle.update(dt);
      // Each one rises at its own pace and wraps around, so there is depth all the way down the page.
      const y = ((token.y + travelled * token.speed + 5) % 10 + 10) % 10 - 5;
      token.toggle.group.position.set(token.x * spread * outward + eased.x * (0.2 + token.z * 0.04), y + Math.sin(time * 0.6 + token.phase) * 0.18, token.z);
      token.toggle.group.rotation.set(0.5 + Math.sin(time * 0.35 + token.phase) * 0.35 + travelled * 0.25 * token.speed, -0.5 + Math.cos(time * 0.3 + token.phase) * 0.5 + eased.x * 0.3, 0.3 + Math.sin(time * 0.25 + token.phase) * 0.3);
    }

    renderer.clear();
    renderer.render(backScene, camera);
    renderer.clearDepth();
    renderer.render(scene, camera);
  }
  return draw;
}

// ---- The 3D switch in the demo ----------------------------------------------------
function startDemoSwitch() {
  const canvas = document.getElementById('switch3d');
  if (!canvas) return null;
  const renderer = createRenderer(canvas, true);
  const scene = new Scene();
  lightScene(scene, renderer);
  const camera = new PerspectiveCamera(30, 1, 0.1, 30);
  camera.position.z = 6.2;
  const toggle = makeSwitch(false);
  scene.add(toggle.group);

  const tilt = new Vector2(), easedTilt = new Vector2();
  const host = canvas.parentElement;
  host.addEventListener('pointermove', (event) => {
    const box = host.getBoundingClientRect();
    tilt.set(((event.clientX - box.left) / box.width) * 2 - 1, ((event.clientY - box.top) / box.height) * 2 - 1);
  });
  host.addEventListener('pointerleave', () => tilt.set(0, 0));
  addEventListener('flagport:toggle', (event) => toggle.set(event.detail.on));

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  let inView = true, last = performance.now(), time = 0;
  new IntersectionObserver(([entry]) => (inView = entry.isIntersecting)).observe(canvas);
  return (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!inView) return;
    if (!reduced) time += dt;
    toggle.update(dt);
    easedTilt.lerp(tilt, 1 - Math.exp(-dt * 6));
    toggle.group.rotation.set(0.42 + easedTilt.y * 0.3 + Math.sin(time * 0.8) * 0.04, -0.5 + easedTilt.x * 0.45 + Math.sin(time * 0.6) * 0.06, 0.06);
    renderer.render(scene, camera);
  };
}

try {
  const drawBackdrop = startBackdrop();
  const drawSwitch = startDemoSwitch();
  document.documentElement.classList.add('webgl');
  if (reduced) {
    // No motion: draw a still frame, and again only when something actually changes.
    const once = () => requestAnimationFrame((now) => { drawBackdrop(now); drawSwitch?.(now); });
    once();
    addEventListener('scroll', once, { passive: true });
    addEventListener('resize', once);
    addEventListener('flagport:toggle', () => setTimeout(once, 0));
    addEventListener('flagport:theme', once);
  } else {
    const loop = (now) => {
      if (!document.hidden) { drawBackdrop(now); drawSwitch?.(now); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
} catch (error) {
  // No WebGL: the page falls back to a CSS gradient and a plain switch.
  document.documentElement.classList.add('no-webgl');
  console.warn('Flagport: 3D layer unavailable', error);
}
