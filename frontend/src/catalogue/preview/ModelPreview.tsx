import { useEffect, useRef, useState } from 'react';
import './preview.css';

export type PreviewState =
  | { readonly status: 'queued' | 'processing' }
  | { readonly status: 'failed' | 'unsupported'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly kind: 'geometry' | 'toolpath';
      readonly artifactUrl: string;
      readonly dimensions?: {
        readonly width: number;
        readonly depth: number;
        readonly height: number;
      };
    };

interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

const initialCamera = (): Camera => ({ yaw: -0.65, pitch: 0.5, zoom: 1, panX: 0, panY: 0 });

export function ModelPreview({ preview }: { readonly preview: PreviewState }) {
  if (preview.status === 'queued' || preview.status === 'processing')
    return <PreviewNotice busy>Generating preview…</PreviewNotice>;
  if (preview.status === 'failed')
    return <PreviewNotice>Preview failed: {preview.message}</PreviewNotice>;
  if (preview.status === 'unsupported')
    return <PreviewNotice>Preview unavailable: {preview.message}</PreviewNotice>;
  if (preview.status !== 'ready') return null;
  if (preview.kind === 'toolpath') return <ToolpathCanvas url={preview.artifactUrl} />;
  return (
    <GlbCanvas
      url={preview.artifactUrl}
      {...(preview.dimensions ? { dimensions: preview.dimensions } : {})}
    />
  );
}

interface ToolpathDocument {
  readonly layers: readonly {
    readonly z: number;
    readonly segments: readonly (readonly [number, number, number, number])[];
  }[];
}

function ToolpathCanvas({ url }: { readonly url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [toolpath, setToolpath] = useState<ToolpathDocument>();
  const [layer, setLayer] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error('toolpath unavailable');
        return response.json();
      })
      .then((value: unknown) => {
        const parsed = readToolpath(value);
        setToolpath(parsed);
        setLayer(Math.max(0, parsed.layers.length - 1));
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(true);
      });
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    if (!canvas.current || !toolpath) return;
    drawToolpath(canvas.current, toolpath.layers[layer]?.segments ?? []);
  }, [layer, toolpath]);

  if (error) return <PreviewNotice>Generated toolpath could not be loaded.</PreviewNotice>;
  return (
    <section className="model-preview" aria-label="Read-only G-code layer preview">
      <canvas ref={canvas} width={800} height={520} aria-label="G-code extrusion toolpath" />
      {toolpath ? (
        <div className="model-preview-controls">
          <label>
            Layer
            <input
              type="range"
              min="0"
              max={Math.max(0, toolpath.layers.length - 1)}
              value={layer}
              onChange={(event) => setLayer(Number(event.target.value))}
            />
          </label>
          <span>
            {layer + 1} / {toolpath.layers.length} · Z {format(toolpath.layers[layer]?.z ?? 0)} mm
          </span>
        </div>
      ) : (
        <PreviewNotice busy>Loading toolpath…</PreviewNotice>
      )}
    </section>
  );
}

function readToolpath(value: unknown): ToolpathDocument {
  if (!value || typeof value !== 'object') throw new Error('Invalid toolpath preview.');
  const document = value as { version?: unknown; unit?: unknown; layers?: unknown };
  if (
    document.version !== 1 ||
    document.unit !== 'mm' ||
    !Array.isArray(document.layers) ||
    document.layers.length === 0 ||
    document.layers.length > 5_000
  )
    throw new Error('Invalid toolpath preview.');
  let segmentCount = 0;
  const layers = document.layers.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid toolpath layer.');
    const candidate = value as { z?: unknown; segments?: unknown };
    if (
      typeof candidate.z !== 'number' ||
      !Number.isFinite(candidate.z) ||
      !Array.isArray(candidate.segments)
    )
      throw new Error('Invalid toolpath layer.');
    const segments = candidate.segments.map((segment) => {
      segmentCount += 1;
      if (
        segmentCount > 1_000_000 ||
        !Array.isArray(segment) ||
        segment.length !== 4 ||
        !segment.every(
          (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
        )
      )
        throw new Error('Invalid toolpath segment.');
      return segment as [number, number, number, number];
    });
    return { z: candidate.z, segments };
  });
  return { layers };
}

function drawToolpath(
  canvas: HTMLCanvasElement,
  segments: readonly (readonly [number, number, number, number])[],
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = '#eef2f6';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (segments.length === 0) return;
  let minimumX = Infinity;
  let maximumX = -Infinity;
  let minimumY = Infinity;
  let maximumY = -Infinity;
  for (const [x1, y1, x2, y2] of segments) {
    minimumX = Math.min(minimumX, x1, x2);
    maximumX = Math.max(maximumX, x1, x2);
    minimumY = Math.min(minimumY, y1, y2);
    maximumY = Math.max(maximumY, y1, y2);
  }
  const scale = Math.min(
    (canvas.width - 48) / Math.max(maximumX - minimumX, 1e-9),
    (canvas.height - 48) / Math.max(maximumY - minimumY, 1e-9),
  );
  const offsetX = (canvas.width - (maximumX - minimumX) * scale) / 2;
  const offsetY = (canvas.height - (maximumY - minimumY) * scale) / 2;
  context.strokeStyle = '#29465b';
  context.lineWidth = 2;
  context.beginPath();
  for (const [x1, y1, x2, y2] of segments) {
    context.moveTo(
      offsetX + (x1 - minimumX) * scale,
      canvas.height - offsetY - (y1 - minimumY) * scale,
    );
    context.lineTo(
      offsetX + (x2 - minimumX) * scale,
      canvas.height - offsetY - (y2 - minimumY) * scale,
    );
  }
  context.stroke();
}

function GlbCanvas({
  url,
  dimensions,
}: {
  readonly url: string;
  readonly dimensions?: { readonly width: number; readonly depth: number; readonly height: number };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [vertices, setVertices] = useState<Float32Array>();
  const [camera, setCamera] = useState(initialCamera);
  const [error, setError] = useState(false);
  const drag = useRef<{ x: number; y: number; pan: boolean } | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch(url, { signal: controller.signal, credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error('preview unavailable');
        return response.arrayBuffer();
      })
      .then((buffer) => setVertices(readGlbPositions(buffer)))
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(true);
      });
    return () => controller.abort();
  }, [url]);

  useEffect(() => {
    if (!canvas.current || !vertices) return;
    draw(canvas.current, vertices, camera);
  }, [vertices, camera]);

  if (error) return <PreviewNotice>Generated preview could not be loaded.</PreviewNotice>;
  return (
    <section className="model-preview" aria-label="Interactive model preview">
      <canvas
        ref={canvas}
        width={800}
        height={520}
        tabIndex={0}
        aria-label="Drag to orbit, Shift-drag to pan, and scroll to zoom"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            pan: event.shiftKey || event.button === 2,
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          drag.current = { ...drag.current, x: event.clientX, y: event.clientY };
          setCamera((value) =>
            drag.current?.pan
              ? { ...value, panX: value.panX + dx, panY: value.panY + dy }
              : {
                  ...value,
                  yaw: value.yaw + dx * 0.01,
                  pitch: Math.max(-1.5, Math.min(1.5, value.pitch + dy * 0.01)),
                },
          );
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onWheel={(event) => {
          event.preventDefault();
          setCamera((value) => ({
            ...value,
            zoom: Math.max(0.2, Math.min(8, value.zoom * Math.exp(-event.deltaY * 0.002))),
          }));
        }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div className="model-preview-controls">
        <button type="button" onClick={() => setCamera(initialCamera())}>
          Reset camera
        </button>
        <button
          type="button"
          onClick={() => setCamera((value) => ({ ...value, zoom: 1, panX: 0, panY: 0 }))}
        >
          Fit to object
        </button>
        {dimensions ? (
          <span>
            {format(dimensions.width)} × {format(dimensions.depth)} × {format(dimensions.height)} mm
          </span>
        ) : null}
      </div>
    </section>
  );
}

function PreviewNotice({
  children,
  busy = false,
}: {
  readonly children: React.ReactNode;
  readonly busy?: boolean;
}) {
  return (
    <div className="model-preview-notice" aria-live="polite" aria-busy={busy}>
      {children}
    </div>
  );
}

export function readGlbPositions(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  if (
    buffer.byteLength < 28 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2
  )
    throw new Error('Invalid GLB preview.');
  const jsonLength = view.getUint32(12, true);
  if (20 + jsonLength + 8 > buffer.byteLength) throw new Error('Truncated GLB preview.');
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength))) as {
    accessors?: Array<{
      bufferView?: number;
      count?: number;
      componentType?: number;
      type?: string;
    }>;
    bufferViews?: Array<{ byteOffset?: number; byteLength?: number }>;
  };
  const accessor = document.accessors?.[0];
  const bufferView = document.bufferViews?.[accessor?.bufferView ?? -1];
  if (
    !accessor ||
    !bufferView ||
    accessor.componentType !== 5126 ||
    accessor.type !== 'VEC3' ||
    !Number.isSafeInteger(accessor.count)
  )
    throw new Error('Unsupported GLB preview layout.');
  const binaryOffset = 20 + Math.ceil(jsonLength / 4) * 4 + 8 + (bufferView.byteOffset ?? 0);
  const floatCount = (accessor.count ?? 0) * 3;
  if (binaryOffset + floatCount * 4 > buffer.byteLength) throw new Error('Truncated GLB geometry.');
  return new Float32Array(buffer.slice(binaryOffset, binaryOffset + floatCount * 4));
}

function draw(canvas: HTMLCanvasElement, vertices: Float32Array, camera: Camera): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#eef2f6';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const points = projected(vertices, camera, canvas.width, canvas.height);
  context.fillStyle = '#54728c';
  context.strokeStyle = '#29465b';
  context.lineWidth = 1.5;
  for (let index = 0; index < points.length; index += 3) {
    const first = points[index];
    const second = points[index + 1];
    const third = points[index + 2];
    if (!first || !second || !third) break;
    context.beginPath();
    context.moveTo(first[0], first[1]);
    context.lineTo(second[0], second[1]);
    context.lineTo(third[0], third[1]);
    context.closePath();
    context.fill();
    context.stroke();
  }
}

function projected(
  vertices: Float32Array,
  camera: Camera,
  width: number,
  height: number,
): Array<[number, number]> {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertices.length; index += 3) {
    const x = vertices[index];
    const y = vertices[index + 1];
    const z = vertices[index + 2];
    if (x === undefined || y === undefined || z === undefined) break;
    minimum[0] = Math.min(minimum[0], x);
    minimum[1] = Math.min(minimum[1], y);
    minimum[2] = Math.min(minimum[2], z);
    maximum[0] = Math.max(maximum[0], x);
    maximum[1] = Math.max(maximum[1], y);
    maximum[2] = Math.max(maximum[2], z);
  }
  const center: [number, number, number] = [
    (minimum[0] + maximum[0]) / 2,
    (minimum[1] + maximum[1]) / 2,
    (minimum[2] + maximum[2]) / 2,
  ];
  const extent = Math.max(
    maximum[0] - minimum[0],
    maximum[1] - minimum[1],
    maximum[2] - minimum[2],
    1e-9,
  );
  const scale = (Math.min(width, height) * 0.72 * camera.zoom) / extent;
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const result: Array<[number, number]> = [];
  for (let index = 0; index < vertices.length; index += 3) {
    const inputX = vertices[index];
    const inputY = vertices[index + 1];
    const inputZ = vertices[index + 2];
    if (inputX === undefined || inputY === undefined || inputZ === undefined) break;
    const x = inputX - center[0];
    const y = inputY - center[1];
    const z = inputZ - center[2];
    const rx = x * cy - z * sy;
    const rz = x * sy + z * cy;
    const ry = y * cp - rz * sp;
    result.push([width / 2 + camera.panX + rx * scale, height / 2 + camera.panY - ry * scale]);
  }
  return result;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
