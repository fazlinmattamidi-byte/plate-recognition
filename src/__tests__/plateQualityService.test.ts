import { afterEach, describe, expect, it, vi } from 'vitest';
import { BestFrameSelector } from '../lib/anpr/bestFrameSelector';
import { clampCropBox } from '../lib/anpr/imageProcessor';
import {
  DEFAULT_PLATE_QUALITY_METADATA,
  PlateQualityService,
  createPlateQualityDatasetSchema,
  getPrimaryQualityClass,
  getQualityPreprocessingPlan,
  parsePlateQualityMetadata,
  preparePlateQualityTensor,
  probabilitiesFromOutput,
  scorePlateQuality,
} from '../lib/anpr/plateQualityService';

type FakeCanvas = HTMLCanvasElement & {
  __data: Uint8ClampedArray;
};

type TestGlobal = typeof globalThis & {
  window?: unknown;
  document?: unknown;
};

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('PlateQualityService', () => {
  it('parses metadata and preserves metadata class order', () => {
    const metadata = parsePlateQualityMetadata({
      modelType: 'yolov8-classification',
      task: 'plate-quality-assessment',
      inputWidth: 320,
      inputHeight: 160,
      layout: 'NCHW',
      colorSpace: 'RGB',
      resizeMode: 'center-crop',
      normalization: { scale: 0.5, mean: [0.1, 0.2, 0.3], std: [1, 2, 3] },
      classes: ['BAD_ANGLE', 'GOOD', 'LOW_CONTRAST'],
    });

    expect(metadata.inputWidth).toBe(320);
    expect(metadata.inputHeight).toBe(160);
    expect(metadata.resizeMode).toBe('center-crop');
    expect(metadata.normalization.mean).toEqual([0.1, 0.2, 0.3]);
    expect(metadata.classes).toEqual(['BAD_ANGLE', 'GOOD', 'LOW_CONTRAST']);
  });

  it('maps classifier outputs by metadata class order', () => {
    const classes = ['BAD_ANGLE', 'GOOD', 'LOW_CONTRAST'] as const;
    const probabilities = probabilitiesFromOutput([0.05, 0.9, 0.05], classes);
    const top = getPrimaryQualityClass(probabilities, classes);

    expect(probabilities.GOOD).toBeCloseTo(0.9, 2);
    expect(top.primaryClass).toBe('GOOD');
    expect(top.confidence).toBeCloseTo(0.9, 2);
  });

  it('creates NCHW tensors using metadata dimensions', () => {
    const source = createFakeCanvas(8, 2, (x) => x * 20);
    const reusable = createReusableCanvas(4, 4);
    const tensor = preparePlateQualityTensor(source, {
      ...DEFAULT_PLATE_QUALITY_METADATA,
      inputWidth: 4,
      inputHeight: 4,
      resizeMode: 'letterbox',
    }, reusable);

    expect(tensor.dims).toEqual([1, 3, 4, 4]);
    expect(tensor.data).toHaveLength(48);
  });

  it('clamps crop boundaries safely', () => {
    const clamped = clampCropBox(
      { x: -20, y: 90, width: 80, height: 40, confidence: 0.8 },
      100,
      100
    );

    expect(clamped.x).toBe(0);
    expect(clamped.y).toBeLessThan(100);
    expect(clamped.width).toBeGreaterThan(0);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(100);
  });

  it('calculates quality score and OCR acceptance for good crops', () => {
    const decision = scorePlateQuality({
      primaryClass: 'GOOD',
      confidence: 0.86,
      probabilities: {
        GOOD: 0.86,
        STANDARD_RECTANGLE: 0,
        SQUARE_PLATE: 0,
        TWO_LINE_PLATE: 0,
        EV_WHITE_PLATE: 0,
        SLIGHT_ROTATION: 0,
        PERSPECTIVE_DISTORTION: 0,
        MOTION_BLUR: 0.01,
        OUT_OF_FOCUS: 0.01,
        TOO_SMALL: 0.01,
        LOW_CONTRAST: 0.04,
        OVEREXPOSED: 0.01,
        UNDEREXPOSED: 0.01,
        GLARE_REFLECTION: 0.02,
        OCCLUDED: 0.01,
        BAD_ANGLE: 0.02,
      },
      measurements: goodMeasurements(),
      minQualityScore: 0.45,
    });

    expect(decision.acceptableForOCR).toBe(true);
    expect(decision.qualityScore).toBeGreaterThan(0.65);
    expect(decision.rejectionReasons).toEqual([]);
  });

  it('accepts readable Malaysian layout classes for OCR', () => {
    for (const primaryClass of ['STANDARD_RECTANGLE', 'SQUARE_PLATE', 'TWO_LINE_PLATE', 'EV_WHITE_PLATE', 'SLIGHT_ROTATION'] as const) {
      const decision = scorePlateQuality({
        primaryClass,
        confidence: 0.78,
        probabilities: { ...zeroProbabilities(), [primaryClass]: 0.78, GOOD: 0.10 },
        measurements: {
          ...goodMeasurements(),
          aspectRatio: primaryClass === 'SQUARE_PLATE' ? 1.2 : primaryClass === 'TWO_LINE_PLATE' ? 1.9 : 4.7,
          whitePlateLikelihood: primaryClass === 'EV_WHITE_PLATE' ? 0.72 : 0.12,
          perspectiveScore: primaryClass === 'SLIGHT_ROTATION' ? 0.58 : 0.92,
        },
        minQualityScore: 0.35,
      });

      expect(decision.acceptableForOCR).toBe(true);
    }
  });

  it('gates OCR and waits for a better crop on hard rejection classes', () => {
    const decision = scorePlateQuality({
      primaryClass: 'MOTION_BLUR',
      confidence: 0.82,
      probabilities: { ...zeroProbabilities(), MOTION_BLUR: 0.82, GOOD: 0.05 },
      measurements: { ...goodMeasurements(), sharpnessScore: 0.12, motionBlurScore: 0.8 },
      minQualityScore: 0.35,
    });

    expect(decision.acceptableForOCR).toBe(false);
    expect(decision.rejectionReasons).toContain('MOTION_BLUR');
  });

  it('selects condition-specific preprocessing for correctable classes', () => {
    expect(getQualityPreprocessingPlan('LOW_CONTRAST')).toContain('CLAHE');
    expect(getQualityPreprocessingPlan('UNDEREXPOSED')).toContain('GAMMA_BRIGHTEN');
    expect(getQualityPreprocessingPlan('OVEREXPOSED')).toContain('HIGHLIGHT_REDUCED');
    expect(getQualityPreprocessingPlan('GLARE_REFLECTION')).toContain('INVERTED');
    expect(getQualityPreprocessingPlan('MOTION_BLUR')).toEqual([]);
  });

  it('keeps and reranks top best-frame candidates after quality assessment', () => {
    const selector = new BestFrameSelector();
    const first = createFakeCanvas(96, 28, () => 95);
    const second = createFakeCanvas(160, 44, (x, y) => (x + y) % 2 ? 245 : 10);

    selector.addCropCandidate(1, first, { x: 0, y: 0, width: 96, height: 28, confidence: 0.55 });
    const firstBest = selector.getBestCrop(1);
    selector.addCropCandidate(1, second, { x: 0, y: 0, width: 160, height: 44, confidence: 0.92 });
    const nextBest = selector.getBestCrop(1);

    expect(selector.getTopCrops(1, 2)).toHaveLength(2);
    expect(firstBest?.id).not.toBe(nextBest?.id);
  });

  it('falls back clearly when the quality ONNX model is missing', async () => {
    (globalThis as any).window = {};
    const service = new PlateQualityService({
      fetchFn: vi.fn(async () => ({ ok: false, status: 404 } as Response)),
    });

    await expect(service.init()).resolves.toBe(false);
    expect(service.getStatus()).toBe('FALLBACK');
    expect(service.getBackend()).toBe('heuristic');
    expect(service.getEngineLabel()).toBe('QUALITY ENGINE: HEURISTIC');
  });

  it('keeps legacy OCR admission for marginal heuristic crops when the quality model is missing', async () => {
    (globalThis as any).window = {};
    const service = new PlateQualityService({
      fetchFn: vi.fn(async () => ({ ok: false, status: 404 } as Response)),
    });
    const result = await service.classify(createFakeCanvas(180, 52, (x, y) => ((x + y) % 2 ? 80 : 170)), {
      heuristicReport: {
        overallScore: 0.34,
        isBlurry: true,
        blurScore: 22,
        brightnessScore: 0.58,
        contrastScore: 0.35,
        glareScore: 0.1,
        motionBlurScore: 0.7,
        sharpnessScore: 0.22,
        aspectRatioScore: 1,
        recommendation: 'MARGINAL',
        reason: 'Moderate blur or contrast',
      },
      minReadableWidth: 40,
      minQualityScore: 0.45,
    });

    expect(result.backend).toBe('heuristic');
    expect(result.source).toBe('HEURISTIC');
    expect(result.acceptableForOCR).toBe(true);
    expect(result.selectedPreprocessing[0]).toBe('ORIGINAL');
    expect(result.rejectionReasons).toEqual([]);
  });

  it('falls back from WebGPU to WASM and disposes warmup tensors', async () => {
    (globalThis as any).window = {};
    let tensorDisposed = 0;
    let outputDisposed = 0;
    const createCalls: string[][] = [];
    const session = {
      inputNames: ['images'],
      outputNames: ['output'],
      run: vi.fn(async () => ({
        output: {
          data: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          dispose: () => { outputDisposed++; },
        },
      })),
    };
    const fakeOrt = {
      env: { wasm: {} },
      Tensor: class {
        dispose(): void {
          tensorDisposed++;
        }
      },
      InferenceSession: {
        create: vi.fn(async (_bytes: Uint8Array, options: { executionProviders: string[] }) => {
          createCalls.push(options.executionProviders);
          if (options.executionProviders.includes('webgpu')) {
            throw new Error('webgpu unavailable');
          }
          return session;
        }),
      },
    };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('.json')) {
        return {
          ok: true,
          json: async () => DEFAULT_PLATE_QUALITY_METADATA,
        } as Response;
      }
      return {
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      } as Response;
    }) as any;
    const service = new PlateQualityService({
      fetchFn,
      getOrtFn: async () => fakeOrt as never,
      canUseWebGpuFn: () => true,
    });

    await expect(service.init()).resolves.toBe(true);
    expect(createCalls).toEqual([['webgpu'], ['wasm']]);
    expect(service.getBackend()).toBe('wasm');
    expect(tensorDisposed).toBe(1);
    expect(outputDisposed).toBe(1);
  });

  it('exports the dataset structure for plate-quality training only', () => {
    const schema = createPlateQualityDatasetSchema();

    expect(schema.task).toBe('plate-quality-assessment');
    expect(schema.classes).toContain('GOOD');
    expect(schema.classes).toContain('BAD_ANGLE');
    expect(schema.classes).not.toContain('RAIN');
    expect(schema.modelPath).toBe('public/models/plate-quality-classifier.onnx');
  });
});

function goodMeasurements() {
  return {
    detectorConfidence: 0.9,
    cropWidth: 180,
    cropHeight: 52,
    aspectRatio: 180 / 52,
    sharpnessScore: 0.8,
    contrastScore: 0.72,
    brightnessScore: 0.76,
    clippingPercentage: 0.01,
    darkPixelRatio: 0.08,
    brightPixelRatio: 0.12,
    edgeDensity: 0.18,
    whitePlateLikelihood: 0.12,
    perspectiveScore: 0.92,
    occlusionEstimate: 0.05,
    trackStability: 0.88,
    cropAgeScore: 0.92,
    aspectRatioScore: 1,
    motionBlurScore: 0.05,
  };
}

function zeroProbabilities(): Record<string, number> {
  return {
    GOOD: 0,
    STANDARD_RECTANGLE: 0,
    SQUARE_PLATE: 0,
    TWO_LINE_PLATE: 0,
    EV_WHITE_PLATE: 0,
    SLIGHT_ROTATION: 0,
    PERSPECTIVE_DISTORTION: 0,
    MOTION_BLUR: 0,
    OUT_OF_FOCUS: 0,
    TOO_SMALL: 0,
    LOW_CONTRAST: 0,
    OVEREXPOSED: 0,
    UNDEREXPOSED: 0,
    GLARE_REFLECTION: 0,
    OCCLUDED: 0,
    BAD_ANGLE: 0,
  };
}

function createFakeCanvas(width: number, height: number, luma: (x: number, y: number) => number): FakeCanvas {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const value = luma(x, y);
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }

  return {
    width,
    height,
    __data: data,
    getContext: () => ({
      getImageData: () => ({ data, width, height }),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      putImageData: vi.fn(),
      fillStyle: '',
    }),
  } as unknown as FakeCanvas;
}

function createReusableCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const target = createFakeCanvas(width, height, (x, y) => (x + y) * 12);
  const ctx = {
    getImageData: () => ({ data: target.__data, width, height }),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D;

  return { canvas: target, ctx };
}
