import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const { clamp, lerp, smoothstep } = THREE.MathUtils;

function weatherColor(x, y, z, seed, soot = 0) {
  const mottling = Math.sin(x * 13.2 + y * 4.8 + seed) * Math.cos(z * 9.1 - y * 8.5);
  const runs = Math.sin(Math.atan2(z, x) * 29 + seed) * .045;
  const value = .90 + .096 * mottling + runs - soot * .42;
  return [value, value * (1.013 - soot * .081), value * (1.022 - soot * .13)];
}

function weatheredProfile(profile, { seed = 0, facets = 0, flutes = 0, soot = 0, segments = 64 } = {}) {
  const geometry = new THREE.LatheGeometry(profile.map(point => new THREE.Vector2(...point)), segments);
  const positions = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const color = [];
  const start = profile[0][1], span = profile.at(-1)[1] - start;
  const circumference = TAU * Math.max(...profile.map(point => point[0]));
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const angle = Math.atan2(x, z);
    const facetSize = facets ? TAU / facets : TAU;
    const faceAngle = THREE.MathUtils.euclideanModulo(angle + facetSize * .5, facetSize) - facetSize * .5;
    const facetScale = facets ? Math.cos(facetSize * .5) / Math.cos(faceAngle) : 1;
    const t = clamp((y - start) / Math.max(span, .01), 0, 1);
    const lip = smoothstep(t, .015, .08) * (1 - smoothstep(t, .92, .985));
    const groove = flutes ? Math.pow((1 + Math.cos(angle * flutes)) * .5, 1.9) * lip * .047 : 0;
    const wear = .011 * Math.sin(angle * 11 + y * 12 + seed) * Math.cos(angle * 7 - y * 9);
    const chip = .035 * smoothstep(.48, .93, Math.sin(angle * 9 + seed) * Math.cos(y * 27 - seed));
    const radiusScale = facetScale * (1 + wear - chip - groove);
    positions.setXYZ(i, x * radiusScale, y, z * radiusScale);
    uv.setXY(i, uv.getX(i) * circumference / 1.45, y / 1.45);
    color.push(...weatherColor(x, y, z, seed, soot * (.53 + .47 * t)));
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function course(base, top, lower, height, options) {
  const bevel = Math.min(height * .21, base * .067);
  return weatheredProfile([
    [0, lower], [base - bevel, lower], [base, lower + bevel],
    [lerp(base, top, .36), lower + height * .36],
    [lerp(base, top, .68), lower + height * .68],
    [top, lower + height - bevel], [top - bevel, lower + height], [0, lower + height],
  ], options);
}

function mergePieces(group, material, pieces, name) {
  const mesh = new THREE.Mesh(mergeGeometries(pieces), material);
  mesh.name = name;
  mesh.receiveShadow = true;
  group.add(mesh);
  for (const piece of pieces) piece.dispose();
  return mesh;
}

export function towerStonework(group, materials, seed) {
  const { dressed, seams, metal } = materials;
  const profile = [[0,0],[2.28,0],[2.40,.10],[2.38,.21],[2.24,.30],[2.22,.49],[2.07,.58],
    [2.02,.69],[1.90,1.16],[1.95,1.27],[1.89,1.39],[1.75,1.49],[0,1.49]];
  const parts = [weatheredProfile(profile, { facets: 8, seed })];
  const joints = [];
  const heights = [1.16, 1.02, 1.23, .96, 1.15];
  let y = 1.48;
  for (const [index, height] of heights.entries()) {
    const base = lerp(1.61, 1.32, (y - 1.48) / 5.58);
    const top = lerp(1.61, 1.32, (y + height - 1.48) / 5.58);
    parts.push(course(base, top, y, height - .028, { flutes: 12, segments: 84, seed: seed + index * 1.53 }));
    joints.push(course(top * .945, top * .945, y + height - .029, .031, { seed, segments: 36 }));
    y += height;
  }
  parts.push(weatheredProfile([[0,6.96],[1.31,6.96],[1.39,7.03],[1.48,7.16],[1.52,7.32],
    [1.73,7.53],[1.88,7.60],[1.92,7.72],[1.86,7.96],[1.72,8.10],[0,8.10]],
    { facets: 8, soot: .74, seed: seed + 3 }));
  parts.push(course(1.44, 1.51, 8.09, .13, { facets: 8, soot: .91, seed: seed - 2 }));
  mergePieces(group, dressed, parts, 'chamfered-pylon-stone');
  mergePieces(group, seams, joints, 'recessed-pylon-mortar');

  // Clamps bridge two drum joints and sit partly in the stone.
  const straps = [];
  for (const y0 of [2.60, 5.81]) {
    const radius = lerp(1.61, 1.32, (y0 - 1.48) / 5.58);
    for (let index = 0; index < 4; index++) {
      const az = index * Math.PI / 2 + Math.PI / 4;
      const strap = new THREE.BoxGeometry(.105, .30, .070).translate(0, y0, radius);
      strap.rotateY(az);
      straps.push(strap);
    }
  }
  mergePieces(group, metal, straps, 'pylon-repair-clamps');
}

function fracturedMesh(radiusLower, radiusUpper, height, { seed, limits, brokenBoth }) {
  const radialSegments = 44, levels = 7;
  const rings = [];
  const positions = [], uv = [], colors = [], indices = [];
  const vertex = (x, y, z, u, v, shade = 1) => {
    const index = positions.length / 3;
    positions.push(x,y,z);
    uv.push(u,v);
    const tone = weatherColor(x,y,z,seed);
    colors.push(...tone.map(value => value * shade));
    return index;
  };
  function breakHeight(a, sign) {
    const strata = Math.sin(a * 2 + seed * sign) * .51 + Math.cos(a * 5 - seed) * .29
      + Math.sin(a * 11 + seed * 2 * sign) * .17 + Math.cos(a * 19) * .07;
    return strata * Math.min(.19, radiusLower * .29);
  }

  for (let level = 0; level <= levels; level++) {
    const t = level / levels;
    const ring = [];
    for (let index = 0; index <= radialSegments; index++) {
      const a = (index % radialSegments) / radialSegments * TAU;
      const wear = .023 * Math.sin(a * 13 + seed) * Math.cos(t * 7 + seed)
        + .017 * Math.sin(a * 21 - t * 5);
      const flute = Math.pow((1 + Math.cos(a * 10 + seed)) * .5, 2) * .055;
      const radius = Math.min(limits, lerp(radiusLower, radiusUpper, t) * (1 + wear - flute));
      const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      const upper = breakHeight(a, 1) * Math.pow(t, 6);
      const lower = brokenBoth ? breakHeight(a, -1) * Math.pow(1 - t, 6) : 0;
      const y = t * height + upper + lower;
      ring.push([x,y,z]);
      vertex(x,y,z,index / radialSegments * TAU * radiusLower / 1.42, y / 1.42);
      if (level === 0 || index === radialSegments) continue;
      const a0 = (level - 1) * (radialSegments + 1) + index, b = level * (radialSegments + 1) + index;
      indices.push(a0, b, a0 + 1, a0 + 1, b, b + 1);
    }
    rings.push(ring);
  }
  const surfaceCount = indices.length;
  function cap(ring, sign) {
    const y0 = sign > 0 ? height : 0;
    const center = vertex(0, y0 + (brokenBoth || sign > 0 ? sign * .057 : 0), 0, .5, .5, .88);
    const bands = [];
    for (const amount of [.33, .65, 1]) {
      const row = [];
      for (let index = 0; index <= radialSegments; index++) {
        const [x,y,z] = ring[index];
        const perturbation = Math.sin(index % radialSegments * 5.71 + seed + amount);
        const capY = amount === 1 || (sign < 0 && !brokenBoth) ? y
          : lerp(y0, y, amount) + perturbation * .052;
        row.push(vertex(x * amount, capY, z * amount, .5 + x*.8*amount, .5 + z*.8*amount, .85 + .14 * perturbation));
      }
      bands.push(row);
    }
    for (let j = 0; j < radialSegments; j++) {
      indices.push(...(sign > 0 ? [center,bands[0][j+1],bands[0][j]] : [center,bands[0][j],bands[0][j+1]]));
      for (let i=1; i<bands.length; i++) {
        const inner=bands[i-1], outer=bands[i];
        const a=inner[j], b=inner[j+1], c=outer[j], d=outer[j+1];
        indices.push(...(sign > 0 ? [a,b,d,a,d,c] : [a,d,b,a,c,d]));
      }
    }
  }
  cap(rings.at(-1), 1);
  cap(rings[0], -1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.addGroup(0, surfaceCount, 0);
  geometry.addGroup(surfaceCount, indices.length - surfaceCount, 1);
  geometry.computeVertexNormals();
  return geometry;
}

export function ruinedColumns(root, standing, fallen, materials, deckHeight) {
  const { dressed, fracture } = materials;
  standing.forEach((p, index) => {
    const group = new THREE.Group();
    group.name = 'standing-column-ruin';
    group.position.set(p.x, deckHeight(p.x, p.z), p.z);
    group.rotation.y = index * 1.47 + .21;
    const options = { facets: 8, seed: index * 1.67 };
    const base = [
      course(p.r * 1.32, p.r * 1.29, 0, .14, options),
      course(p.r * 1.235, p.r * 1.105, .125, .13, options),
      course(p.r * 1.11, p.r * 1.04, .247, .095, { seed: index, segments: 48 }),
    ];
    mergePieces(group, dressed, base, 'worn-plinth');
    const geometry = fracturedMesh(p.r * 1.04, p.r * .93, p.h, { seed: index * 2.43 + .72, limits: p.r * 1.07, brokenBoth: false });
    const shaft = new THREE.Mesh(geometry, [dressed, fracture]);
    shaft.name = 'exposed-stone-break';
    shaft.receiveShadow = true;
    shaft.position.y = .33;
    group.add(shaft);
    root.add(group);
  });
  fallen.forEach((f, index) => {
    const group = new THREE.Group();
    group.name = 'fallen-column-ruin';
    group.position.set(f.x, deckHeight(f.x, f.z), f.z);
    group.rotation.y = f.yaw;
    const length = f.len + .24;
    const geo = fracturedMesh(.548, .50, length, { seed: index * 3.07 + 1.51, limits: .56, brokenBoth: true });
    geo.translate(0, -length / 2, 0);
    geo.rotateZ(-Math.PI / 2);
    geo.computeBoundingBox();
    const shaft = new THREE.Mesh(geo, [dressed, fracture]);
    shaft.position.y = -geo.boundingBox.min.y - .007;
    shaft.receiveShadow = true;
    group.add(shaft);
    root.add(group);
  });
}

export function wallCrownColumns(root, radius, y, gap, materials) {
  const group = new THREE.Group();
  group.name = 'wall-crown-stone-columns';
  const foundations = [], bodies = [], caps = [];
  for (let index = 0; index < 64; index++) {
    const az = index / 64 * TAU;
    if (Math.abs(THREE.MathUtils.euclideanModulo(az - Math.PI * .5, TAU) - Math.PI) < gap * .5 + .063) continue;
    if (index % 13 === 4) continue;
    const height = [1.56, 2.03, 1.77, 2.12, 1.64, 1.89, 1.38, 1.98][index % 8];
    const opts = { seed: index * .81, facets: 8, segments: 32 };
    const x = Math.cos(az) * radius, z = Math.sin(az) * radius;
    const seat = course(1.21, 1.07, 0, .24, opts);
    const lower = course(1.01, .91, .228, .41, opts);
    const shorter = index % 9 === 3 || index % 17 === 11;
    const shaftTop = shorter ? height - .27 : height;
    const shaft = course(.91, .81, .626, shaftTop - .61, { ...opts, flutes: 8, segments: 40 });
    const parts = [[foundations, seat], [bodies, lower], [bodies, shaft]];
    if (shorter) {
      const broken = fracturedMesh(.80, .73, .21, { seed: index, limits: .87, brokenBoth: false });
      const top = new THREE.Mesh(broken, [materials.dressed, materials.fracture]);
      top.position.set(x, y + shaftTop - .021, z);
      group.add(top);
    } else {
      parts.push([caps, weatheredProfile([[0,height-.02],[.79,height-.02],[.89,height+.065],[1.01,height+.141],
        [1.11,height+.20],[1.13,height+.30],[1.05,height+.377],[0,height+.377]], opts)]);
    }
    for (const [target, geometry] of parts) {
      geometry.rotateY(index * .19);
      geometry.translate(x,y,z);
      target.push(geometry);
    }
  }
  mergePieces(group, materials.dressed, bodies, 'wall-pier-masonry');
  mergePieces(group, materials.dressed, foundations, 'wall-pier-plinths');
  mergePieces(group, materials.dressed, caps, 'wall-pier-coping');
  root.add(group);
}

function curvedCourse(radius, y, width, height, start, angle, seed) {
  const inside = radius - width * .5, outside = radius + width * .5;
  const bevel = Math.min(height * .19, width * .16);
  const shape = [[inside+bevel,y],[outside-bevel,y],[outside,y+bevel],[outside,y+height-bevel],
    [outside-bevel,y+height],[inside+bevel,y+height],[inside,y+height-bevel],[inside,y+bevel],[inside+bevel,y]];
  const segments = 11;
  const geometry = new THREE.LatheGeometry(shape.map(point => new THREE.Vector2(...point)), segments, start, angle);
  const indices = Array.from(geometry.index.array);
  const last = segments * shape.length;
  for (let i = 1; i < shape.length - 2; i++) indices.push(0, i, i+1, last, last+i+1, last+i);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const colors = [];
  const shade = .91 + .059 * Math.sin(seed * 7.4);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) colors.push(shade, shade * .98, shade);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  return geometry;
}

export function arenaRailings(root, radius, materials) {
  const group = new THREE.Group();
  group.name = 'dressed-stone-balustrade';
  const upper = [], lower = [], posts = [];
  const gap = THREE.MathUtils.degToRad(6.5);
  const pillarSpacing = (Math.PI / 2 - 2 * gap) / 7;
  const profile = [[0,.18],[.216,.18],[.224,.24],[.185,.30],[.134,.37],[.119,.46],
    [.142,.58],[.186,.71],[.181,.81],[.149,.91],[.121,1.04],
    [.132,1.17],[.162,1.24],[.185,1.28],[0,1.28]];
  const spindle = new THREE.InstancedMesh(weatheredProfile(profile,{segments:22,seed:3}), materials.dressed, 4 * 7 * 4);
  spindle.receiveShadow = true;
  let instanceId = 0;
  const matrix = new THREE.Matrix4();
  const lamps = [];
  for (let quarter = 0; quarter < 4; quarter++) {
    const start = quarter * Math.PI / 2 + gap;
    for (let bay = 0; bay < 7; bay++) {
      const a = start + bay * pillarSpacing;
      for (let member = 1; member <= 4; member++) {
        const angle = a + pillarSpacing * member / 5;
        matrix.makeRotationY(angle);
        matrix.setPosition(Math.sin(angle)*radius,0,Math.cos(angle)*radius);
        spindle.setMatrixAt(instanceId++, matrix);
      }
      for (let block = 0; block < 2; block++) {
        const offset = a + block * pillarSpacing * .5 + .0011;
        const arc = pillarSpacing * .5 - .0022;
        upper.push(curvedCourse(radius,1.25,.49,.233,offset,arc,bay + block * 2));
        lower.push(curvedCourse(radius,.16,.53,.185,offset,arc,quarter + block));
        lower.push(curvedCourse(radius+.72,.14,.40,.46,offset,arc,quarter+bay));
        lower.push(curvedCourse(radius+.73,.61,.41,.48,offset,arc,quarter + bay * 3));
        upper.push(curvedCourse(radius+.72,1.075,.56,.164,offset,arc,quarter+bay));
      }
    }
    for (let index = 0; index <= 7; index++) {
      const angle = start + index * pillarSpacing;
      const x = Math.sin(angle) * radius, z = Math.cos(angle) * radius;
      const options = { facets: 4, seed: quarter + index * 1.19, segments: 32 };
      const pillar = [
        course(.48,.41,.163,.195,options),
        course(.355,.318,.35,1.20,options),
        course(.437,.47,1.536,.105,options),
        course(.466,.385,1.634,.123,options),
      ];
      for (const geometry of pillar) {
        geometry.rotateY(angle + Math.PI / 4);
        geometry.translate(x,0,z);
        posts.push(geometry);
      }
      if (index === 0 || index === 7) lamps.push({ x, z, angle });
    }
  }
  group.add(spindle);
  mergePieces(group, materials.dressed, upper, 'jointed-stone-handrails');
  mergePieces(group, materials.seams, lower, 'footing-and-parapet-stonework');
  mergePieces(group, materials.dressed, posts, 'capped-railing-piers');
  root.add(group);
  return lamps;
}
