import * as THREE from './vendor/three.module.js';

// Vehicle-local coordinates are metres, with the thrust axis along +Z.
export function createVehicle(kind) {
  const group = new THREE.Group();
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const geometry = value => { geometries.add(value); return value; };
  const material = value => { materials.add(value); return value; };
  const metal = material(new THREE.MeshStandardMaterial({color: 0xc5ccd0, metalness: .82, roughness: .32}));
  const dark = material(new THREE.MeshStandardMaterial({color: 0x242b30, metalness: .75, roughness: .4}));
  const orange = material(new THREE.MeshStandardMaterial({color: 0xe56e24, metalness: .28, roughness: .43}));
  const rubber = material(new THREE.MeshStandardMaterial({color: 0x14191c, roughness: .9}));
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
    strut([.18, 0, -.30], [1, 0, -1], .021, metal, leg);
    strut([.16, 0, -.73], [1, 0, -1], .012, dark, leg);
    const foot = add(geometry(new THREE.BoxGeometry(.25, .18, .045)), rubber, leg);
    foot.position.set(1, 0, -.9775);
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
    cylinder(.145, .13, .16, dark, -1.42);
    for (const z of [-1.28, -.78, .28, .63, .83, 1.075]) ring(.1505, .003, z);
    const rivetGeometry = geometry(new THREE.SphereGeometry(.0045, 6, 4));
    const rivets = new THREE.InstancedMesh(rivetGeometry, dark, 96);
    const transform = new THREE.Object3D();
    let index = 0;
    for (const z of [-1.28, -.78, .28, 1.075]) {
      for (let i = 0; i < 24; i++) {
        const angle = i * Math.PI / 12;
        transform.position.set(.151 * Math.cos(angle), .151 * Math.sin(angle), z);
        transform.updateMatrix();
        rivets.setMatrixAt(index++, transform.matrix);
      }
    }
    rivets.castShadow = true; rivets.receiveShadow = true;
    group.add(rivets);
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 512;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, 256, 512);
    context.fillStyle = '#17232b';
    context.textAlign = 'center';
    context.font = 'bold 150px sans-serif';
    context.fillText('A3', 128, 285);
    context.font = '22px sans-serif';
    context.fillText('FLIGHT SYSTEMS', 128, 333);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture);
    const labelMaterial = material(new THREE.MeshStandardMaterial({map: texture, transparent: true, roughness: .5, depthWrite: false, side: THREE.DoubleSide}));
    for (const angle of [0, Math.PI]) {
      const label = add(geometry(new THREE.CylinderGeometry(.1515, .1515, .53, 24, 1, true, angle - .65, 1.3)), labelMaterial);
      label.rotation.x = Math.PI / 2;
      label.position.z = -.03;
    }
    engine.position.z = -1.38;
    group.add(engine);
    const bellProfile = [new THREE.Vector2(.035, 0), new THREE.Vector2(.037, -.025), new THREE.Vector2(.043, -.055), new THREE.Vector2(.06, -.09), new THREE.Vector2(.093, -.12)];
    const bell = add(geometry(new THREE.LatheGeometry(bellProfile, 48)), material(new THREE.MeshStandardMaterial({color: 0x515660, metalness: .88, roughness: .32, side: THREE.DoubleSide})), engine);
    bell.rotation.x = Math.PI / 2;
    bell.position.z = -.2;
    cylinder(.031, .031, .045, dark, .005, engine);
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
