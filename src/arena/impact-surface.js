import * as THREE from 'three';

export const rimScale = angle => 1 + .086 * Math.sin(5 * angle + .4)
  + .051 * Math.sin(9 * angle - 1.1) + .035 * Math.sin(17 * angle);

export function createImpactSurface(stone) {
  const footprint = { value: new THREE.Vector3() };
  const rock = stone.clone();
  rock.vertexColors = true;
  const basin = rock.clone();
  const heat = { value: 0 };
  basin.onBeforeCompile = shader => {
    shader.uniforms.crackHeat = heat;
    shader.vertexShader = 'varying vec2 basinPoint;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>', '#include <begin_vertex>\n basinPoint = position.xz;'
    );
    shader.fragmentShader = 'varying vec2 basinPoint;\n uniform float crackHeat;\n' + shader.fragmentShader.replace(
      '#include <color_fragment>', `
        #include <color_fragment>
        float r = length(basinPoint);
        float a = atan(basinPoint.y, basinPoint.x);
        float line = a * 6.0 + 0.36 * sin(a * 5.0 + r * 8.0) + 0.28 * sin(r * 24.0 + a * 2.0);
        float split = abs(sin(line));
        float branch = abs(sin(line + smoothstep(.35, 1.02, r) * .95));
        float width = 0.11 - r * .037;
        float jagged = .023 * sin(r * 91.0 + a * 33.0);
        float crack = 1.0 - smoothstep(width * .35, width, split + jagged);
        crack = max(crack, (1.0 - smoothstep(.018, .052, branch)) * smoothstep(.42,.65,r) * .77);
        crack *= smoothstep(.06,.23,r) * (1.0-smoothstep(.91,1.05,r));
        diffuseColor.rgb *= mix(1.0, 0.15, crack);
      `
    ).replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(.53,.041,.008) * crack * crackHeat * smoothstep(.18,.56,r);
      `);
  };

  return {
    rock, basin, heat,
    set(center, radius) { footprint.value.set(center.x, center.z, radius); },
    clip(material) {
      material.onBeforeCompile = shader => {
        shader.uniforms.impactFootprint = footprint;
        shader.vertexShader = 'varying vec2 impactFloorXZ;\n' + shader.vertexShader.replace(
          '#include <project_vertex>', '#include <project_vertex>\n impactFloorXZ = (modelMatrix * vec4(transformed,1.0)).xz;'
        );
        shader.fragmentShader = 'uniform vec3 impactFootprint;\n varying vec2 impactFloorXZ;\n' + shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>', `
            #include <clipping_planes_fragment>
            if (impactFootprint.z > 0.0) {
              vec2 impactP = impactFloorXZ - impactFootprint.xy;
              float a = atan(impactP.y, impactP.x);
              float limit = 1.0 + .086*sin(5.0*a+.4) + .051*sin(9.0*a-1.1) + .035*sin(17.0*a);
              if (dot(impactP,impactP) < pow(impactFootprint.z * limit, 2.0)) discard;
            }
          `
        );
      };
    },
  };
}

export function buildBasinGeometry() {
  const position = [], colors = [], uv = [], indices = [];
  const sectors = 84;
  const layers = [[0, -.011, .52], [.20, -.021, .51], [.41, -.065, .46], [.62, -.19, .43],
    [.78, -.156, .54], [.89, -.085, .69], [.97, .045, .83], [1.025, .033, .78], [1.065, -.048, .57]];
  for (const [r, height, light] of layers) {
    for (let j = 0; j <= sectors; j++) {
      const angle = j / sectors * Math.PI * 2;
      const rr = Math.max(.0001, r) * rimScale(angle);
      const x = Math.cos(angle) * rr, z = Math.sin(angle) * rr;
      const texture = Math.sin(37 * angle + r * 31) * Math.cos(21 * angle - r * 9);
      const wear = Math.min(1, r * 2) * texture;
      const y = height + .043 * wear * (r > 1.03 ? .05 : 1);
      const tint = light + .10 * wear;
      position.push(x, y, z);
      colors.push(tint, tint * .94, tint * .91);
      uv.push(x * .7, z * .7);
    }
  }
  for (let k = 0; k < layers.length - 1; k++) {
    for (let j = 0; j < sectors; j++) {
      const i = k * (sectors + 1) + j, next = i + sectors + 1;
      indices.push(i, i + 1, next, i + 1, next + 1, next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
