import * as THREE from './vendor/three.module.js';
import { FlightRenderer as TrajectoryRenderer } from './simulator-renderer.js?v=webgl-20261126';
import { createVehicle } from './simulator-vehicle.js';
import { createWorld } from './simulator-world.js';

// The main model stays at physical scale. Only the trajectory inset magnifies it.
export class FlightRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.container = canvas.parentElement;
    this.overview = new TrajectoryRenderer(document.getElementById('trajectory'));
    this.overview.setCamera('front');
    this.view = 'perspective';
    this.azimuth = .8; this.elevation = .28; this.zoom = 1;
    this.target = new THREE.Vector3();
    this.offset = new THREE.Vector3();
    this.camera = new THREE.PerspectiveCamera(38, 1, .03, 30000);
    this.camera.up.set(0, 0, 1);
    this.width = 0; this.height = 0;
    this.vehicle = null; this.kind = null;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.1;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.world = createWorld(this.renderer);
    } catch (error) {
      this.unavailable = true;
      document.getElementById('graphics-status').textContent = 'WebGL is unavailable. Showing the trajectory view.';
      console.error('WebGL initialization failed', error);
    }
    let drag = null;
    canvas.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      this.azimuth -= (e.clientX-drag.x)*.008;
      this.elevation = THREE.MathUtils.clamp(this.elevation+(e.clientY-drag.y)*.006,-.2,1.5);
      drag.x=e.clientX; drag.y=e.clientY;
    });
    const release = () => { drag = null; };
    canvas.addEventListener('pointerup',release);
    canvas.addEventListener('pointercancel',release);
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); this.unavailable = true;
      document.getElementById('graphics-status').textContent = 'Graphics context lost. Showing trajectory until graphics recover.';
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.unavailable = false; document.getElementById('graphics-status').textContent = '';
    });
  }
  setCamera(name) {
    this.view = name;
    const views = { perspective:[.8,.28],front:[-Math.PI/2,.08],side:[0,.08],top:[0,1.5] };
    if (views[name]) [this.azimuth,this.elevation] = views[name];
  }
  draw(state, config, ghosts, trails, palette, searching) {
    const overviewOnly = this.view === 'overview' || this.unavailable;
    this.container.dataset.view = overviewOnly ? 'overview' : 'follow';
    this.overview.draw(state,config,ghosts,trails,palette,searching);
    if (overviewOnly) return;
    const w=this.canvas.clientWidth,h=this.canvas.clientHeight;
    if (!w || !h) return;
    if (w!==this.width || h!==this.height) {
      this.width=w;this.height=h;this.renderer.setSize(w,h,false);
      this.camera.aspect=w/h;this.camera.updateProjectionMatrix();
    }
    if (this.kind!==state.vehicle.kind) {
      if (this.vehicle) { this.world.scene.remove(this.vehicle.group);this.vehicle.dispose(); }
      this.kind=state.vehicle.kind;this.vehicle=createVehicle(this.kind);
      this.world.scene.add(this.vehicle.group);
    }
    const group=this.vehicle.group,q=state.q;
    group.position.set(state.x,state.y,state.z);
    group.quaternion.set(q[1],q[2],q[3],q[0]);
    this.vehicle.update(state);
    this.world.update(state);
    this.target.set(state.x,state.y,state.z-state.vehicle.length*.12);
    const framingWidth = this.kind === 'monocopter' ? state.vehicle.length * 2 : state.vehicle.footWidth * 2.9 + .3;
    const widthDistance = framingWidth / (2 * Math.tan(this.camera.fov * Math.PI / 360) * this.camera.aspect * .82);
    const distance = Math.max(state.vehicle.length * 2.5, widthDistance) / this.zoom;
    this.offset.set(Math.cos(this.azimuth)*Math.cos(this.elevation),Math.sin(this.azimuth)*Math.cos(this.elevation),Math.sin(this.elevation)).multiplyScalar(distance);
    this.camera.position.copy(this.target).add(this.offset);
    this.camera.position.z=Math.max(.15,this.camera.position.z);
    this.camera.lookAt(this.target);
    this.renderer.render(this.world.scene,this.camera);
  }
}
