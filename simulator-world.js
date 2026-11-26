import * as THREE from './vendor/three.module.js';

// Decorative scenery only: all flight and contact decisions belong to the physics model.
export function createWorld(renderer) {
  const scene = new THREE.Scene();
  scene.up.set(0, 0, 1);
  scene.fog = new THREE.FogExp2(0xb9cbd3, 0.000115);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  let seed = 912773;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const canvas = (width, height) => {
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    return image;
  };
  const texture = (image, repeat = 1, color = true) => {
    const map = new THREE.CanvasTexture(image);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(repeat, repeat);
    map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (color) map.colorSpace = THREE.SRGBColorSpace;
    return map;
  };

  const groundImage = canvas(512, 512);
  const groundContext = groundImage.getContext('2d');
  const bumpImage = canvas(512, 512);
  const bumpContext = bumpImage.getContext('2d');
  const groundPixels = groundContext.createImageData(512, 512);
  const bumpPixels = bumpContext.createImageData(512, 512);
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 4;
      const grain = random();
      const patch = Math.sin(x * 0.049 + Math.sin(y * 0.024) * 3)
        * Math.sin(y * 0.037 + Math.cos(x * 0.017) * 2);
      groundPixels.data[i] = 117 + grain * 23 + patch * 13;
      groundPixels.data[i + 1] = 121 + grain * 24 + patch * 18;
      groundPixels.data[i + 2] = 94 + grain * 17 + patch * 10;
      groundPixels.data[i + 3] = 255;
      const relief = 80 + grain * 110 + patch * 20;
      bumpPixels.data[i] = bumpPixels.data[i + 1] = bumpPixels.data[i + 2] = relief;
      bumpPixels.data[i + 3] = 255;
    }
  }
  groundContext.putImageData(groundPixels, 0, 0);
  bumpContext.putImageData(bumpPixels, 0, 0);
  const groundMaterial = new THREE.MeshStandardMaterial({
    map: texture(groundImage, 240), bumpMap: texture(bumpImage, 240, false),
    bumpScale: 0.15, roughness: 0.98, color: 0xc6c5a6,
  });
  const terrainGeometry = new THREE.PlaneGeometry(11000, 11000, 144, 144);
  const positions = terrainGeometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i);
    const distance = Math.hypot(x, y);
    // A cell's diagonal must also stay outside the 300 m level safety apron.
    const blend = Math.min(1, Math.max(0, (distance - 410) / 950));
    const rolling = 140 + 100 * Math.sin(x * 0.0018 + y * 0.0007)
      + 74 * Math.cos(y * 0.0026 - x * 0.0005)
      + 42 * Math.sin(x * 0.0052) * Math.cos(y * 0.0041);
    const ridge = 190 * Math.exp(-(((distance - 3500) / 1100) ** 2))
      * (0.6 + 0.4 * Math.sin(Math.atan2(y, x) * 7 + 0.6));
    positions.setZ(i, -0.06 + blend * blend * (rolling + ridge));
  }
  terrainGeometry.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeometry, groundMaterial);
  terrain.receiveShadow = true;
  scene.add(terrain);

  const skyDirection = new THREE.Vector3(-0.45, -0.32, 0.83).normalize();
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDirection: { value: skyDirection } },
    vertexShader: `
      varying vec3 skyRay;
      void main() {
        skyRay = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 skyRay;
      uniform vec3 sunDirection;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
          mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
      }
      void main() {
        vec3 ray = normalize(skyRay);
        float elevation = max(ray.z, 0.0);
        vec3 horizon = vec3(0.70, 0.80, 0.85);
        vec3 zenith = vec3(0.19, 0.43, 0.69);
        vec3 color = mix(horizon, zenith, pow(elevation, 0.48));
        vec2 cloudUV = ray.xy / max(0.12, ray.z + 0.17) * 3.5;
        float clouds = noise(cloudUV) * 0.57 + noise(cloudUV * 2.1) * 0.28
          + noise(cloudUV * 4.3) * 0.15;
        float cover = smoothstep(0.56, 0.79, clouds)
          * smoothstep(0.02, 0.16, ray.z) * (1.0 - smoothstep(0.65, 0.98, ray.z));
        color = mix(color, vec3(0.94, 0.95, 0.94), cover * 0.75);
        float sun = max(dot(ray, sunDirection), 0.0);
        color += vec3(0.18, 0.13, 0.06) * pow(sun, 32.0);
        color += vec3(4.0, 3.55, 2.7) * smoothstep(0.999955, 0.999982, sun);
        color = mix(vec3(0.58, 0.65, 0.66), color, smoothstep(-0.15, 0.0, ray.z));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10000, 32, 16), skyMaterial);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.onBeforeRender = function (_renderer, _scene, camera) {
    this.position.setFromMatrixPosition(camera.matrixWorld);
    this.updateMatrixWorld();
  };
  scene.add(sky);

  // A small, generated environment gives bare and painted metal real sky reflections.
  const environmentImage = canvas(512, 256);
  const environmentContext = environmentImage.getContext('2d');
  const environmentGradient = environmentContext.createLinearGradient(0, 0, 0, 256);
  environmentGradient.addColorStop(0, '#608eba');
  environmentGradient.addColorStop(0.36, '#b0cbdc');
  environmentGradient.addColorStop(0.49, '#dfE6e6');
  environmentGradient.addColorStop(0.52, '#9b9e89');
  environmentGradient.addColorStop(1, '#66694f');
  environmentContext.fillStyle = environmentGradient;
  environmentContext.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 40; i++) {
    environmentContext.fillStyle = `rgba(255,255,255,${0.03 + random() * 0.09})`;
    environmentContext.beginPath();
    environmentContext.ellipse(random() * 512, 35 + random() * 73,
      12 + random() * 44, 2 + random() * 7, 0, 0, Math.PI * 2);
    environmentContext.fill();
  }
  const sunU = Math.atan2(-skyDirection.y, skyDirection.x) / (Math.PI * 2) + 0.5;
  // Equirectangular environments use Y up; rotate into this scene's Z-up frame.
  const sunV = Math.acos(skyDirection.z) / Math.PI;
  const glow = environmentContext.createRadialGradient(sunU * 512, sunV * 256, 1,
    sunU * 512, sunV * 256, 24);
  glow.addColorStop(0, '#fff7d7');
  glow.addColorStop(0.12, 'rgba(255,247,215,0.8)');
  glow.addColorStop(1, 'rgba(255,247,215,0)');
  environmentContext.fillStyle = glow;
  environmentContext.fillRect(0, 0, 512, 128);
  const environmentTexture = new THREE.CanvasTexture(environmentImage);
  environmentTexture.colorSpace = THREE.SRGBColorSpace;
  environmentTexture.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromEquirectangular(environmentTexture);
  scene.environment = environmentTarget.texture;
  scene.environmentRotation.x = Math.PI / 2;
  scene.environmentIntensity = 0.65;
  scene.userData.environmentTarget = environmentTarget;
  environmentTexture.dispose();
  pmrem.dispose();

  const fill = new THREE.HemisphereLight(0xc9e1f2, 0x8d8871, 2.3);
  fill.position.set(0, 0, 1);
  scene.add(fill);
  const sun = new THREE.DirectionalLight(0xfff3dc, 3.1);
  sun.castShadow = true;
  const shadowSize = renderer.capabilities.maxTextureSize >= 2048 ? 2048 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -32;
  sun.shadow.camera.right = sun.shadow.camera.top = 32;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 290;
  sun.shadow.camera.up.set(0, 0, 1);
  sun.shadow.normalBias = 0.025;
  sun.shadow.bias = -0.00012;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const standard = (color, roughness = 0.8, metalness = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const concrete = standard(0xb0b1a9);
  const steel = standard(0x88979a, 0.48, 0.72);
  const darkSteel = standard(0x3f4d51, 0.58, 0.65);
  const white = standard(0xe2e3dd, 0.73, 0.18);
  const yellow = standard(0xc7a644, 0.7, 0.15);
  const roadMaterial = standard(0x535854, 0.96);
  const boxes = (items, material, parent = scene, shadows = true) => {
    const mesh = new THREE.InstancedMesh(boxGeometry, material, items.length);
    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      position.set(b[0], b[1], b[2]);
      scale.set(b[3], b[4], b[5]);
      rotation.setFromAxisAngle(zAxis, b[6] || 0);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  boxes([[0, -145, -0.015, 10, 238, 0.06], [71, -76, -0.015, 142, 8, 0.06]], roadMaterial, scene, false);
  const roadStripes = [];
  for (let y = -45; y > -260; y -= 15) roadStripes.push([0, y, 0.021, 0.18, 6, 0.01]);
  boxes(roadStripes, white, scene, false);

  const padImage = canvas(1024, 1024);
  const padContext = padImage.getContext('2d');
  padContext.fillStyle = '#acafa9';
  padContext.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 18000; i++) {
    const light = random() > 0.5;
    padContext.fillStyle = light ? 'rgba(245,243,229,0.065)' : 'rgba(32,35,31,0.055)';
    padContext.fillRect(random() * 1024, random() * 1024, 1 + random() * 5, 1 + random() * 3);
  }
  padContext.strokeStyle = 'rgba(62,65,61,0.28)';
  padContext.lineWidth = 1.4;
  for (let i = 128; i < 1024; i += 128) {
    padContext.beginPath(); padContext.moveTo(i, 0); padContext.lineTo(i, 1024); padContext.stroke();
    padContext.beginPath(); padContext.moveTo(0, i); padContext.lineTo(1024, i); padContext.stroke();
  }
  const scorch = padContext.createRadialGradient(512, 512, 8, 512, 512, 145);
  scorch.addColorStop(0, 'rgba(33,30,26,0.42)');
  scorch.addColorStop(0.5, 'rgba(53,48,40,0.18)');
  scorch.addColorStop(1, 'rgba(53,48,40,0)');
  padContext.fillStyle = scorch;
  padContext.fillRect(0, 0, 1024, 1024);
  padContext.strokeStyle = '#d7c46f';
  padContext.lineWidth = 9;
  padContext.beginPath(); padContext.arc(512, 512, 476, 0, Math.PI * 2); padContext.stroke();
  padContext.strokeStyle = '#ece9d9';
  padContext.lineWidth = 7;
  padContext.beginPath(); padContext.arc(512, 512, 61.44, 0, Math.PI * 2); padContext.stroke();
  padContext.lineWidth = 12;
  padContext.beginPath();
  padContext.moveTo(450.56, 512); padContext.lineTo(573.44, 512);
  padContext.moveTo(512, 450.56); padContext.lineTo(512, 573.44); padContext.stroke();
  // Small chips break up the paint without an animated or artificial impact mark.
  for (let i = 0; i < 900; i++) {
    padContext.fillStyle = 'rgba(119,120,111,0.22)';
    padContext.fillRect(random() * 1024, random() * 1024, 1 + random() * 4, 1 + random() * 3);
  }
  const padTop = new THREE.Mesh(new THREE.CircleGeometry(25, 96),
    new THREE.MeshStandardMaterial({ map: texture(padImage), roughness: 0.94,
      bumpMap: texture(bumpImage, 6, false), bumpScale: 0.025 }));
  padTop.position.z = 0.002;
  padTop.receiveShadow = true;
  scene.add(padTop);
  const padBase = new THREE.Mesh(new THREE.CylinderGeometry(25, 25.3, 0.36, 96, 1, true), concrete);
  padBase.rotation.x = Math.PI / 2;
  padBase.position.z = -0.18;
  padBase.receiveShadow = true;
  scene.add(padBase);

  const fencePosts = [], fenceRails = [], fenceWire = [];
  const fenceRadius = 29;
  for (let i = 0; i < 72; i++) {
    const angle = i / 72 * Math.PI * 2;
    // The southern opening connects the service road to the pad.
    if (Math.sin(angle) < -0.975) continue;
    const next = angle + Math.PI * 2 / 72;
    const x = Math.cos(angle) * fenceRadius, y = Math.sin(angle) * fenceRadius;
    fencePosts.push([x, y, 1.05, 0.085, 0.085, 2.1]);
    for (const height of [0.35, 1.95]) {
      fenceRails.push([Math.cos((angle + next) / 2) * fenceRadius,
        Math.sin((angle + next) / 2) * fenceRadius, height, 2.57, 0.035, 0.035, angle + Math.PI / 2 + Math.PI / 72]);
    }
    for (let j = 0; j < 7; j++) {
      const a = angle + (next - angle) * j / 7;
      fenceWire.push(Math.cos(a) * fenceRadius, Math.sin(a) * fenceRadius, 0.35,
        Math.cos(a + 0.035) * fenceRadius, Math.sin(a + 0.035) * fenceRadius, 1.95);
      fenceWire.push(Math.cos(a) * fenceRadius, Math.sin(a) * fenceRadius, 1.95,
        Math.cos(a + 0.035) * fenceRadius, Math.sin(a + 0.035) * fenceRadius, 0.35);
    }
  }
  boxes(fencePosts, steel);
  boxes(fenceRails, steel, scene, false);
  const wireGeometry = new THREE.BufferGeometry();
  wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(fenceWire, 3));
  scene.add(new THREE.LineSegments(wireGeometry,
    new THREE.LineBasicMaterial({ color: 0x6e7e7e, transparent: true, opacity: 0.38 })));

  const buildingShells = [], buildingRoofs = [], buildingDetails = [], windows = [], foundations = [];
  const sites = [[93, 74, 34, 23, 13], [-116, 88, 48, 24, 18], [155, -65, 32, 23, 11],
    [-145, -119, 22, 18, 9], [202, 124, 52, 29, 16]];
  for (const [x, y, width, depth, height] of sites) {
    foundations.push([x, y, 0.07, width + 12, depth + 12, 0.2]);
    buildingShells.push([x, y, height / 2, width, depth, height]);
    buildingRoofs.push([x, y, height + 0.18, width + 1, depth + 1, 0.36]);
    for (let a = -width / 2 + 1; a < width / 2; a += 3) {
      buildingDetails.push([x + a, y - depth / 2 - 0.06, height / 2, 0.1, 0.12, height]);
    }
    buildingDetails.push([x, y - depth / 2 - 0.12, 3, 7, 0.15, 6]);
    for (let a = -width / 2 + 5; a < width / 2; a += 6) {
      windows.push([x + a, y - depth / 2 - 0.14, height - 3, 3.3, 0.12, 1.25]);
    }
    buildingDetails.push([x + width / 4, y, height + 0.8, 4, 3, 1.3]);
  }
  boxes(foundations, concrete);
  boxes(buildingShells, standard(0xabaeaa, 0.82, 0.2));
  boxes(buildingRoofs, steel);
  boxes(buildingDetails, darkSteel);
  boxes(windows, standard(0x496370, 0.22, 0.5));
  const tankGeometry = new THREE.CylinderGeometry(3.4, 3.4, 12, 20);
  const tankCapGeometry = new THREE.SphereGeometry(3.4, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  for (let i = 0; i < 4; i++) {
    const x = 75 + i * 10, y = -108;
    const tank = new THREE.Mesh(tankGeometry, white);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(x, y, 6);
    tank.castShadow = tank.receiveShadow = true;
    scene.add(tank);
    const cap = new THREE.Mesh(tankCapGeometry, white);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(x, y, 12);
    cap.castShadow = true;
    scene.add(cap);
  }
  boxes([[90, -112, 1.5, 38, 0.4, 0.4], [75, -110, 1.5, 0.4, 4, 0.4],
    [85, -110, 1.5, 0.4, 4, 0.4], [95, -110, 1.5, 0.4, 4, 0.4],
    [105, -110, 1.5, 0.4, 4, 0.4]], steel);

  const tower = new THREE.Group();
  scene.add(tower);
  const towerColumns = [], towerPlatforms = [], towerBraces = [];
  for (const x of [10.5, 13.5]) for (const y of [-2.5, 2.5]) {
    towerColumns.push([x, y, 30, 0.48, 0.48, 60]);
  }
  for (let z = 5; z <= 60; z += 5) {
    towerPlatforms.push([12, 0, z, 3.8, 5.8, 0.18]);
    for (const y of [-2.5, 2.5]) {
      // Diagonals are built directly along the required 3-D line below.
      towerBraces.push([10.5, y, z - 5, 13.5, y, z]);
    }
    for (const x of [10.5, 13.5]) towerBraces.push([x, -2.5, z - 5, x, 2.5, z]);
  }
  boxes(towerColumns, white, tower);
  boxes(towerPlatforms, darkSteel, tower);
  const braceMesh = new THREE.InstancedMesh(boxGeometry, steel, towerBraces.length);
  const direction = new THREE.Vector3();
  for (let i = 0; i < towerBraces.length; i++) {
    const b = towerBraces[i];
    direction.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    scale.set(0.13, 0.13, direction.length());
    rotation.setFromUnitVectors(zAxis, direction.normalize());
    position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    matrix.compose(position, rotation, scale);
    braceMesh.setMatrixAt(i, matrix);
  }
  braceMesh.castShadow = true;
  tower.add(braceMesh);
  boxes([[12, 0, 0.1, 6, 8, 0.2], [14, 0, 2, 2, 2.5, 3.8]], concrete, tower);
  const armCarriage = new THREE.Group();
  tower.add(armCarriage);
  boxes([[11.5, 0, 0, 1.5, 6.5, 2.4]], yellow, armCarriage);
  const arms = [];
  for (const sign of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.y = sign * 2.6;
    armCarriage.add(arm);
    boxes([[3.1, 0, 0, 15.6, 0.42, 0.65], [3.1, 0, -1, 15.6, 0.2, 0.22],
      [9.8, 0, -0.4, 0.7, 0.9, 2]], yellow, arm);
    boxes([[0, 0, 0.36, 8, 0.6, 0.12]], darkSteel, arm);
    arms.push(arm);
  }
  // No synthetic contact shadow or capture animation: shadows come from actual meshes.
  const update = (state) => {
    sun.target.position.set(state.x, state.y, Math.max(0, state.z));
    sun.position.set(state.x + skyDirection.x * 190,
      state.y + skyDirection.y * 190, Math.max(0, state.z) + skyDirection.z * 190);
    tower.visible = state.mode === 'catch';
    armCarriage.position.z = 50 + state.vehicle.footDepth;
    const armGap = state.phase === 'caught' ? state.vehicle.radius + 0.3 : 2.6;
    arms[0].position.y = -armGap;
    arms[1].position.y = armGap;
  };
  sun.position.copy(skyDirection).multiplyScalar(190);
  tower.visible = false;
  return { scene, update };
}
