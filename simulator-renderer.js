import { P, RAD, rotate, attitude, clearance } from './simulator-physics.js';

// Orthographic 3D projection of the actual quaternion state, not a planar animation.
const VIEWS = { perspective: [0.58, 0.35], front: [0, 0], side: [Math.PI / 2, 0], top: [0, Math.PI / 2] };
export class FlightRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.azimuth = VIEWS.front[0]; this.elevation = VIEWS.front[1];
    this.drag = null;
    this.sky = null;
    canvas.addEventListener('pointerdown', event => {
      this.drag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!this.drag) return;
      this.azimuth += (event.clientX - this.drag.x) * 0.008;
      this.elevation = Math.max(-0.1, Math.min(Math.PI / 2, this.elevation + (event.clientY - this.drag.y) * 0.006));
      this.drag = { x: event.clientX, y: event.clientY };
    });
    const release = () => { this.drag = null; };
    canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  }
  setCamera(name) { [this.azimuth, this.elevation] = VIEWS[name]; }
  draw(state, config, ghosts, trails, palette, searching) {
    const { ctx, w, h } = fit(this.canvas);
    const catching = config.mode === 'catch';
    const hover = config.mode === 'stabilize' || config.mode === 'monocopter';
    const worldHeight = hover ? Math.max(30, config.targetAltitude + 14, state.z + 8) : Math.max(1120, state.z + 80);
    const scale = Math.min(h * 0.86 / worldHeight, w / (hover ? 48 : 700));
    const az = this.azimuth, el = this.elevation;
    const horizontal = Math.cos(az), lateral = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    const baseX = w * 0.53, baseY = el > 1.2 ? h * 0.53 : h * 0.89;
    const project = p => ({ x: baseX + (p[0] * horizontal - p[1] * lateral) * scale,
      y: baseY - (p[2] * ce - (p[0] * lateral + p[1] * horizontal) * se) * scale,
      depth: (p[0] * lateral + p[1] * horizontal) * ce + p[2] * se });
    // Cache the deterministic sky; gradients and their bounds share local coordinates.
    // Creating a world-space gradient before transforming its fill clips bright edges.
    if (!this.sky || this.sky.width !== this.canvas.width || this.sky.height !== this.canvas.height) {
      const skyCanvas = this.canvas.ownerDocument.createElement('canvas');
      skyCanvas.width = this.canvas.width; skyCanvas.height = this.canvas.height;
      const skyContext = skyCanvas.getContext('2d');
      skyContext.scale(skyCanvas.width / w, skyCanvas.height / h);
      const sky = skyContext.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#101316'); sky.addColorStop(1, '#49535a');
      skyContext.fillStyle = sky; skyContext.fillRect(0, 0, w, h);
      for (let i = 0; i < 24; i++) {
        const x = w * ((i * 0.371) % 1), y = h * (0.25 + ((i * 0.193) % 0.7));
        const radius = w * (0.15 + (i % 4) * 0.04);
        skyContext.save(); skyContext.translate(x, y); skyContext.scale(2, 0.7);
        const cloud = skyContext.createRadialGradient(0, 0, 0, 0, 0, radius);
        cloud.addColorStop(0, '#a6b1b818'); cloud.addColorStop(1, '#a6b1b800');
        skyContext.fillStyle = cloud;
        // The whole radial support, plus an antialiasing margin, is covered.
        skyContext.fillRect(-radius - 2, -radius - 2, radius * 2 + 4, radius * 2 + 4);
        skyContext.restore();
      }
      this.sky = skyCanvas;
    }
    ctx.drawImage(this.sky, 0, 0, w, h);
    ctx.globalAlpha = 1;
    const groundSize = hover ? 30 : 380;
    if (Math.abs(el) < 0.03) {
      ctx.fillStyle = '#2d3825'; ctx.fillRect(0, baseY, w, h - baseY);
      ctx.fillStyle = '#202a1b';
      for (let x = 0; x < w; x += 4) ctx.fillRect(x, baseY - 2 - (x * 7 % 9), 3, 8);
    } else {
      polygon(ctx, [[-groundSize,-groundSize,0],[groundSize,-groundSize,0],[groundSize,groundSize,0],[-groundSize,groundSize,0]].map(project), '#2d3825');
    }
    if (catching) {
      // Schematic tower/arms share the overview's exaggerated vehicle scale.
      // Capture physics uses true clearance; this is not a structural arm model.
      ctx.strokeStyle = '#11191c'; ctx.lineWidth = 2;
      const left = 42, right = 56, towerHeight = 160;
      for (const y of [-8, 8]) {
        segment(ctx, project([left,y,0]), project([left,y,towerHeight]));
        segment(ctx, project([right,y,0]), project([right,y,towerHeight]));
        for (let z = 0; z < towerHeight; z += 14) {
          segment(ctx, project([left,y,z]), project([right,y,z+14]));
          segment(ctx, project([right,y,z]), project([left,y,z+14]));
        }
      }
      const armZ = P.catchHeight + state.vehicle.footDepth * 12 + 10;
      ctx.lineWidth = 4; ctx.strokeStyle = state.phase === 'caught' ? '#cdd5d8' : '#919c9f';
      for (const y of [-7, 7]) {
        segment(ctx, project([left,y,armZ]), project([state.phase === 'caught' ? -4 : -12,y,armZ]));
      }
    }
    const circle = (radius, z = 0) => Array.from({ length: 49 }, (_, i) => project([Math.cos(i / 48 * Math.PI * 2) * radius, Math.sin(i / 48 * Math.PI * 2) * radius, z]));
    polygon(ctx, circle(P.padTolerance), palette.pad, palette.accent);
    ctx.strokeStyle = palette.accent; ctx.lineWidth = 1;
    segment(ctx, project([-2,0,0]), project([2,0,0])); segment(ctx, project([0,-2,0]), project([0,2,0]));
    const target = project([0,0,catching ? P.catchHeight : hover ? config.targetAltitude + state.vehicle.footDepth : 0]);
    if (hover) {
      ctx.setLineDash([3, 4]); ctx.strokeStyle = '#edb28aaa';
      segment(ctx, project([0,0,0]), target);
      ctx.beginPath(); ctx.ellipse(target.x, target.y, 12, Math.max(3, 12 * se), 0, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = '#e3ebea'; ctx.font = '9px ui-monospace, monospace';
    ctx.fillText(catching ? `CATCH / ${P.catchHeight} m clearance` : hover ? `HOLD / ${config.targetAltitude} m` : 'PAD / x = y = 0', target.x + 12, target.y - 7);
    ctx.strokeStyle = '#e4eceb66';
    const rulerHeight = hover ? Math.ceil(worldHeight / 10) * 10 : 1000;
    const interval = hover ? 10 : 200;
    for (let z = 0; z <= rulerHeight; z += interval) {
      const point = project([hover ? -19 : -290,0,z]);
      if (point.y < 45 || point.y > h - 35) continue;
      segment(ctx, point, { x: point.x + 6, y: point.y });
      ctx.fillStyle = '#e4eceb99'; ctx.fillText(`${z} m`, point.x + 10, point.y + 3);
    }
    for (let i = 0; i < trails.length; i++) {
      const trail = trails[i]; ctx.beginPath();
      trail.path.forEach((point, j) => { const p = project([point.x,point.y,point.z]); if (j) ctx.lineTo(p.x,p.y); else ctx.moveTo(p.x,p.y); });
      ctx.globalAlpha = searching && i === trails.length - 1 ? 0.75 : 0.12;
      ctx.strokeStyle = trail.ok ? palette.ok : palette.bad; ctx.lineWidth = 0.8; ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const put = (s, alpha, gain = 1) => {
      ctx.save(); ctx.globalAlpha = alpha;
      // Only the landing overview exaggerates geometry; the COM trajectory stays exact.
      const lift = s.done ? (gain - 1) * Math.max(0, s.z - clearance(s)) : 0;
      const local = point => {
        const world = rotate(s.q, point);
        return project([s.x + world[0] * gain, s.y + world[1] * gain, s.z + world[2] * gain + lift]);
      };
      drawVehicle(ctx, s, local, { ...palette, ship: '#e0e5e6', muted: '#c4cccf', accent: '#d3dadd' }); ctx.restore();
    };
    const gain = hover ? 1 : 12;
    ghosts.forEach(s => put(s, 0.85, gain));
    ctx.strokeStyle = '#e6ecec55'; ctx.lineWidth = 0.8; ctx.setLineDash([3,4]);
    segment(ctx, project([state.x,state.y,0]), project([state.x,state.y,state.z])); ctx.setLineDash([]);
    put(state, 1, gain);
    // World-coordinate triad makes depth and camera rotation explicit.
    const origin = {x:32,y:h-48};
    for (const [axis, color, label] of [[[1,0,0], '#e9a17b', 'X'], [[0,1,0], '#9bd5ad', 'Y'], [[0,0,1], '#b4cce8', 'Z']]) {
      const zero = project([0,0,0]), p = project(axis);
      const end = {x:origin.x+(p.x-zero.x)/scale*20,y:origin.y+(p.y-zero.y)/scale*20};
      ctx.strokeStyle = color; segment(ctx,origin,end); ctx.fillStyle=color; ctx.fillText(label,end.x+3,end.y+3);
    }
    ctx.fillStyle = '#e5e9e9aa'; ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(hover ? '3D ORTHOGRAPHIC / GEOMETRY ×1' : '3D ORTHOGRAPHIC / VEHICLE ×12', 70, h - 32);
    // Actual state off-screen, rather than a clamped or fabricated vehicle location.
    const point = project([state.x,state.y,state.z]);
    if (point.x < 0 || point.x > w || point.y < 0 || point.y > h) {
      ctx.fillStyle = '#f1d5b5'; ctx.fillText('VEHICLE OUTSIDE VIEW · use another camera', 14, 52);
    }
    if (catching && (clearance(state) < 180 || state.done)) drawCatchInset(ctx, state, w, h, palette);
  }
}

export function fit(canvas) {
  const bounds = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, bounds.width), h = Math.max(1, bounds.height);
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}
function segment(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); }
function polygon(ctx, points, fill, stroke) {
  ctx.beginPath(); points.forEach((point,i) => { if(i) ctx.lineTo(point.x,point.y); else ctx.moveTo(point.x,point.y); }); ctx.closePath();
  if(fill) {ctx.fillStyle=fill;ctx.fill();} if(stroke) {ctx.strokeStyle=stroke;ctx.stroke();}
}
function drawCatchInset(ctx, state, w, h, palette) {
  const width = Math.min(260, w - 24), height = Math.min(216, h * 0.46);
  const left = w - width - 12, top = h - height - 64;
  const captured = state.phase === 'caught', missed = state.phase === 'missed';
  const status = captured ? 'CAPTURED · ARMS CLOSED' : missed ? 'MISSED · ARMS OPEN' : 'APPROACH · ARMS OPEN';
  const color = captured ? palette.ok : missed ? palette.bad : '#e9a17b';
  const relative = clearance(state) - P.catchHeight;
  ctx.save(); ctx.translate(left, top);
  ctx.fillStyle = '#10171bef'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#81929888'; ctx.lineWidth = 1; ctx.strokeRect(.5, .5, width - 1, height - 1);
  ctx.beginPath(); ctx.rect(1, 1, width - 2, height - 2); ctx.clip();
  ctx.font = '9px ui-monospace, monospace'; ctx.fillStyle = '#e5ecec';
  ctx.fillText('TERMINAL APPROACH · SCHEMATIC', 9, 15);
  ctx.fillStyle = color; ctx.fillText(status, 9, 29);
  const plotTop = 48, plotBottom = height - 54, plotHeight = plotBottom - plotTop;
  const sideWidth = width * .62, centerX = sideWidth * .5;
  const extent = Math.max(12, Math.abs(state.x) + state.vehicle.length);
  const bottomZ = P.catchHeight - 7;
  const topZ = Math.max(P.catchHeight + 13, state.z + state.vehicle.length * 2);
  const scale = Math.min((sideWidth - 16) / (extent * 2), plotHeight / (topZ - bottomZ));
  const side = p => ({x: centerX + p[0] * scale, y: plotBottom - (p[2] - bottomZ) * scale, depth: p[1]});
  ctx.fillStyle = '#aebfc3'; ctx.fillText('X / Z', 9, 43);
  ctx.strokeStyle = '#81929866'; ctx.setLineDash([3, 3]);
  segment(ctx, side([-extent, 0, P.catchHeight]), side([extent, 0, P.catchHeight]));
  segment(ctx, side([0, 0, bottomZ]), side([0, 0, topZ])); ctx.setLineDash([]);
  // Arms are a schematic of the capture envelope, not a structural simulation.
  // They close only after the physics engine reports an actual capture.
  const tip = captured ? state.vehicle.radius : P.catchRadius;
  ctx.strokeStyle = color; ctx.lineWidth = 3;
  for (const sign of [-1, 1]) {
    segment(ctx, side([sign * extent, 0, P.catchHeight - 5]), side([sign * extent, 0, P.catchHeight]));
    segment(ctx, side([sign * extent, 0, P.catchHeight]), side([sign * tip, 0, P.catchHeight]));
  }
  // COM position stays exact; magnify only geometry to retain readable attitude.
  const gain = Math.max(1, 13 / (state.vehicle.length * scale));
  const body = point => {
    const rotated = rotate(state.q, point);
    return side([state.x + rotated[0] * gain, state.y + rotated[1] * gain, state.z + rotated[2] * gain]);
  };
  ctx.lineWidth = 1;
  drawVehicle(ctx, state, body, {...palette, ship: '#e0e5e6', muted: '#c4cccf', accent: '#d3dadd'});
  const com = side([state.x, state.y, state.z]);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(com.x, com.y, 2, 0, Math.PI * 2); ctx.fill();
  // Plan view retains the other lateral axis: alignment is radial in X/Y.
  const depthX = sideWidth + (width - sideWidth) / 2, depthY = (plotTop + plotBottom) / 2;
  const depthRadius = Math.min((width - sideWidth) / 2 - 10, plotHeight / 2 - 7);
  const depthExtent = Math.max(P.catchRadius * 1.6, Math.hypot(state.x, state.y) + state.vehicle.radius);
  const depthScale = depthRadius / depthExtent;
  ctx.fillStyle = '#aebfc3'; ctx.fillText('X / Y', sideWidth + 7, 43);
  ctx.strokeStyle = '#81929888'; ctx.lineWidth = 1;
  segment(ctx, {x:depthX-depthRadius,y:depthY}, {x:depthX+depthRadius,y:depthY});
  segment(ctx, {x:depthX,y:depthY-depthRadius}, {x:depthX,y:depthY+depthRadius});
  ctx.strokeStyle = color; ctx.setLineDash([3, 3]); ctx.beginPath();
  ctx.arc(depthX, depthY, P.catchRadius * depthScale, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  const px = depthX + state.x * depthScale, py = depthY - state.y * depthScale;
  const axis = rotate(state.q, [0, 0, 1]);
  ctx.strokeStyle = '#e5ecec';
  segment(ctx, {x:px,y:py}, {x:px+axis[0]*12,y:py-axis[1]*12});
  ctx.fillStyle = '#e5ecec'; ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
  ctx.font = '8px ui-monospace, monospace'; ctx.fillStyle = '#aebfc3';
  ctx.fillText(`BODY ×${gain.toFixed(1)} · TRUE ATTITUDE`, 9, height - 42);
  ctx.fillText(`CATCH ${P.catchHeight}m · Δh ${relative >= 0 ? '+' : ''}${relative.toFixed(1)}m`, 9, height - 29);
  ctx.fillText(`x ${state.x.toFixed(1)}m / y ${state.y.toFixed(1)}m`, 9, height - 16);
  ctx.fillText(`CLEARANCE ${clearance(state).toFixed(1)}m`, 9, height - 5);
  ctx.restore();
}
function drawVehicle(ctx, s, project, palette) {
  const v = s.vehicle, mono = v.kind === 'monocopter';
  const radius = v.radius;
  const bottom = -v.length / 2;
  const top = mono ? v.length / 2 : v.length * 0.37;
  const ring = (z, r) => Array.from({length:12},(_,i)=>[Math.cos(i/12*Math.PI*2)*r,Math.sin(i/12*Math.PI*2)*r,z]);
  const low = ring(bottom,radius), high=ring(top,radius);
  const faces = low.map((p,i)=>{
    const j=(i+1)%12, points=[project(p),project(low[j]),project(high[j]),project(high[i])];
    return {points,depth:points.reduce((sum,p)=>sum+p.depth,0)/4,light:i%3===0};
  }).sort((a,b)=>b.depth-a.depth);
  for(const face of faces) polygon(ctx,face.points,face.light?palette.muted:palette.ship);
  polygon(ctx, high.map(project), palette.ship, palette.muted);
  if(!mono) {
    for(let i=0;i<12;i++) polygon(ctx,[project(high[i]),project(high[(i+1)%12]),project([0,0,v.length/2])],i%3===0?palette.muted:palette.ship);
    polygon(ctx, ring(-0.45,radius*1.03).map(project), palette.accent);
  }
  ctx.strokeStyle=palette.accent;ctx.lineWidth=1;
  for(const x of [-1,1]) for(const y of [-1,1]) {
    segment(ctx,project([x*radius/Math.SQRT2,y*radius/Math.SQRT2,bottom*0.6]),project([x*v.footWidth,y*v.footWidth,-v.footDepth]));
  }
  const fx=Math.tan(s.gimbal[0]),fy=Math.tan(s.gimbal[1]),norm=Math.hypot(fx,fy,1),axis=[fx/norm,fy/norm,1/norm];
  const pivot=[0,0,v.lever];
  const translated=(a,b,c)=>[pivot[0]+a,pivot[1]+b,pivot[2]+c];
  if(mono) {
    ctx.strokeStyle=palette.accent;ctx.lineWidth=1.2;
    segment(ctx,project([0,0,top]),project(pivot));
    // Prop disc normal follows the two-axis motor tilt.
    const u=[1,0,-axis[0]/axis[2]],un=Math.hypot(...u);for(let i=0;i<3;i++)u[i]/=un;
    const b=[axis[1]*u[2]-axis[2]*u[1],axis[2]*u[0]-axis[0]*u[2],axis[0]*u[1]-axis[1]*u[0]];
    const propRadius=v.length*0.65;
    const disc=Array.from({length:33},(_,i)=>{const a=i/32*Math.PI*2;return project(translated(...u.map((x,k)=>(x*Math.cos(a)+b[k]*Math.sin(a))*propRadius)));});
    ctx.globalAlpha*=0.55;polygon(ctx,disc,null,palette.accent);ctx.globalAlpha/=0.55;
    const angle=s.t*40;
    const blade=u.map((x,k)=>(x*Math.cos(angle)+b[k]*Math.sin(angle))*propRadius);
    ctx.lineWidth=2;segment(ctx,project(translated(...blade)),project(translated(...blade.map(x=>-x))));
    // Body-fixed asymmetric stripe reveals physical yaw even with a symmetric prop disc.
    ctx.strokeStyle=palette.accent;ctx.lineWidth=2;
    segment(ctx,project([radius*1.02,0,bottom]),project([radius*1.02,0,top]));
  } else {
    const nozzle=translated(-axis[0]*0.2,-axis[1]*0.2,-axis[2]*0.2);
    ctx.strokeStyle=palette.accent;ctx.lineWidth=3;segment(ctx,project(pivot),project(nozzle));
    if(s.thrust>1) {
      const length=0.3+2.1*s.thrust/v.maxThrust;
      ctx.strokeStyle='#ffb780';ctx.lineWidth=2;
      segment(ctx,project(nozzle),project(translated(-axis[0]*length,-axis[1]*length,-axis[2]*length)));
    }
  }
}
export function drawCloseup(canvas, state, palette) {
  const {ctx,w,h}=fit(canvas);ctx.clearRect(0,0,w,h);
  const scale=Math.min(h/(state.vehicle.kind==='monocopter'?2.5:5.5),w/4);
  const az=0.6, el=0.2;
  const worldProject=p=>({x:w*.5+(p[0]*Math.cos(az)-p[1]*Math.sin(az))*scale,
    y:h*.53-(p[2]*Math.cos(el)-(p[0]*Math.sin(az)+p[1]*Math.cos(az))*Math.sin(el))*scale,depth:p[0]*Math.sin(az)+p[1]*Math.cos(az)});
  const project=point=>worldProject(rotate(state.q,point));
  const roll=state.reference.roll,pitch=state.reference.pitch;
  const target=[Math.sin(pitch)*Math.cos(roll),-Math.sin(roll),Math.cos(pitch)*Math.cos(roll)];
  const axisLength=state.vehicle.kind==='monocopter'?0.8:1.9;
  ctx.strokeStyle=palette.accent;ctx.setLineDash([3,4]);ctx.lineWidth=1;
  segment(ctx,worldProject(target.map(v=>-v*axisLength)),worldProject(target.map(v=>v*axisLength)));ctx.setLineDash([]);
  drawVehicle(ctx,state,project,palette);
  const speed=Math.hypot(state.vx,state.vy,state.vz);
  if(speed>0.05){
    const origin={x:w-28,y:35},direction=worldProject([state.vx/speed,state.vy/speed,state.vz/speed]),zero=worldProject([0,0,0]);
    const end={x:origin.x+(direction.x-zero.x)/scale*20,y:origin.y+(direction.y-zero.y)/scale*20};
    ctx.strokeStyle=palette.ink;ctx.lineWidth=1;segment(ctx,origin,end);
    const angle=Math.atan2(end.y-origin.y,end.x-origin.x);
    polygon(ctx,[end,{x:end.x-5*Math.cos(angle-.5),y:end.y-5*Math.sin(angle-.5)},{x:end.x-5*Math.cos(angle+.5),y:end.y-5*Math.sin(angle+.5)}],palette.ink);
  }
  ctx.fillStyle=palette.muted;ctx.font='9px ui-monospace, monospace';ctx.fillText(state.phase.toUpperCase(),2,12);
  const a=attitude(state);ctx.fillText(`tilt ${(a.tilt/RAD).toFixed(1)}°`,2,h-3);
}
export function drawSeries(canvas, history, time, fields, palette, {minimum=15, yaw=false, unit='°'}={}) {
  const {ctx,w,h}=fit(canvas);ctx.clearRect(0,0,w,h);
  const left=unit==='m/s'?48:yaw?37:30,top=9,width=w-left-5,height=h-29,tMax=Math.max(30,time);
  let range=minimum;
  for(const point of history)for(const field of fields)range=Math.max(range,Math.abs(point[field]));
  range=Math.ceil(range/minimum)*minimum;
  const x=t=>left+t/tMax*width,y=v=>top+(range-v)/(range*2)*height;
  ctx.font='9px ui-monospace, monospace';ctx.fillStyle=palette.muted;ctx.lineWidth=.6;
  for(const value of [-range,0,range]){ctx.strokeStyle=palette.rule;segment(ctx,{x:left,y:y(value)},{x:left+width,y:y(value)});ctx.fillText(`${Math.round(value)}${unit}`,0,y(value)+3);}
  for(let t=10;t<=tMax;t+=10)ctx.fillText(`${t}s`,x(t)-8,h-3);
  fields.forEach((field,index)=>{ctx.beginPath();ctx.setLineDash(index===0?[]:index===1?[4,3]:[1,3]);ctx.strokeStyle=index===0?palette.ink:index===1?palette.accent:palette.ok;ctx.lineWidth=1.4;
    history.forEach((point,i)=>{if(i)ctx.lineTo(x(point.t),y(point[field]));else ctx.moveTo(x(point.t),y(point[field]));});ctx.stroke();});ctx.setLineDash([]);
}
export function drawSearch(canvas, log, palette) {
  if(canvas.hidden)return;
  const {ctx,w,h}=fit(canvas);ctx.clearRect(0,0,w,h);
  const x=n=>25+(n+.5)/73*(w-30),y=v=>6+(100-v)/100*(h-14);
  ctx.fillStyle=palette.muted;ctx.strokeStyle=palette.rule;ctx.lineWidth=.6;ctx.font='9px ui-monospace, monospace';
  for(const value of [0,100]){ctx.fillText(value,0,y(value)+3);segment(ctx,{x:25,y:y(value)},{x:w,y:y(value)});}
  let best=0;ctx.beginPath();ctx.strokeStyle=palette.accent;ctx.lineWidth=1.3;
  log.forEach((entry,i)=>{if(entry.ok)best=Math.max(best,entry.score);if(i)ctx.lineTo(x(i),y(best));else ctx.moveTo(x(i),y(best));});ctx.stroke();
  log.forEach((entry,i)=>{ctx.beginPath();ctx.arc(x(i),y(entry.score),1.8,0,Math.PI*2);ctx.fillStyle=entry.ok?palette.ok:palette.bad;ctx.fill();});
}
