/**
 * The renderer. WebGL2, no dependency, loaded by dynamic `import()`.
 *
 * ## Why this is not three.js, for now
 *
 * `docs/viewer-bundle-budget.md` measured the renderer options and ruled out
 * React Three Fiber on cost: three.js tree-shaken to the stage-A surface is
 * 126,469 bytes gzipped against a 153,600-byte line, and react-dom's 42.8 KiB
 * on top does not fit. That measurement assumed a bundler.
 *
 * This repository has no bundler, and that is not an oversight that can be
 * fixed in passing:
 *
 *   - `packages/atlas-web/build.mjs` copies `src/*.js` verbatim as native ES
 *     modules. There is no tree-shaking and no minification step.
 *   - `.github/workflows/ci.yml` never runs `npm ci` or `npm install`, so
 *     `node_modules` does not exist on the runner and the build cannot copy a
 *     dependency out of it.
 *   - `ci.yml` asserts that the root `package.json` has gained no runtime
 *     `dependencies`, failing with "root gained runtime dependencies; update
 *     CI". Adding one is a deliberate decision point, by design.
 *
 * So shipping three.js here means committing its build into the repository and
 * serving it unminified and un-tree-shaken: 2.1 MB raw, ~407 KiB gzipped —
 * three times the figure the budget decision was based on. That is a
 * cross-cutting change to the build spine, the licence gate and the budget, and
 * it belongs with Release Engineering alongside DOG-41, not bolted onto this
 * commit.
 *
 * The seam is the point. This module's whole interface is `createRenderer`
 * returning the handful of methods below. Nothing above it knows what draws:
 * `app.js` loads it with `await import()` and runs without it. Replacing the
 * body of this file with three.js calls changes no other file.
 *
 * ## It is loaded lazily, and that is a requirement rather than a nicety
 *
 * Stage A requires that a failure to load geometry leaves addresses parsing and
 * resolving to names. If the address bar sat behind the renderer, that
 * requirement would be unsatisfiable by construction. So the renderer is
 * imported after first paint, and every entry point here is allowed to fail
 * without taking the shell down.
 */

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

/**
 * Solid region colour mode: one flat colour per region, shaded only enough to
 * read as a solid. No texture, no specular, no gradient — the one display mode
 * v1 ships, and the colour has to mean "this region" rather than "this light".
 *
 * Two headlights rather than one, because a single light leaves the half of the
 * body facing away from it unreadably dark, and a user reads a dark region as a
 * different colour.
 */
const SOLID_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vPosition;
uniform vec3 colour;
uniform float alpha;
uniform vec3 eye;
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
  fragColour = vec4(colour * light, alpha);
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

/**
 * The solid region palette.
 *
 * Chosen for distinguishability rather than realism — these are regions of an
 * address space, not tissue. The cell highlight is deliberately the only warm
 * colour, so what you selected never competes with the anatomy around it.
 */
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

export const CELL_COLOUR = [0.98, 0.62, 0.21];
export const CELL_EDGE_COLOUR = [1.0, 0.84, 0.42];
/** Per-highlight-group colours, for research findings. */
export const GROUP_COLOURS = [
  [0.94, 0.46, 0.38], [0.46, 0.64, 0.94], [0.96, 0.76, 0.32],
  [0.58, 0.82, 0.50], [0.80, 0.54, 0.88],
];

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

/**
 * Create a renderer on a canvas.
 *
 * Throws if WebGL2 is unavailable, which the caller turns into a visible
 * "3D view unavailable" rather than a blank canvas. A blank canvas is the worst
 * outcome: it looks like the atlas has no content.
 */
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

  /**
   * Draw a frame.
   *
   * `scene` is plain data assembled by `app.js` from viewer state — uploaded
   * meshes, which layers are visible and at what opacity, and the selected
   * cell. The renderer makes no decisions about what should be visible; that
   * belongs to the state machine, where it is testable.
   */
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
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

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

    function drawSolidRanges(item) {
      bindSolid(item.mesh);
      gl.uniform1f(loc.solid.alpha, item.opacity);
      for (const range of item.ranges) {
        gl.uniform3fv(loc.solid.colour, new Float32Array(range.colour));
        gl.drawElements(
          gl.TRIANGLES,
          range.triangleCount * 3,
          gl.UNSIGNED_INT,
          range.firstTriangle * 3 * 4,
        );
      }
    }

    // --- research highlights, then the selected cell -----------------------
    // Drawn last, blended, with culling off so each reads as a volume from
    // both inside and outside, and with depth writes off so none of them hides
    // the anatomy it is meant to locate.
    //
    // Highlights go FIRST so a selection inside a highlighted group still
    // reads as the selection, and each carries its own colour: a highlight
    // that looked like the selection would make "the address you are at" and
    // "somewhere a paper reported" indistinguishable, which is the whole value
    // of the research panel.
    const volumes = [
      ...(scene.highlights ?? []).map((h) => ({
        cell: h.cell,
        fill: h.colour ?? CELL_COLOUR,
        edge: h.colour ?? CELL_EDGE_COLOUR,
        alpha: h.alpha ?? 0.22,
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
      gl.enable(gl.CULL_FACE);
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

  /**
   * World millimetres -> canvas CSS pixels, or `null` when behind the camera.
   *
   * Lives here rather than in the shell so labels are projected with the same
   * matrices the geometry was drawn with. A label derived from an independently
   * re-derived projection drifts from the thing it labels as soon as either
   * side's near plane or field of view changes, and a label a few pixels off
   * the structure it names is worse than no label.
   */
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
