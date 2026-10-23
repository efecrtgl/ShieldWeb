/**
 * LightPillar Component - Vanilla JS + Three.js (React Bits Integration)
 * Matches exact WebGL Shader & mathematical distortion parameters
 */
(function () {
  function initLightPillar(containerOrId, options) {
    options = options || {};
    const container = typeof containerOrId === 'string'
      ? document.getElementById(containerOrId)
      : containerOrId;

    if (!container) return;

    if (typeof THREE === 'undefined') {
      console.warn('[LightPillar] Three.js library not detected. Please ensure three.min.js is loaded.');
      return;
    }

    const config = {
      topColor: options.topColor || '#ffffff',
      bottomColor: options.bottomColor || '#000000',
      intensity: options.intensity !== undefined ? options.intensity : 1.2,
      rotationSpeed: options.rotationSpeed !== undefined ? options.rotationSpeed : 0.6,
      interactive: options.interactive !== undefined ? options.interactive : false,
      glowAmount: options.glowAmount !== undefined ? options.glowAmount : 0.001,
      pillarWidth: options.pillarWidth !== undefined ? options.pillarWidth : 6.5,
      pillarHeight: options.pillarHeight !== undefined ? options.pillarHeight : 0.4,
      noiseIntensity: options.noiseIntensity !== undefined ? options.noiseIntensity : 0.0,
      mixBlendMode: options.mixBlendMode || 'luminosity',
      pillarRotation: options.pillarRotation !== undefined ? options.pillarRotation : 49,
      quality: options.quality || 'high',
      lightMode: options.lightMode !== undefined ? options.lightMode : false
    };

    if (config.mixBlendMode) {
      container.style.mixBlendMode = config.mixBlendMode;
    }

    // Check WebGL support
    const canvasTest = document.createElement('canvas');
    const gl = canvasTest.getContext('webgl') || canvasTest.getContext('experimental-webgl');
    if (!gl) {
      container.classList.add('light-pillar-fallback');
      container.innerHTML = '<div class="light-pillar-fallback">WebGL not supported</div>';
      return;
    }

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mouse = new THREE.Vector2(0, 0);

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isLowEndDevice = isMobile || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

    let effectiveQuality = config.quality;
    if (isLowEndDevice && config.quality === 'high') effectiveQuality = 'medium';
    if (isMobile && config.quality !== 'low') effectiveQuality = 'low';

    const qualitySettings = {
      low: { iterations: 20, waveIterations: 1, pixelRatio: 0.5, precision: 'mediump', stepMultiplier: 1.5 },
      medium: { iterations: 30, waveIterations: 2, pixelRatio: 0.75, precision: 'mediump', stepMultiplier: 1.3 },
      high: {
        iterations: 42,
        waveIterations: 2,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 1.25),
        precision: 'mediump',
        stepMultiplier: 1.2
      }
    };

    const settings = qualitySettings[effectiveQuality] || qualitySettings.medium;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        powerPreference: effectiveQuality === 'high' ? 'high-performance' : 'low-power',
        precision: settings.precision,
        stencil: false,
        depth: false
      });
    } catch (e) {
      container.classList.add('light-pillar-fallback');
      return;
    }

    renderer.setSize(width, height);
    renderer.setPixelRatio(settings.pixelRatio);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.top = '0';
    renderer.domElement.style.left = '0';
    renderer.domElement.style.pointerEvents = 'none';

    container.appendChild(renderer.domElement);

    const parseColor = function (hex) {
      const color = new THREE.Color(hex);
      return new THREE.Vector3(color.r, color.g, color.b);
    };

    const vertexShader = `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      precision ${settings.precision} float;

      uniform float uTime;
      uniform vec2 uResolution;
      uniform vec2 uMouse;
      uniform vec3 uTopColor;
      uniform vec3 uBottomColor;
      uniform float uIntensity;
      uniform bool uInteractive;
      uniform float uGlowAmount;
      uniform float uPillarWidth;
      uniform float uPillarHeight;
      uniform float uNoiseIntensity;
      uniform float uLightMode;
      uniform float uRotCos;
      uniform float uRotSin;
      uniform float uPillarRotCos;
      uniform float uPillarRotSin;
      uniform float uWaveSin;
      uniform float uWaveCos;
      varying vec2 vUv;

      const float STEP_MULT = ${settings.stepMultiplier.toFixed(1)};
      const int MAX_ITER = ${settings.iterations};
      const int WAVE_ITER = ${settings.waveIterations};

      void main() {
        vec2 uv = (vUv * 2.0 - 1.0) * vec2(uResolution.x / uResolution.y, 1.0);
        uv = vec2(uPillarRotCos * uv.x - uPillarRotSin * uv.y, uPillarRotSin * uv.x + uPillarRotCos * uv.y);

        vec3 ro = vec3(0.0, 0.0, -10.0);
        vec3 rd = normalize(vec3(uv, 1.0));

        float rotC = uRotCos;
        float rotS = uRotSin;
        if(uInteractive && (uMouse.x != 0.0 || uMouse.y != 0.0)) {
          float a = uMouse.x * 6.283185;
          rotC = cos(a);
          rotS = sin(a);
        }

        vec3 col = vec3(0.0);
        float t = 0.1;
        
        for(int i = 0; i < MAX_ITER; i++) {
          vec3 p = ro + rd * t;
          p.xz = vec2(rotC * p.x - rotS * p.z, rotS * p.x + rotC * p.z);

          vec3 q = p;
          q.y = p.y * uPillarHeight + uTime;
          
          float freq = 1.0;
          float amp = 1.0;
          for(int j = 0; j < WAVE_ITER; j++) {
            q.xz = vec2(uWaveCos * q.x - uWaveSin * q.z, uWaveSin * q.x + uWaveCos * q.z);
            q += cos(q.zxy * freq - uTime * float(j) * 2.0) * amp;
            freq *= 2.0;
            amp *= 0.5;
          }
          
          float d = length(cos(q.xz)) - 0.2;
          float bound = length(p.xz) - uPillarWidth;
          float k = 4.0;
          float h = max(k - abs(d - bound), 0.0);
          d = max(d, bound) + h * h * 0.0625 / k;
          d = abs(d) * 0.15 + 0.01;

          float grad = clamp((15.0 - p.y) / 30.0, 0.0, 1.0);
          col += mix(uBottomColor, uTopColor, grad) / d;

          t += d * STEP_MULT;
          if(t > 50.0) break;
        }

        float widthNorm = uPillarWidth / 3.0;
        col = tanh(col * uGlowAmount / widthNorm);
        
        col -= fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 15.0 * uNoiseIntensity;
        
        vec3 result = clamp(col * uIntensity, 0.0, 1.0);
        if (uLightMode > 0.5) {
          float energy = max(result.r, max(result.g, result.b));
          vec3 hue = result / max(energy, 0.001);
          float coverage = smoothstep(0.025, 0.95, energy);
          hue = pow(clamp(hue, 0.0, 1.0), vec3(1.25));
          result = mix(vec3(1.0), hue, coverage * 0.94);
        }
        gl_FragColor = vec4(result, 1.0);
      }
    `;

    const pillarRotRad = (config.pillarRotation * Math.PI) / 180;
    const waveSin = Math.sin(0.4);
    const waveCos = Math.cos(0.4);

    const material = new THREE.ShaderMaterial({
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(width, height) },
        uMouse: { value: mouse },
        uTopColor: { value: parseColor(config.topColor) },
        uBottomColor: { value: parseColor(config.bottomColor) },
        uIntensity: { value: config.intensity },
        uInteractive: { value: config.interactive },
        uGlowAmount: { value: config.glowAmount },
        uPillarWidth: { value: config.pillarWidth },
        uPillarHeight: { value: config.pillarHeight },
        uNoiseIntensity: { value: config.noiseIntensity },
        uLightMode: { value: config.lightMode ? 1 : 0 },
        uRotCos: { value: 1.0 },
        uRotSin: { value: 0.0 },
        uPillarRotCos: { value: Math.cos(pillarRotRad) },
        uPillarRotSin: { value: Math.sin(pillarRotRad) },
        uWaveSin: { value: waveSin },
        uWaveCos: { value: waveCos }
      },
      transparent: true,
      depthWrite: false,
      depthTest: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    if (config.interactive) {
      let mouseMoveTimeout = null;
      container.addEventListener('mousemove', function (event) {
        if (mouseMoveTimeout) return;
        mouseMoveTimeout = window.setTimeout(function () {
          mouseMoveTimeout = null;
        }, 16);
        const rect = container.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        mouse.set(x, y);
      }, { passive: true });
    }

    let time = 0;
    let lastTime = performance.now();
    const targetFPS = 30;
    const frameTime = 1000 / targetFPS;
    let animFrameId = null;
    let isRunning = false;

    function animate(currentTime) {
      if (!isRunning) return;
      const deltaTime = currentTime - lastTime;
      if (deltaTime >= frameTime) {
        time += 0.016 * config.rotationSpeed;
        material.uniforms.uTime.value = time;
        material.uniforms.uRotCos.value = Math.cos(time * 0.3);
        material.uniforms.uRotSin.value = Math.sin(time * 0.3);
        renderer.render(scene, camera);
        lastTime = currentTime - (deltaTime % frameTime);
      }
      animFrameId = requestAnimationFrame(animate);
    }

    function startLoop() {
      if (isRunning) return;
      isRunning = true;
      lastTime = performance.now();
      animFrameId = requestAnimationFrame(animate);
    }

    function stopLoop() {
      isRunning = false;
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = null;
      }
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        stopLoop();
      } else {
        startLoop();
      }
    });

    if (!document.hidden) {
      startLoop();
    }

    let resizeTimeout = null;
    window.addEventListener('resize', function () {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(function () {
        const newW = container.clientWidth || window.innerWidth;
        const newH = container.clientHeight || window.innerHeight;
        renderer.setSize(newW, newH);
        material.uniforms.uResolution.value.set(newW, newH);
      }, 150);
    }, { passive: true });
  }

  window.initLightPillar = initLightPillar;

  // Auto initialize when DOM is loaded
  document.addEventListener('DOMContentLoaded', function () {
    const defaultEl = document.getElementById('light-pillar-bg');
    if (defaultEl) {
      initLightPillar(defaultEl, {
        topColor: defaultEl.dataset.topColor || '#ffffff',
        bottomColor: defaultEl.dataset.bottomColor || '#000000',
        intensity: parseFloat(defaultEl.dataset.intensity || '1.2'),
        rotationSpeed: parseFloat(defaultEl.dataset.rotationSpeed || '0.6'),
        glowAmount: parseFloat(defaultEl.dataset.glowAmount || '0.001'),
        pillarWidth: parseFloat(defaultEl.dataset.pillarWidth || '6.5'),
        pillarHeight: parseFloat(defaultEl.dataset.pillarHeight || '0.4'),
        noiseIntensity: parseFloat(defaultEl.dataset.noiseIntensity || '0'),
        pillarRotation: parseFloat(defaultEl.dataset.pillarRotation || '49'),
        interactive: defaultEl.dataset.interactive === 'true',
        mixBlendMode: defaultEl.dataset.mixBlendMode || 'luminosity'
      });
    }
  });
})();
