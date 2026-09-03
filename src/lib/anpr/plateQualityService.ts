import { BoundingBox } from './tracker';
import {
  clampCropBox,
  generateAdaptiveCrops,
  PreprocessVariant,
  releaseCanvasMemory,
} from './imageProcessor';
import {
  PLATE_QUALITY_CLASSES,
  PlateQualityClass,
} from './adaptiveConfig';
import {
  canUseWebGpuExecutionProvider,
  configureOrtWasm,
  fetchWithTimeout,
  getOrt,
  withTimeout,
} from './onnxRuntime';
import {
  DEFAULT_PLATE_QUALITY_METADATA,
  PlateQualityBackend,
  PlateQualityMeasurements,
  PlateQualityMetadata,
  classifyHeuristicQuality,
  createEmptyQualityProbabilities,
  getPrimaryQualityClass,
  getQualityPreprocessingPlan,
  isCorrectableQualityClass,
  isHardRejectQualityClass,
  measurePlateCrop,
  createPlateQualityDatasetSchema,
  parsePlateQualityMetadata,
  probabilitiesFromOutput,
  type PlateQualityDecision,
  scorePlateQuality,
} from './plateQualityScoring';
import { assessCropQuality, CropQualityReport } from './qualityAssessor';

export type PlateQualityModelStatus = 'UNINITIALIZED' | 'LOADING' | 'READY' | 'FALLBACK' | 'FAILED';
export type QualityEngineLabel = 'QUALITY ENGINE: HEURISTIC' | 'QUALITY ENGINE: ONNX WEBGPU' | 'QUALITY ENGINE: ONNX WASM';

export interface PlateQualityResult {
  primaryClass: PlateQualityClass;
  confidence: number;
  probabilities: Record<string, number>;
  acceptableForOCR: boolean;
  qualityScore: number;
  rejectionReasons: string[];
  backend: PlateQualityBackend;
  latencyMs: number;
  measurements: PlateQualityMeasurements;
  report: CropQualityReport;
  selectedPreprocessing: PreprocessVariant[];
  correctable: boolean;
  sampledAt: number;
  engineLabel: QualityEngineLabel;

  // Compatibility aliases for the scanner path that existed before this service.
  label: PlateQualityClass;
  source: 'YOLOV8_CLASSIFIER' | 'HEURISTIC';
  shouldSendToOcr: boolean;
  score: number;
}

export type PlateQualityAssessment = PlateQualityResult;

export interface PlateQualityModelOptions {
  heuristicReport?: CropQualityReport;
  minReadableWidth?: number;
  minQualityScore?: number;
  detectorConfidence?: number;
  perspectiveScore?: number;
  trackStability?: number;
  cropAgeMs?: number;
  maxCropAgeMs?: number;
  acceptedClasses?: PlateQualityClass[];
  marginalClasses?: PlateQualityClass[];
  minimumClassifierConfidence?: number;
}

export interface PlateQualityTensorInput {
  data: Float32Array;
  dims: [number, number, number, number];
}

export interface PlateQualityServiceDependencies {
  fetchFn?: typeof fetch;
  getOrtFn?: typeof getOrt;
  canUseWebGpuFn?: typeof canUseWebGpuExecutionProvider;
  nowFn?: () => number;
}

const QUALITY_MODEL_PATH = '/models/plate-quality-classifier.onnx';
const QUALITY_METADATA_PATH = '/models/plate-quality-classifier.metadata.json';
const MODEL_FETCH_TIMEOUT_MS = 12000;
const MODEL_INIT_TIMEOUT_MS = 12000;
const MODEL_INFERENCE_TIMEOUT_MS = 2000;
const METADATA_FETCH_TIMEOUT_MS = 2500;

export class PlateQualityService {
  private session: any = null;
  private status: PlateQualityModelStatus = 'UNINITIALIZED';
  private backend: PlateQualityBackend = 'heuristic';
  private initPromise: Promise<boolean> | null = null;
  private error: string | null = null;
  private metadata: PlateQualityMetadata = DEFAULT_PLATE_QUALITY_METADATA;
  private reusableCanvas: HTMLCanvasElement | null = null;
  private reusableCtx: CanvasRenderingContext2D | null = null;
  private readonly deps: Required<PlateQualityServiceDependencies>;

  constructor(deps: PlateQualityServiceDependencies = {}) {
    this.deps = {
      fetchFn: deps.fetchFn ?? fetch,
      getOrtFn: deps.getOrtFn ?? getOrt,
      canUseWebGpuFn: deps.canUseWebGpuFn ?? canUseWebGpuExecutionProvider,
      nowFn: deps.nowFn ?? (() => performance.now()),
    };
  }

  getStatus(): PlateQualityModelStatus {
    return this.status;
  }

  getBackend(): PlateQualityBackend {
    return this.backend;
  }

  getEngineLabel(): QualityEngineLabel {
    if (this.backend === 'webgpu') return 'QUALITY ENGINE: ONNX WEBGPU';
    if (this.backend === 'wasm') return 'QUALITY ENGINE: ONNX WASM';
    return 'QUALITY ENGINE: HEURISTIC';
  }

  getError(): string | null {
    return this.error;
  }

  getMetadata(): PlateQualityMetadata {
    return this.metadata;
  }

  async init(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (this.session && this.status === 'READY') return true;
    if (this.status === 'FALLBACK' || this.status === 'FAILED') return false;
    if (this.initPromise) return this.initPromise;

    this.status = 'LOADING';
    this.error = null;

    this.initPromise = (async () => {
      try {
        this.metadata = await this.loadMetadata();
        const modelResponse = await this.fetchWithTimeout(
          QUALITY_MODEL_PATH,
          MODEL_FETCH_TIMEOUT_MS,
          'Plate quality classifier model fetch'
        );

        if (!modelResponse.ok) {
          this.status = 'FALLBACK';
          this.backend = 'heuristic';
          this.error =
            modelResponse.status === 404
              ? 'Plate quality classifier ONNX model not found; using heuristic quality engine.'
              : `HTTP ${modelResponse.status} fetching ${QUALITY_MODEL_PATH}`;
          return false;
        }

        const ort = await this.deps.getOrtFn();
        const webGpuAvailable = this.deps.canUseWebGpuFn();
        configureOrtWasm(ort, webGpuAvailable);
        const modelBytes = new Uint8Array(await modelResponse.arrayBuffer());
        const attempts: { backend: PlateQualityBackend; providers: string[] }[] = webGpuAvailable
          ? [
              { backend: 'webgpu', providers: ['webgpu'] },
              { backend: 'wasm', providers: ['wasm'] },
            ]
          : [{ backend: 'wasm', providers: ['wasm'] }];

        for (const attempt of attempts) {
          try {
            this.session = await withTimeout<any>(
              ort.InferenceSession.create(modelBytes, {
                executionProviders: attempt.providers,
                graphOptimizationLevel: 'all',
              }),
              MODEL_INIT_TIMEOUT_MS,
              `Plate quality classifier ${attempt.backend} session creation`
            );
            this.backend = attempt.backend;
            await this.warmup(ort);
            this.status = 'READY';
            return true;
          } catch (err: any) {
            this.error = err?.message || String(err);
            this.session = null;
          }
        }

        this.status = 'FAILED';
        this.backend = 'heuristic';
        return false;
      } catch (err: any) {
        this.status = 'FALLBACK';
        this.backend = 'heuristic';
        this.error = err?.message || String(err);
        return false;
      }
    })().finally(() => {
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async classify(cropCanvas: HTMLCanvasElement, options: PlateQualityModelOptions = {}): Promise<PlateQualityResult> {
    const startedAt = this.deps.nowFn();
    const { report, measurements } = measurePlateCrop(cropCanvas, options);
    const minReadableWidth = options.minReadableWidth ?? 48;
    const minQualityScore = options.minQualityScore ?? 0.34;
    const minimumClassifierConfidence = options.minimumClassifierConfidence ?? 0.45;
    const modelReady = await this.init();

    if (modelReady && this.session) {
      try {
        const modelResult = await this.runClassifier(cropCanvas, measurements, report, {
          minQualityScore,
          minimumClassifierConfidence,
          startedAt,
        });
        if (modelResult) return modelResult;
      } catch (err: any) {
        this.status = 'FALLBACK';
        this.backend = 'heuristic';
        this.error = err?.message || String(err);
      }
    }

    const heuristic = classifyHeuristicQuality(measurements, minReadableWidth);
    const decision = scorePlateQuality({
      primaryClass: heuristic.primaryClass,
      confidence: heuristic.confidence,
      probabilities: heuristic.probabilities,
      measurements,
      minQualityScore,
      minimumClassifierConfidence,
    });
    const fallbackDecision = applyLegacyHeuristicFallback(
      decision,
      report,
      measurements.cropWidth,
      measurements.cropHeight,
      minReadableWidth
    );

    return this.buildResult({
      primaryClass: heuristic.primaryClass,
      confidence: heuristic.confidence,
      probabilities: heuristic.probabilities,
      measurements,
      report,
      decision: fallbackDecision,
      backend: 'heuristic',
      latencyMs: this.deps.nowFn() - startedAt,
    });
  }

  classifyFromSource(
    source: HTMLCanvasElement | HTMLVideoElement,
    bbox: BoundingBox,
    options: PlateQualityModelOptions = {}
  ): Promise<PlateQualityResult> {
    const crop = extractPlateCrop(source, bbox);
    return this.classify(crop, options).finally(() => releaseCanvasMemory(crop));
  }

  prepareTensor(canvas: HTMLCanvasElement, metadata: PlateQualityMetadata = this.metadata): PlateQualityTensorInput {
    return preparePlateQualityTensor(canvas, metadata, this.getReusableCanvas(metadata));
  }

  private async loadMetadata(): Promise<PlateQualityMetadata> {
    try {
      const response = await this.fetchWithTimeout(
        QUALITY_METADATA_PATH,
        METADATA_FETCH_TIMEOUT_MS,
        'Plate quality classifier metadata fetch'
      );
      if (!response.ok) return DEFAULT_PLATE_QUALITY_METADATA;
      return parsePlateQualityMetadata(await response.json());
    } catch {
      return DEFAULT_PLATE_QUALITY_METADATA;
    }
  }

  private async warmup(ort: any): Promise<void> {
    if (!this.session) return;
    const inputName = this.session.inputNames?.[0] || 'images';
    const dims: [number, number, number, number] = [1, 3, this.metadata.inputHeight, this.metadata.inputWidth];
    const tensor = new ort.Tensor('float32', new Float32Array(3 * this.metadata.inputWidth * this.metadata.inputHeight), dims);
    let outputs: Record<string, any> | null = null;

    try {
      outputs = await withTimeout<Record<string, any>>(
        this.session.run({ [inputName]: tensor }),
        MODEL_INFERENCE_TIMEOUT_MS,
        'Plate quality classifier warmup'
      );
    } finally {
      tensor.dispose?.();
      if (outputs) Object.values(outputs).forEach((output) => output?.dispose?.());
    }
  }

  private async runClassifier(
    cropCanvas: HTMLCanvasElement,
    measurements: PlateQualityMeasurements,
    report: CropQualityReport,
    options: {
      minQualityScore: number;
      minimumClassifierConfidence: number;
      startedAt: number;
    }
  ): Promise<PlateQualityResult | null> {
    if (!this.session) return null;

    const ort = await this.deps.getOrtFn();
    const input = this.prepareTensor(cropCanvas);
    const inputName = this.session.inputNames?.[0] || 'images';
    const tensor = new ort.Tensor('float32', input.data, input.dims);
    let outputs: Record<string, any> | null = null;

    try {
      outputs = await withTimeout<Record<string, any>>(
        this.session.run({ [inputName]: tensor }),
        MODEL_INFERENCE_TIMEOUT_MS,
        'Plate quality classifier inference'
      );
      const outputName = this.session.outputNames?.[0] || Object.keys(outputs)[0];
      const probabilities = probabilitiesFromOutput(outputs[outputName]?.data || [], this.metadata.classes);
      const top = getPrimaryQualityClass(probabilities, this.metadata.classes);
      const decision = scorePlateQuality({
        primaryClass: top.primaryClass,
        confidence: top.confidence,
        probabilities,
        measurements,
        minQualityScore: options.minQualityScore,
        minimumClassifierConfidence: options.minimumClassifierConfidence,
      });

      return this.buildResult({
        primaryClass: top.primaryClass,
        confidence: top.confidence,
        probabilities,
        measurements,
        report,
        decision,
        backend: this.backend === 'webgpu' ? 'webgpu' : 'wasm',
        latencyMs: this.deps.nowFn() - options.startedAt,
      });
    } finally {
      tensor.dispose?.();
      if (outputs) Object.values(outputs).forEach((output) => output?.dispose?.());
    }
  }

  private buildResult(args: {
    primaryClass: PlateQualityClass;
    confidence: number;
    probabilities: Record<string, number>;
    measurements: PlateQualityMeasurements;
    report: CropQualityReport;
    decision: ReturnType<typeof scorePlateQuality>;
    backend: PlateQualityBackend;
    latencyMs: number;
  }): PlateQualityResult {
    return {
      primaryClass: args.primaryClass,
      confidence: roundMetric(args.confidence),
      probabilities: args.probabilities,
      acceptableForOCR: args.decision.acceptableForOCR,
      qualityScore: args.decision.qualityScore,
      rejectionReasons: args.decision.rejectionReasons,
      backend: args.backend,
      latencyMs: Math.max(0, Math.round(args.latencyMs * 10) / 10),
      measurements: args.measurements,
      report: args.report,
      selectedPreprocessing: args.decision.selectedPreprocessing,
      correctable: args.decision.correctable,
      sampledAt: Date.now(),
      engineLabel: args.backend === 'webgpu'
        ? 'QUALITY ENGINE: ONNX WEBGPU'
        : args.backend === 'wasm'
          ? 'QUALITY ENGINE: ONNX WASM'
          : 'QUALITY ENGINE: HEURISTIC',
      label: args.primaryClass,
      source: args.backend === 'heuristic' ? 'HEURISTIC' : 'YOLOV8_CLASSIFIER',
      shouldSendToOcr: args.decision.acceptableForOCR,
      score: args.decision.qualityScore,
    };
  }

  private getReusableCanvas(metadata: PlateQualityMetadata): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D | null;
  } {
    if (!this.reusableCanvas) {
      this.reusableCanvas = document.createElement('canvas');
      this.reusableCtx = this.reusableCanvas.getContext('2d', { willReadFrequently: true });
    }

    if (this.reusableCanvas.width !== metadata.inputWidth || this.reusableCanvas.height !== metadata.inputHeight) {
      this.reusableCanvas.width = metadata.inputWidth;
      this.reusableCanvas.height = metadata.inputHeight;
    }

    return { canvas: this.reusableCanvas, ctx: this.reusableCtx };
  }

  private fetchWithTimeout(url: string, timeoutMs: number, label: string): Promise<Response> {
    if (this.deps.fetchFn === fetch) {
      return fetchWithTimeout(url, timeoutMs, label);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return this.deps.fetchFn(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }
}

export function extractPlateCrop(
  source: HTMLCanvasElement | HTMLVideoElement,
  bbox: BoundingBox,
  targetWidth = 360,
  targetHeight = 108
): HTMLCanvasElement {
  const sourceWidth = getSourceWidth(source);
  const sourceHeight = getSourceHeight(source);
  const cropBox = clampCropBox(bbox, sourceWidth, sourceHeight);
  const output = document.createElement('canvas');
  const aspect = cropBox.width / Math.max(1, cropBox.height);
  const outputWidth = targetWidth;
  const outputHeight = Math.max(32, Math.min(targetHeight * 2, Math.round(outputWidth / Math.max(0.8, aspect))));
  output.width = outputWidth;
  output.height = outputHeight;
  const ctx = output.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.drawImage(source, cropBox.x, cropBox.y, cropBox.width, cropBox.height, 0, 0, output.width, output.height);
  }
  return output;
}

export function preparePlateQualityTensor(
  sourceCanvas: HTMLCanvasElement,
  metadata: PlateQualityMetadata,
  reusable?: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null }
): PlateQualityTensorInput {
  const targetCanvas = reusable?.canvas ?? document.createElement('canvas');
  targetCanvas.width = metadata.inputWidth;
  targetCanvas.height = metadata.inputHeight;
  const ctx = reusable?.ctx ?? targetCanvas.getContext('2d', { willReadFrequently: true });
  const area = metadata.inputWidth * metadata.inputHeight;
  const tensorData = new Float32Array(area * 3);

  if (!ctx || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
    return { data: tensorData, dims: [1, 3, metadata.inputHeight, metadata.inputWidth] };
  }

  ctx.fillStyle = 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, metadata.inputWidth, metadata.inputHeight);

  const sourceAspect = sourceCanvas.width / Math.max(1, sourceCanvas.height);
  const targetAspect = metadata.inputWidth / Math.max(1, metadata.inputHeight);
  let drawWidth = metadata.inputWidth;
  let drawHeight = metadata.inputHeight;
  let dx = 0;
  let dy = 0;
  let sx = 0;
  let sy = 0;
  let sw = sourceCanvas.width;
  let sh = sourceCanvas.height;

  if (metadata.resizeMode === 'center-crop') {
    if (sourceAspect > targetAspect) {
      sw = Math.round(sourceCanvas.height * targetAspect);
      sx = Math.round((sourceCanvas.width - sw) / 2);
    } else {
      sh = Math.round(sourceCanvas.width / targetAspect);
      sy = Math.round((sourceCanvas.height - sh) / 2);
    }
  } else if (sourceAspect > targetAspect) {
    drawWidth = metadata.inputWidth;
    drawHeight = Math.round(metadata.inputWidth / sourceAspect);
    dy = Math.round((metadata.inputHeight - drawHeight) / 2);
  } else {
    drawHeight = metadata.inputHeight;
    drawWidth = Math.round(metadata.inputHeight * sourceAspect);
    dx = Math.round((metadata.inputWidth - drawWidth) / 2);
  }

  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, drawWidth, drawHeight);

  const image = ctx.getImageData(0, 0, metadata.inputWidth, metadata.inputHeight);
  const { data } = image;
  const scale = metadata.normalization.scale;
  const mean = metadata.normalization.mean;
  const std = metadata.normalization.std;

  for (let i = 0; i < area; i++) {
    const r = data[i * 4] * scale;
    const g = data[i * 4 + 1] * scale;
    const b = data[i * 4 + 2] * scale;
    tensorData[i] = normalizeChannel(r, mean?.[0], std?.[0]);
    tensorData[area + i] = normalizeChannel(g, mean?.[1], std?.[1]);
    tensorData[area * 2 + i] = normalizeChannel(b, mean?.[2], std?.[2]);
  }

  return { data: tensorData, dims: [1, 3, metadata.inputHeight, metadata.inputWidth] };
}

export async function recoverCorrectablePlateCrop(
  sourceCrop: HTMLCanvasElement,
  initialAssessment: PlateQualityResult,
  service: PlateQualityService = globalPlateQualityService,
  options: PlateQualityModelOptions = {}
): Promise<{ crop: HTMLCanvasElement; assessment: PlateQualityResult; variant: PreprocessVariant } | null> {
  if (!isCorrectableQualityClass(initialAssessment.primaryClass)) return null;
  const variants = getQualityPreprocessingPlan(initialAssessment.primaryClass);

  for (const variant of variants) {
    const [candidate] = generateAdaptiveCrops(
      sourceCrop,
      { x: 0, y: 0, width: sourceCrop.width, height: sourceCrop.height, confidence: 1 },
      Math.max(224, sourceCrop.width),
      Math.max(72, sourceCrop.height),
      [variant]
    );
    if (!candidate?.canvas) continue;

    const assessment = await service.classify(candidate.canvas, {
      ...options,
      heuristicReport: assessCropQuality(candidate.canvas),
    });
    if (assessment.acceptableForOCR) {
      releaseCanvasMemory(candidate.topLineCanvas);
      releaseCanvasMemory(candidate.bottomLineCanvas);
      return { crop: candidate.canvas, assessment, variant };
    }

    releaseCanvasMemory(candidate.canvas);
    releaseCanvasMemory(candidate.topLineCanvas);
    releaseCanvasMemory(candidate.bottomLineCanvas);
  }

  return null;
}

export const globalPlateQualityService = new PlateQualityService();

export function getPlateQualityModelStatus(): PlateQualityModelStatus {
  return globalPlateQualityService.getStatus();
}

export function getPlateQualityModelError(): string | null {
  return globalPlateQualityService.getError();
}

export function getPlateQualityBackend(): PlateQualityBackend {
  return globalPlateQualityService.getBackend();
}

export function getPlateQualityEngineLabel(): QualityEngineLabel {
  return globalPlateQualityService.getEngineLabel();
}

export function initPlateQualityModel(): Promise<boolean> {
  return globalPlateQualityService.init();
}

export function classifyPlateQuality(
  cropCanvas: HTMLCanvasElement,
  options: PlateQualityModelOptions = {}
): Promise<PlateQualityResult> {
  return globalPlateQualityService.classify(cropCanvas, options);
}

function applyLegacyHeuristicFallback(
  decision: PlateQualityDecision,
  report: CropQualityReport,
  cropWidth: number,
  cropHeight: number,
  minReadableWidth: number
): PlateQualityDecision {
  if (decision.acceptableForOCR || report.recommendation === 'REJECT') return decision;

  const hasReadableDimensions = cropWidth >= minReadableWidth && cropHeight >= 18;
  const legacyScannerWouldTryOcr = hasReadableDimensions && report.overallScore >= 0.25 && report.blurScore >= 15;
  if (!legacyScannerWouldTryOcr) return decision;

  return {
    ...decision,
    acceptableForOCR: true,
    rejectionReasons: [],
    selectedPreprocessing: [
      'ORIGINAL',
      ...decision.selectedPreprocessing.filter((variant) => variant !== 'ORIGINAL'),
    ],
  };
}

export {
  DEFAULT_PLATE_QUALITY_METADATA,
  PLATE_QUALITY_CLASSES,
  createEmptyQualityProbabilities,
  getPrimaryQualityClass,
  getQualityPreprocessingPlan,
  isCorrectableQualityClass,
  isHardRejectQualityClass,
  measurePlateCrop,
  createPlateQualityDatasetSchema,
  parsePlateQualityMetadata,
  probabilitiesFromOutput,
  scorePlateQuality,
};

function getSourceWidth(source: HTMLCanvasElement | HTMLVideoElement): number {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.videoWidth || source.width || 0;
  }
  return source.width || 0;
}

function getSourceHeight(source: HTMLCanvasElement | HTMLVideoElement): number {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return source.videoHeight || source.height || 0;
  }
  return source.height || 0;
}

function normalizeChannel(value: number, mean?: number, std?: number): number {
  const centered = typeof mean === 'number' ? value - mean : value;
  return typeof std === 'number' && std > 0 ? centered / std : centered;
}

function roundMetric(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
