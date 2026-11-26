import * as THREE from './vendor/three.module.js';

// Vehicle-local coordinates are metres, with the thrust axis along +Z.
export function createVehicle(kind) {
  const group = new THREE.Group();
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const geometry = value => { geometries.add(value); return value; };
  const material = value => { materials.add(value); return value; };
  // These fixed, seeded surface maps are generated once, never in update().
  const hash = (x, y, seed) => {
    let value = Math.imul(x + seed, 374761393) ^ Math.imul(y + seed, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  };
  const surface = finish => {
    const width = 512;
    const height = 1024;
    const color = new Uint8Array(width * height * 4);
    const roughness = new Uint8Array(color.length);
    const relief = new Uint8Array(color.length);
    for (let y = 0; y < height; y++) {
      const brush = hash(0, y, 19) - .5;
      const heat = .5 + .5 * Math.sin(y / height * Math.PI * 1.6);
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const grain = hash(x, y, 37) - .5;
        const scratchStart = hash(x, 0, 73) * height;
        const scratched = hash(x, 0, 51) > .982 && y > scratchStart && y < scratchStart + 18 + hash(x, 0, 97) * 95;
        let r = 188 + brush * 8 + grain * 3;
        let g = 195 + brush * 8 + grain * 3;
        let b = 198 + brush * 8 + grain * 3;
        let rough = 143 + brush * 25 + grain * 8;
        let bump = 128 + brush * 10 + grain * 4;
        if (finish === 'paint') {
          r = 190 + grain * 4;
          g = 79 + grain * 3;
          b = 29 + grain * 2;
          rough = 187 + grain * 14;
          const edge = y < 8 || y > height - 9;
          if ((edge && hash(x, y >> 2, 113) > .74) || (scratched && hash(x, y, 127) > .66)) {
            r = 137; g = 144; b = 146; rough = 156;
          }
        } else if (finish === 'heat') {
          // Muted oxide/tarnish, not a bright decorative heat rainbow.
          r = 79 + heat * 30 + brush * 5 + grain * 4;
          g = 75 + heat * 17 + brush * 5 + grain * 4;
          b = 74 + (1 - heat) * 18 + brush * 5 + grain * 4;
          rough = 172 + heat * 26 + grain * 12;
        }
        if (scratched) {
          r += 10; g += 10; b += 10; rough += 18; bump -= 12;
        }
        color[offset] = r; color[offset + 1] = g; color[offset + 2] = b; color[offset + 3] = 255;
        roughness[offset] = roughness[offset + 1] = roughness[offset + 2] = rough;
        relief[offset] = relief[offset + 1] = relief[offset + 2] = bump;
        roughness[offset + 3] = relief[offset + 3] = 255;
      }
    }
    const texture = (data, srgb = false) => {
      const value = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
      value.wrapS = value.wrapT = THREE.RepeatWrapping;
      value.magFilter = THREE.LinearFilter;
      value.minFilter = THREE.LinearMipmapLinearFilter;
      value.generateMipmaps = true;
      if (srgb) value.colorSpace = THREE.SRGBColorSpace;
      value.needsUpdate = true;
      textures.add(value);
      return value;
    };
    return {map: texture(color, true), roughnessMap: texture(roughness), bumpMap: texture(relief)};
  };
  const brushed = surface('metal');
  const metal = material(new THREE.MeshStandardMaterial({...brushed, metalness: .78, roughness: .88, bumpScale: .0005}));
  const dark = material(new THREE.MeshStandardMaterial({...brushed, color: 0x41474b, metalness: .72, roughness: 1, bumpScale: .0003}));
  const orange = material(new THREE.MeshStandardMaterial({...surface('paint'), metalness: .08, roughness: .9, bumpScale: .0002}));
  const rubber = material(new THREE.MeshStandardMaterial({color: 0x202326, roughness: .93}));
  const machined = material(new THREE.MeshStandardMaterial({...brushed, color: 0xd1d6d8, metalness: .88, roughness: .68, bumpScale: .00025}));
  const add = (geo, mat, parent = group) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const cylinder = (radiusTop, radiusBottom, length, mat, z, parent = group, segments = 48) => {
    const mesh = add(geometry(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, segments)), mat, parent);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = z;
    return mesh;
  };
  const ring = (radius, tube, z, mat = dark) => {
    const mesh = add(geometry(new THREE.TorusGeometry(radius, tube, 6, 64)), mat);
    mesh.position.z = z;
    return mesh;
  };
  const from = new THREE.Vector3();
  const to = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const strut = (a, b, radius, mat, parent) => {
    from.set(...a); to.set(...b);
    direction.subVectors(to, from);
    const mesh = add(geometry(new THREE.CylinderGeometry(radius, radius, direction.length(), 10)), mat, parent);
    mesh.position.copy(from).add(to).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(yAxis, direction.normalize());
    return mesh;
  };
  const mono = kind === 'monocopter';
  const radius = mono ? .28 : .15;
  const legs = new THREE.Group();
  group.add(legs);
  const legAssemblies = [];
  // Unit leg coordinates make contact dimensions track the actual physics model.
  for (let i = 0; i < 4; i++) {
    const leg = new THREE.Group();
    leg.rotation.z = Math.PI / 4 + i * Math.PI / 2;
    legs.add(leg);
    strut([.18, 0, -.30], [.91, 0, -.925], .015, metal, leg);
    strut([.16, 0, -.73], [.94, 0, -.94], .009, dark, leg);
    // Sliding damper sleeve, exposed piston and a small clevis at the pad.
    strut([.61, 0, -.665], [.85, 0, -.874], .023, dark, leg);
    strut([.85, 0, -.874], [1, 0, -.964], .010, machined, leg);
    for (const side of [-1, 1]) {
      strut([.91, side * .024, -.925], [1, side * .024, -.967], .009, metal, leg);
    }
    const hinge = add(geometry(new THREE.CylinderGeometry(.022, .022, .075, 16)), dark, leg);
    hinge.position.set(1, 0, -.961);
    // The sole still ends at unit depth -1; the contact centre stays (1, 0).
    const foot = cylinder(.094, .104, .028, metal, -.98, leg, 40);
    foot.position.x = 1;
    const sole = cylinder(.101, .101, .006, rubber, -.997, leg, 40);
    sole.position.x = 1;
    const hub = cylinder(.037, .042, .015, machined, -.9585, leg, 24);
    hub.position.x = 1;
    legAssemblies.push(leg);
  }

  let rotor;
  const engine = new THREE.Group();
  if (mono) {
    cylinder(.22, .24, .44, metal, -.035);
    cylinder(.28, .28, .055, orange, .17);
    cylinder(.19, .22, .12, dark, -.315);
    const dome = add(geometry(new THREE.SphereGeometry(.22, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2)), metal);
    dome.rotation.x = Math.PI / 2;
    dome.position.z = .185;
    for (let i = 0; i < 8; i++) {
      const vent = add(geometry(new THREE.BoxGeometry(.022, .07, .12)), dark);
      const angle = i * Math.PI / 4;
      vent.position.set(Math.cos(angle) * .228, Math.sin(angle) * .228, -.06);
      vent.rotation.z = angle;
    }
    engine.position.z = -.45;
    group.add(engine);
    cylinder(.045, .045, .15, dark, .04, engine);
    rotor = new THREE.Group();
    engine.add(rotor);
    const bladeGeometry = geometry(new THREE.BoxGeometry(.72, .075, .012));
    for (let i = 0; i < 2; i++) {
      const blade = add(bladeGeometry, dark, rotor);
      blade.position.x = i === 0 ? .37 : -.37;
      blade.rotation.x = .13;
    }
    cylinder(.065, .065, .045, metal, 0, engine);
    const discMaterial = material(new THREE.MeshBasicMaterial({color: 0xa6c5cd, transparent: true, opacity: .09, side: THREE.DoubleSide, depthWrite: false}));
    const disc = add(geometry(new THREE.CircleGeometry(.73, 80)), discMaterial, rotor);
    disc.castShadow = false;
    disc.receiveShadow = false;
  } else {
    cylinder(radius, radius, 2.455, metal, -.1525);
    // Tangent-ogive-like profile; lathe's Y axis is rotated to local Z.
    const profile = [];
    for (let i = 0; i <= 24; i++) {
      const u = i / 24;
      profile.push(new THREE.Vector2(radius * Math.cos(u * Math.PI / 2), u * .425));
    }
    const nose = add(geometry(new THREE.LatheGeometry(profile, 64)), metal);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 1.075;
    cylinder(.151, .151, .16, orange, .73);
    const heatMetal = material(new THREE.MeshStandardMaterial({...surface('heat'), metalness: .76, roughness: .94, bumpScale: .00065, side: THREE.DoubleSide}));
    cylinder(.145, .13, .16, heatMetal, -1.42);
    const weld = material(new THREE.MeshStandardMaterial({color: 0x9ba5a8, metalness: .82, roughness: .57}));
    for (const z of [-1.28, -.78, .28, 1.075]) ring(.1501, .0008, z, weld);
    for (const z of [.65, .81]) ring(.1506, .0005, z, orange);
    const seam = cylinder(.00065, .00065, 2.4, weld, -.15, group, 6);
    seam.position.x = -.15;
    // Small flush service plate rather than rows of overscale tank rivets.
    const panel = add(geometry(new THREE.CylinderGeometry(.1506, .1506, .16, 16, 1, true, -.24, .48)), dark);
    panel.rotation.x = Math.PI / 2;
    panel.position.z = -1.14;
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 512;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, 256, 512);
    context.fillStyle = '#394144';
    context.textAlign = 'center';
    context.font = '500 57px monospace';
    context.fillText('A3', 128, 174);
    context.fillRect(28, 196, 200, 2);
    context.font = '16px monospace';
    context.fillText('TEST VEHICLE', 128, 229);
    context.font = '12px monospace';
    context.fillText('PROPULSION SYSTEMS', 128, 255);
    context.fillText('EXPERIMENTAL', 128, 278);
    context.font = '11px monospace';
    context.fillText('LIFT / SERVICE POINT', 128, 407);
    context.fillRect(126, 425, 4, 34);
    context.beginPath();
    context.moveTo(128, 420); context.lineTo(118, 434); context.lineTo(138, 434);
    context.closePath(); context.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const labelMaterial = material(new THREE.MeshStandardMaterial({map: texture, transparent: true, metalness: .05, roughness: .75, depthWrite: false}));
    for (const angle of [0, Math.PI]) {
      const label = add(geometry(new THREE.CylinderGeometry(.1508, .1508, .53, 32, 1, true, angle - .65, 1.3)), labelMaterial);
      label.rotation.x = Math.PI / 2;
      label.position.z = -.03;
    }
    engine.position.z = -1.38;
    group.add(engine);
    const bellProfile = [new THREE.Vector2(.035, 0), new THREE.Vector2(.037, -.025), new THREE.Vector2(.043, -.055), new THREE.Vector2(.06, -.09), new THREE.Vector2(.093, -.12)];
    const bell = add(geometry(new THREE.LatheGeometry(bellProfile, 48)), heatMetal, engine);
    bell.rotation.x = Math.PI / 2;
    bell.position.z = -.2;
    cylinder(.031, .031, .045, dark, .005, engine);
    cylinder(.041, .041, .065, machined, -.055, engine, 24);
    cylinder(.055, .055, .008, dark, -.091, engine, 32);
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      strut([x * .049, y * .049, -.09], [x * .038, y * .038, -.2], .003, dark, engine);
    }
  }

  const plume = new THREE.Group();
  plume.position.z = mono ? -.04 : -.32;
  engine.add(plume);
  const flameMaterials = [];
  for (const [r, h, color, opacity] of [[.09, .82, 0xff6b20, .28], [.058, .59, 0xffcb64, .55], [.031, .37, 0xe1f5ff, .85]]) {
    const mat = material(new THREE.MeshBasicMaterial({color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide}));
    mat.color.multiplyScalar(3);
    flameMaterials.push(mat);
    const flame = add(geometry(new THREE.ConeGeometry(r, h, 32, 1, true)), mat, plume);
    flame.rotation.x = -Math.PI / 2;
    flame.position.z = -h / 2;
    flame.castShadow = false; flame.receiveShadow = false;
  }
  // Monocopter lift is aerodynamic: never draw a rocket exhaust under its rotor.
  plume.visible = false;
  let disposed = false;
  const thrustAxis = new THREE.Vector3();
  const bodyAxis = new THREE.Vector3(0, 0, 1);
  return {
    group,
    update(state) {
      const vehicle = state.vehicle;
      const footWidth = vehicle.footWidth;
      const footDepth = vehicle.footDepth;
      const reach = Math.max(.01, footWidth * Math.SQRT2);
      for (let i = 0; i < legAssemblies.length; i++) {
        legAssemblies[i].scale.set(reach, reach, Math.max(.01, footDepth));
      }
      engine.position.z = vehicle.lever;
      thrustAxis.set(Math.tan(state.gimbal[0]), Math.tan(state.gimbal[1]), 1).normalize();
      engine.quaternion.setFromUnitVectors(bodyAxis, thrustAxis);
      const throttle = Math.max(0, Math.min(1, state.thrust / vehicle.maxThrust));
      plume.visible = !mono && state.thrust > 0;
      if (plume.visible) {
        const flicker = 1 + .065 * Math.sin(state.t * 91) + .035 * Math.sin(state.t * 147);
        plume.scale.set(.6 + .4 * throttle, .6 + .4 * throttle, (.15 + .85 * throttle) * flicker);
        flameMaterials[0].opacity = .18 + .14 * throttle;
        flameMaterials[1].opacity = .35 + .25 * throttle;
        flameMaterials[2].opacity = .65 + .25 * throttle;
      }
      if (rotor) rotor.rotation.z = state.t * (24 + throttle * 185);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      group.clear();
    }
  };
}
