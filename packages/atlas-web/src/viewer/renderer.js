/** The renderer. (docs/viewer-shell.md) */

import { FOV_Y, UP, eyeOf } from './camera.js';
import { lookAt, multiply, perspective } from './vec.js';

const SOLID_VERTEX = `#version 300 es
in vec3 position;
in vec3 normal;
uniform mat4 viewProjection;
out vec3 vNormal;
out vec3 vPosition;
void main() {
  vNormal = normal;
  vPosition = position;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;

/** Solid region colour mode: one flat colour per region, shaded only enough to read as a solid. (docs/viewer-shell.md) */
const SOLID_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vPosition;
uniform vec3 colour;
uniform float alpha;
uniform vec3 eye;
uniform float hatch;
uniform vec3 hatchColour;
out vec4 fragColour;
void main() {
  vec3 n = normalize(vNormal);
  vec3 toEye = normalize(eye - vPosition);
  // Flip the normal toward the viewer so back faces of an open shell still
  // shade, rather than going black when a layer above them is hidden.
  if (dot(n, toEye) < 0.0) n = -n;
  float key = max(dot(n, normalize(vec3(0.35, -0.8, 0.5))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.5, 0.4, 0.2))), 0.0);
  float light = 0.42 + 0.44 * key + 0.18 * fill;
  // Diagonal screen-space stripes in a second colour, one period every hatch pixels.
  // Zero turns them off; the overlap of two compared papers is the one user.
  vec3 c = hatch > 0.0 && mod(gl_FragCoord.x + gl_FragCoord.y, hatch) < hatch * 0.5 ? hatchColour : colour;
  fragColour = vec4(c * light, alpha);
}`;

const LINE_VERTEX = `#version 300 es
in vec3 position;
uniform mat4 viewProjection;
void main() {
  gl_Position = viewProjection * vec4(position, 1.0);
}`;

const LINE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 colour;
uniform float alpha;
out vec4 fragColour;
void main() { fragColour = vec4(colour, alpha); }`;

/** The solid region palette. (docs/viewer-shell.md) */
export const REGION_COLOURS = Object.freeze({
  cervical: [0.44, 0.60, 0.80],
  thoracic: [0.36, 0.69, 0.66],
  lumbar: [0.52, 0.65, 0.42],
  sacral: [0.62, 0.56, 0.74],
  other: [0.58, 0.58, 0.62],
  spine: [0.85, 0.87, 0.92],
  left: [0.44, 0.60, 0.80],
  right: [0.40, 0.72, 0.70],
});

/** Anatomy, by layer id (viewer/state.js) and, for the cortex lobes, by label. (docs/viewer-shell.md) */
export const ANATOMY_COLOURS = Object.freeze({
  cortex: [0.82, 0.74, 0.70], deep_grey: [0.56, 0.62, 0.84], diencephalon: [0.60, 0.76, 0.62],
  brainstem: [0.78, 0.70, 0.56], cerebellum: [0.70, 0.62, 0.80], white_matter: [0.90, 0.90, 0.86],
  tracts: [0.62, 0.80, 0.86], ventricles: [0.42, 0.66, 0.90], arteries: [0.82, 0.36, 0.36],
  veins_sinuses: [0.40, 0.46, 0.80], cranial_nerves: [0.94, 0.86, 0.48], meninges_dura: [0.66, 0.66, 0.62],
  'Frontal lobe': [0.80, 0.72, 0.62], 'Parietal lobe': [0.70, 0.76, 0.66], 'Temporal lobe': [0.66, 0.72, 0.82],
  'Occipital lobe': [0.80, 0.68, 0.78], Insula: [0.88, 0.80, 0.56], 'Limbic lobe': [0.62, 0.80, 0.78],
  skin: [0.86, 0.73, 0.64], muscle: [0.74, 0.40, 0.38], skeleton: [0.90, 0.88, 0.80],
  cardiovascular: [0.80, 0.30, 0.32], nervous: [0.94, 0.86, 0.48], respiratory: [0.62, 0.76, 0.86],
  alimentary: [0.80, 0.62, 0.46], urinary: [0.86, 0.76, 0.42], genital: [0.80, 0.56, 0.70],
  endocrine: [0.60, 0.80, 0.56], other: [0.62, 0.62, 0.66], chosen: [0.30, 0.95, 0.84],
  // A selected paper's structures (DOG-132): solid where a link is exact, striped where every link is approximate.
  paper: [0.98, 0.42, 0.16], paperStripe: [0.24, 0.12, 0.08],
});

export const CELL_COLOUR = [0.98, 0.62, 0.21];
export const CELL_EDGE_COLOUR = [1.0, 0.84, 0.42];
/** Per-highlight-group colours, for research findings. */
export const GROUP_COLOURS = [
  [0.94, 0.46, 0.38], [0.46, 0.64, 0.94], [0.96, 0.76, 0.32],
  [0.58, 0.82, 0.50], [0.80, 0.54, 0.88],
];
/** One colour per paper when two are compared; their overlap is hatched in both (docs/viewer-shell.md). */
export const PAPER_COLOURS = [[0.28, 0.52, 1.0], [0.93, 0.30, 0.72]];

function compile(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertexSource],
    [gl.FRAGMENT_SHADER, fragmentSource],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/** Create a renderer on a canvas. (docs/viewer-shell.md) */
export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    alpha: false,
    // The honesty argument applies to depth too: without this, a cell drawn
    // inside the body z-fights with the shell and flickers in and out.
    depth: true,
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser');

  const solid = compile(gl, SOLID_VERTEX, SOLID_FRAGMENT);
  const line = compile(gl, LINE_VERTEX, LINE_FRAGMENT);

  const loc = {
    solid: {
      position: gl.getAttribLocation(solid, 'position'),
      normal: gl.getAttribLocation(solid, 'normal'),
      viewProjection: gl.getUniformLocation(solid, 'viewProjection'),
      colour: gl.getUniformLocation(solid, 'colour'),
      alpha: gl.getUniformLocation(solid, 'alpha'),
      eye: gl.getUniformLocation(solid, 'eye'),
      hatch: gl.getUniformLocation(solid, 'hatch'),
      hatchColour: gl.getUniformLocation(solid, 'hatchColour'),
    },
    line: {
      position: gl.getAttribLocation(line, 'position'),
      viewProjection: gl.getUniformLocation(line, 'viewProjection'),
      colour: gl.getUniformLocation(line, 'colour'),
      alpha: gl.getUniformLocation(line, 'alpha'),
    },
  };

  const buffers = new Set();
  const makeBuffer = (data, target = gl.ARRAY_BUFFER) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    buffers.add(buffer);
    return buffer;
  };

  /**
   * Upload a surface mesh once, keeping its per-level triangle ranges so a
   * layer can be drawn, hidden or faded without re-uploading anything.
   */
  function uploadSurface(mesh) {
    return {
      kind: 'surface',
      position: makeBuffer(mesh.positions),
      normal: makeBuffer(mesh.normals),
      index: makeBuffer(mesh.triangles, gl.ELEMENT_ARRAY_BUFFER),
      levels: mesh.levels,
      count: mesh.triangles.length,
    };
  }

  function uploadCell(cell) {
    const edges = cell.edges.map((polyline) => {
      const flat = new Float32Array(polyline.length * 3);
      polyline.forEach((p, i) => flat.set(p, i * 3));
      return { buffer: makeBuffer(flat), count: polyline.length };
    });
    return {
      kind: 'cell',
      position: makeBuffer(cell.positions),
      // The cell is drawn unlit from both sides, so a flat normal is enough;
      // its shape is communicated by the outline, not by shading.
      normal: makeBuffer(new Float32Array(cell.positions.length)),
      index: makeBuffer(cell.triangles, gl.ELEMENT_ARRAY_BUFFER),
      count: cell.triangles.length,
      edges,
    };
  }

  function release(uploaded) {
    if (!uploaded) return;
    for (const key of ['position', 'normal', 'index']) {
      if (uploaded[key]) {
        gl.deleteBuffer(uploaded[key]);
        buffers.delete(uploaded[key]);
      }
    }
    for (const edge of uploaded.edges ?? []) {
      gl.deleteBuffer(edge.buffer);
      buffers.delete(edge.buffer);
    }
  }

  function bindSolid(uploaded) {
    gl.bindBuffer(gl.ARRAY_BUFFER, uploaded.position);
    gl.enableVertexAttribArray(loc.solid.position);
    gl.vertexAttribPointer(loc.solid.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uploaded.normal);
    gl.enableVertexAttribArray(loc.solid.normal);
    gl.vertexAttribPointer(loc.solid.normal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, uploaded.index);
  }

  /** Draw a frame. (docs/viewer-shell.md) */
  function render(scene) {
    const { camera, width, height } = scene;
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    gl.viewport(0, 0, pixelWidth, pixelHeight);
    gl.clearColor(0.071, 0.082, 0.102, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    // No culling: the anatomy includes open sheets (dura, skin, the cortex's
    // cut faces) and is not wound consistently across sources, and the shader
    // already lights whichever face is toward the eye.
    gl.disable(gl.CULL_FACE);

    const eye = eyeOf(camera);
    // `far` is derived from the camera distance rather than fixed, because the
    // body template is ~770 mm tall and the brain ~180 mm, and a fixed far
    // plane clips one or wastes all its depth precision on the other.
    const far = camera.distance * 4 + 2000;
    const viewProjection = multiply(
      perspective(FOV_Y, pixelWidth / pixelHeight, Math.max(1, camera.distance * 0.01), far),
      lookAt(eye, camera.target, UP),
    );

    // --- opaque solids ----------------------------------------------------
    gl.useProgram(solid);
    gl.uniformMatrix4fv(loc.solid.viewProjection, false, viewProjection);
    gl.uniform3fv(loc.solid.eye, new Float32Array(eye));
    gl.uniform1f(loc.solid.hatch, 0);

    const translucent = [];
    for (const item of scene.solids) {
      if (!item.visible) continue;
      if (item.opacity < 1) {
        translucent.push(item);
        continue;
      }
      drawSolidRanges(item);
    }

    // --- translucent solids, back to front -------------------------------
    // Sorted by distance from the eye so a faded skin layer composites over
    // the organs behind it rather than under them.
    if (translucent.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const item of translucent) drawSolidRanges(item);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    // --- the selected structure and a paper's, through whatever is in front --
    for (const xray of [].concat(scene.xray ?? [])) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      drawSolidRanges({ ...xray, opacity: 0.3 });
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
    }

    function drawSolidRanges(item) {
      bindSolid(item.mesh);
      gl.uniform1f(loc.solid.alpha, item.opacity);
      for (const range of item.ranges) {
        gl.uniform3fv(loc.solid.colour, new Float32Array(range.colour));
        gl.uniform1f(loc.solid.hatch, range.hatch ? 8 * dpr : 0);
        if (range.hatch) gl.uniform3fv(loc.solid.hatchColour, new Float32Array(range.hatch));
        gl.drawElements(
          gl.TRIANGLES,
          range.triangleCount * 3,
          gl.UNSIGNED_INT,
          range.firstTriangle * 3 * 4,
        );
      }
    }

    // --- research highlights, then the selected cell (docs/viewer-shell.md) ---
    const volumes = [
      ...(scene.highlights ?? []).map((h) => ({
        cell: h.cell,
        fill: h.colour ?? CELL_COLOUR,
        edge: h.colour ?? CELL_EDGE_COLOUR,
        alpha: h.alpha ?? 0.22,
        hatch: h.hatch ?? null,
      })),
      ...(scene.cell
        ? [{ cell: scene.cell, fill: CELL_COLOUR, edge: CELL_EDGE_COLOUR, alpha: 0.42 }]
        : []),
    ];

    if (volumes.length > 0) {
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);

      for (const volume of volumes) {
        gl.useProgram(solid);
        gl.uniformMatrix4fv(loc.solid.viewProjection, false, viewProjection);
        gl.uniform3fv(loc.solid.eye, new Float32Array(eye));
        bindSolid(volume.cell);
        gl.uniform3fv(loc.solid.colour, new Float32Array(volume.fill));
        gl.uniform1f(loc.solid.alpha, volume.alpha);
        gl.uniform1f(loc.solid.hatch, volume.hatch ? 10 * dpr : 0);
        if (volume.hatch) gl.uniform3fv(loc.solid.hatchColour, new Float32Array(volume.hatch));
        gl.drawElements(gl.TRIANGLES, volume.cell.count, gl.UNSIGNED_INT, 0);

        // The outline is what actually communicates the cell's size, so it is
        // drawn with the depth test off: a cell inside the body must still be
        // locatable from outside it.
        gl.useProgram(line);
        gl.uniformMatrix4fv(loc.line.viewProjection, false, viewProjection);
        gl.uniform3fv(loc.line.colour, new Float32Array(volume.edge));
        gl.uniform1f(loc.line.alpha, Math.min(0.95, volume.alpha * 2.3));
        gl.disable(gl.DEPTH_TEST);
        for (const edge of volume.cell.edges) {
          gl.bindBuffer(gl.ARRAY_BUFFER, edge.buffer);
          gl.enableVertexAttribArray(loc.line.position);
          gl.vertexAttribPointer(loc.line.position, 3, gl.FLOAT, false, 0, 0);
          gl.drawArrays(gl.LINE_STRIP, 0, edge.count);
        }
        gl.enable(gl.DEPTH_TEST);
      }

      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    // --- polylines: the spine axis, research highlights -------------------
    if (scene.lines.length > 0) {
      gl.useProgram(line);
      gl.uniformMatrix4fv(loc.line.viewProjection, false, viewProjection);
      for (const item of scene.lines) {
        if (!item.visible) continue;
        gl.uniform3fv(loc.line.colour, new Float32Array(item.colour));
        gl.uniform1f(loc.line.alpha, item.opacity ?? 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, item.buffer);
        gl.enableVertexAttribArray(loc.line.position);
        gl.vertexAttribPointer(loc.line.position, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINE_STRIP, 0, item.count);
      }
    }
  }

  /** World millimetres -> canvas CSS pixels, or `null` when behind the camera. (docs/viewer-shell.md) */
  function projectPoint(point, camera, width, height) {
    const eye = eyeOf(camera);
    const far = camera.distance * 4 + 2000;
    const viewProjection = multiply(
      perspective(FOV_Y, width / height, Math.max(1, camera.distance * 0.01), far),
      lookAt(eye, camera.target, UP),
    );
    const clip = [0, 0, 0, 0];
    for (let row = 0; row < 4; row += 1) {
      clip[row] =
        viewProjection[row] * point[0] +
        viewProjection[4 + row] * point[1] +
        viewProjection[8 + row] * point[2] +
        viewProjection[12 + row];
    }
    if (!(clip[3] > 1e-6)) return null;
    return [
      ((clip[0] / clip[3]) * 0.5 + 0.5) * width,
      (0.5 - (clip[1] / clip[3]) * 0.5) * height,
    ];
  }

  function uploadPolyline(points) {
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => flat.set(p, i * 3));
    return { buffer: makeBuffer(flat), count: points.length };
  }

  function dispose() {
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    buffers.clear();
    gl.deleteProgram(solid);
    gl.deleteProgram(line);
  }

  return { uploadSurface, uploadCell, uploadPolyline, projectPoint, release, render, dispose };
}
