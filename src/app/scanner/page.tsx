'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '@/context/LanguageContext';
import { useStorage } from '@/context/StorageContext';
import { useAuth } from '@/context/AuthContext';
import { cleanPlateNumber, formatMYR } from '@/lib/utils';
import { DetectionLog, Vehicle } from '@/types';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BookmarkCheck,
  Brain,
  Camera,
  CheckCircle2,
  Download,
  MapPin,
  Play,
  Plus,
  RefreshCw,
  ShieldAlert,
  SwitchCamera,
  Video,
  Volume2,
  VolumeX,
  X,
  XCircle,
} from 'lucide-react';
import { PlateTracker, ActiveTrack } from '@/lib/anpr/tracker';
import {
  detectMalaysianPlates,
  validateDetector,
  getActiveDetectorProvider,
  ActiveExecutionProvider,
} from '@/lib/anpr/yoloDetector';
import {
  generateAdaptiveCrops,
  createInnerPlateTextCrop,
  cropDeskewedCanvasRegionFast,
  cropCanvasRegionFast,
  prioritiseTracks,
  releaseCanvasMemory,
  scaleBoundingBox,
} from '@/lib/anpr/imageProcessor';
import { BestFrameSelector } from '@/lib/anpr/bestFrameSelector';
import { recognizePlateFromCanvas } from '@/lib/anpr/ocrEngine';
import { addOcrVoteToTrack, evaluateConsensus, promoteCorrectedOcrVote } from '@/lib/anpr/consensus';
import { isRepeatedCharacterOmission } from '@/lib/anpr/normaliser';
import {
  initializeANPRRuntime,
  getANPRRuntimeState,
  getLatestBenchmarkResult,
  getRuntimeErrorMessage,
  ANPRRuntimeState,
  AdmissionBenchmarkResult,
} from '@/lib/anpr/runtimeManager';
import { getActivePpOcrProvider, isPpOcrReady, ActiveOcrProvider } from '@/lib/anpr/ppOcrEngine';
import { validateMalaysianPattern } from '@/lib/anpr/patterns';
import { evaluateDatabaseMatch } from '@/lib/anpr/matchingEngine';
import { INITIAL_SETTINGS } from '@/lib/db/settingsDefaults';
import { ScannerSettings, VehicleCase } from '@/lib/db/types';
import { ModelStatusBanner } from '@/components/scanner/ModelStatusBanner';
import {
  AdaptiveScannerConfig,
  createAdaptiveScannerConfig,
  createDefaultEnvironmentProfile,
  createEmptyDistribution,
  ENVIRONMENT_CLASSES,
  EnvironmentClass,
  EnvironmentProfile,
  getDistributionPercentages,
  incrementDistribution,
  isEnvironmentProfileActionable,
  PLATE_QUALITY_CLASSES,
  PlateQualityClass,
} from '@/lib/anpr/adaptiveConfig';
import {
  classifyEnvironment,
  FrameImageStats,
  getEnvironmentModelStatus,
} from '@/lib/anpr/environmentIntelligence';
import {
  classifyPlateQuality,
  createPlateQualityDatasetSchema,
  getPlateQualityBackend,
  getPlateQualityEngineLabel,
  getPlateQualityModelStatus,
  PlateQualityAssessment,
  recoverCorrectablePlateCrop,
} from '@/lib/anpr/plateQualityModel';
import {
  CameraHealthSnapshot,
  CameraRuntimeMetadata,
  DesktopCameraDevice,
  createCameraHealthSnapshot,
  enumerateDesktopCameras,
  getCameraRuntimeMetadata,
  getRememberedCameraId,
  openDesktopCameraStream,
  rememberSelectedCamera,
  selectPreferredCamera,
  streamNeedsReconnect,
} from '@/lib/anpr/cameraManager';

type AlertMatch = {
  vehicle: Vehicle;
  cameraName: string;
  cameraId: string;
};

type CameraSlot = {
  id: string;
  deviceId: string;
};

type ScanLocation = {
  name: string;
  gps: string;
};

type SessionDetection = DetectionLog &
  ScanLocation & {
    matchType?: 'EXACT' | 'POSSIBLE' | 'NONE';
    possibleVehicleIds?: string[];
  };

type SeenPlateItem = {
  id: string;
  plate: string;
  tone: SeenPlateTone;
  confidence: number;
  cameraName: string;
  timestamp: string;
  detail: string;
  searchHref: string;
  active: boolean;
};

type AudioWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

type SlotScannerRuntime = {
  tracker: PlateTracker;
  bestFrameSelector: BestFrameSelector;
  processingCanvas: HTMLCanvasElement | null;
  lastMaintenanceTs: number;
};

type SlotMetrics = {
  camFrames: number;
  detFrames: number;
  platesVisible: number;
  activeTracks: number;
  tracks: ActiveTrack[];
};

type DeviceTier = 'A' | 'B' | 'C' | 'D';

type MotionBucket = 'NORMAL' | 'UNSTABLE' | 'COLLECT_ONLY' | 'PAUSED';

type PerformanceMode = 'DESKTOP_STANDARD' | 'ADAPTIVE' | 'RECOVERY' | 'SURVIVAL';

type SeenPlateTone = 'EXACT' | 'POSSIBLE' | 'NONE' | 'CHECKING' | 'READING';

type ScannerReloadTriggerCode =
  | 'SCHEDULED_REFRESH'
  | 'STREAM_RECONNECT'
  | 'CAMERA_FPS_DROP'
  | 'DETECTOR_SLOWDOWN'
  | 'OCR_QUEUE_BACKLOG'
  | 'MEMORY_GROWTH';

type ScannerReloadTrigger = {
  code: ScannerReloadTriggerCode;
  message: string;
  confirmationMs: number;
};

type ScannerNoticeMode = 'STARTING' | 'RELOADING';

type ScannerReloadNotice = {
  isReloading: boolean;
  reason: string;
  startedAt: number;
  completedAt?: number;
  count: number;
  mode: ScannerNoticeMode;
};

type CameraStopOptions = {
  preserveScanningState?: boolean;
  invalidatePendingStarts?: boolean;
};

type MobileFacingMode = 'user' | 'environment';

type ScannerRuntimeMetrics = {
  sessionStartedAt: number;
  detectorLatencyTotalMs: number;
  detectorLatencySamples: number;
  detectorLatencyHistoryMs: number[];
  ocrLatencyTotalMs: number;
  ocrLatencySamples: number;
  ocrLatencyHistoryMs: number[];
  trackLifetimeTotalMs: number;
  completedTrackCount: number;
  lostTrackObservations: number;
  reacquiredTrackCount: number;
  duplicateOcrSkippedCount: number;
  ocrAttemptCount: number;
  ocrAcceptedCount: number;
  ocrSkippedQueuePressureCount: number;
  consensusAttemptCount: number;
  falseAlertCount: number;
  droppedFrameCount: number;
  cropQualityTotal: number;
  cropQualitySamples: number;
  lastOcrQueueDepth: number;
  maxOcrQueueDepth: number;
  motionBuckets: Record<MotionBucket, number>;
  baseDeviceTier: DeviceTier;
  deviceTier: DeviceTier;
  adaptationLevel: number;
  performanceMode: PerformanceMode;
  performanceModeReason: string;
  executionMode: string;
  cameraProfile: string;
  processingProfile: string;
  ocrProfile: string;
  currentEnvironment: EnvironmentClass;
  currentEnvironmentConfidence: number;
  currentEnvironmentSource: EnvironmentProfile['source'];
  currentQuality: PlateQualityClass;
  currentQualityConfidence: number;
  currentQualityBackend: PlateQualityAssessment['backend'];
  environmentDistribution: Record<EnvironmentClass, number>;
  qualityDistribution: Record<PlateQualityClass, number>;
  qualityLatencyTotalMs: number;
  qualityLatencySamples: number;
  qualityLatencyHistoryMs: number[];
  qualityAcceptedCropCount: number;
  qualityRejectedCropCount: number;
  qualityOcrAvoidedCount: number;
  qualityCorrectableRecoveredCount: number;
  bestFrameReplacementCount: number;
  tracksWaitingForBetterCrop: number;
  heuristicQualityUsageCount: number;
  onnxQualityUsageCount: number;
  qualityRejectionReasons: Record<string, number>;
  environmentStats: Record<
    EnvironmentClass,
    {
      frames: number;
      detectorLatencyTotalMs: number;
      detectorLatencySamples: number;
      ocrLatencyTotalMs: number;
      ocrLatencySamples: number;
      cropQualityTotal: number;
      cropQualitySamples: number;
    }
  >;
  cameraHealth: CameraHealthSnapshot;
  memoryBaselineMb?: number;
  memoryCurrentMb?: number;
};

type ScannerMetricsSnapshot = ScannerRuntimeMetrics & {
  detectorLatencyAvgMs: number;
  detectorLatencyMedianMs: number;
  detectorLatencyP95Ms: number;
  ocrLatencyAvgMs: number;
  ocrLatencyMedianMs: number;
  ocrLatencyP95Ms: number;
  trackLifetimeAvgMs: number;
  cropQualityAvg: number;
  qualityLatencyAvgMs: number;
  qualityLatencyP95Ms: number;
  trackLossRate: number;
  duplicateOcrRate: number;
  averageTrackConfidence: number;
  memoryGrowthPercent?: number;
};

type CompletedTrackEvent = {
  id: string;
  trackId: string;
  cameraId: string;
  cameraName: string;
  plate: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  detectorConfidence: number;
  detectorLatencyMs: number;
  trackConfidence: number;
  confidenceComponents?: ActiveTrack['confidenceComponents'];
  ocrConfidence: number;
  ocrLatencyMs: number;
  consensusCount: number;
  matchType: 'EXACT' | 'POSSIBLE' | 'NONE';
  motionLevel: MotionBucket;
  cropQuality: number;
  processingTimeMs: number;
  reasonForCompletion: string;
  deviceTier: DeviceTier;
  environment: EnvironmentClass;
  environmentConfidence: number;
  qualityClass: PlateQualityClass;
  qualityConfidence: number;
};

type DatasetSample = {
  id: string;
  timestamp: string;
  folderPath: string;
  originalImageDataUrl: string;
  plateCropDataUrl: string;
  environmentClass: EnvironmentClass;
  environmentConfidence: number;
  qualityClass: PlateQualityClass;
  qualityConfidence: number;
  qualityScore: number;
  qualityBackend: PlateQualityAssessment['backend'];
  qualityRejectionReasons: string[];
  selectedPreprocessing: string[];
  ocrResult: string;
  ocrConfidence: number;
  detectorConfidence: number;
  trackConfidence: number;
  camera: CameraRuntimeMetadata | null;
};

type HealthStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';

type HealthComponent = {
  label: string;
  status: HealthStatus;
  score: number;
  detail: string;
};

type SystemHealthSnapshot = {
  overallScore: number;
  components: HealthComponent[];
};

type ScannerPerformanceTargets = {
  detectorMedianLatencyMs: number;
  detectorP95LatencyMs: number;
  ocrMedianLatencyMs: number;
  ocrP95LatencyMs: number;
  trackLossRate: number;
  duplicateOcrRate: number;
  falseExactMatches: number;
  sustainedDetectorFps: number;
  maxOcrQueueDepth: number;
  minAverageTrackConfidence: number;
  memoryGrowthPercent: number;
};

const SCANNER_PERFORMANCE_TARGETS: ScannerPerformanceTargets = {
  detectorMedianLatencyMs: 80,
  detectorP95LatencyMs: 250,
  ocrMedianLatencyMs: 150,
  ocrP95LatencyMs: 500,
  trackLossRate: 0.05,
  duplicateOcrRate: 0.01,
  falseExactMatches: 0,
  sustainedDetectorFps: 5,
  maxOcrQueueDepth: 6,
  minAverageTrackConfidence: 0.75,
  memoryGrowthPercent: 10,
};

const LATENCY_HISTORY_LIMIT = 300;

function pushBoundedMetricSample(samples: number[], value: number, limit = LATENCY_HISTORY_LIMIT): void {
  samples.push(Math.round(value));
  if (samples.length > limit) {
    samples.splice(0, samples.length - limit);
  }
}

function getPercentile(samples: number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[idx];
}

function getUsedHeapMb(): number | undefined {
  if (typeof performance === 'undefined') return undefined;
  const maybePerformance = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const bytes = maybePerformance.memory?.usedJSHeapSize;
  return typeof bytes === 'number' ? Math.round((bytes / 1024 / 1024) * 10) / 10 : undefined;
}

function downgradeDeviceTier(tier: DeviceTier, levels: number): DeviceTier {
  const tiers: DeviceTier[] = ['A', 'B', 'C', 'D'];
  const currentIndex = Math.max(0, tiers.indexOf(tier));
  return tiers[Math.min(tiers.length - 1, currentIndex + Math.max(0, levels))];
}

function getPerformanceMode(baseTier: DeviceTier, effectiveTier: DeviceTier, adaptationLevel: number): PerformanceMode {
  if (adaptationLevel >= 3 || effectiveTier === 'D') return 'SURVIVAL';
  if (adaptationLevel > 0 || effectiveTier !== baseTier) return 'ADAPTIVE';
  return 'DESKTOP_STANDARD';
}

function getExecutionModeLabel(): string {
  return 'WebGPU -> WASM';
}

function getCameraProfileValues(
  adaptationLevel = 0,
  mobileOptimized = false
): { width: number; height: number; fps: number } {
  if (mobileOptimized) {
    return { width: 1280, height: 720, fps: 24 };
  }

  if (adaptationLevel >= 3) return { width: 1280, height: 720, fps: 24 };
  if (adaptationLevel >= 2) return { width: 1280, height: 720, fps: 30 };
  if (adaptationLevel >= 1) return { width: 1600, height: 900, fps: 30 };
  return { width: 1920, height: 1080, fps: 30 };
}

function getCameraProfileLabel(tier: DeviceTier, adaptationLevel = 0, mobileOptimized = false): string {
  const { width, height, fps } = getCameraProfileValues(adaptationLevel, mobileOptimized);
  return `${width}x${height} @ ${fps} FPS (${mobileOptimized ? 'Phone Tier' : 'Tier'} ${tier})`;
}

function getProcessingProfileLabel(tier: DeviceTier, adaptationLevel = 0): string {
  const maxLongEdge = getProcessingMaxLongEdge(tier, adaptationLevel);
  return `max ${maxLongEdge}px long edge`;
}

function getOcrProfileLabel(tier: DeviceTier, adaptationLevel = 0): string {
  const variants =
    adaptationLevel >= 2 || tier === 'D'
      ? 1
      : tier === 'A'
      ? 6
      : tier === 'B'
      ? 3
      : 2;
  return `${getTierOcrConcurrencyLimit(tier)} job(s), ${variants} variant(s)`;
}

function applyRuntimePerformanceProfile(
  metrics: ScannerRuntimeMetrics,
  baseTier: DeviceTier,
  adaptationLevel = metrics.adaptationLevel,
  reason = metrics.performanceModeReason
): void {
  const boundedLevel = clampNumber(adaptationLevel, 0, 3);
  const effectiveTier = downgradeDeviceTier(baseTier, boundedLevel);
  const mobileOptimized = isMobileScannerDevice();
  metrics.baseDeviceTier = baseTier;
  metrics.deviceTier = effectiveTier;
  metrics.adaptationLevel = boundedLevel;
  metrics.performanceMode = getPerformanceMode(baseTier, effectiveTier, boundedLevel);
  metrics.performanceModeReason = reason;
  metrics.executionMode = getExecutionModeLabel();
  metrics.cameraProfile = getCameraProfileLabel(effectiveTier, boundedLevel, mobileOptimized);
  metrics.processingProfile = getProcessingProfileLabel(effectiveTier, boundedLevel);
  metrics.ocrProfile = getOcrProfileLabel(effectiveTier, boundedLevel);
}

function createEnvironmentStats(): ScannerRuntimeMetrics['environmentStats'] {
  return ENVIRONMENT_CLASSES.reduce((acc, label) => {
    acc[label] = {
      frames: 0,
      detectorLatencyTotalMs: 0,
      detectorLatencySamples: 0,
      ocrLatencyTotalMs: 0,
      ocrLatencySamples: 0,
      cropQualityTotal: 0,
      cropQualitySamples: 0,
    };
    return acc;
  }, {} as ScannerRuntimeMetrics['environmentStats']);
}

function createInitialCameraHealth(): CameraHealthSnapshot {
  return {
    status: 'UNKNOWN',
    score: 0,
    brightness: 0,
    contrast: 0,
    blurScore: 0,
    droppedFrames: 0,
    fps: 0,
    detail: 'waiting for frame sample',
  };
}

function createInitialRuntimeMetrics(deviceTier: DeviceTier = 'B'): ScannerRuntimeMetrics {
  const memoryBaselineMb = getUsedHeapMb();
  const initialEnvironment = createDefaultEnvironmentProfile();
  const mobileOptimized = isMobileScannerDevice();
  const metrics: ScannerRuntimeMetrics = {
    sessionStartedAt: Date.now(),
    detectorLatencyTotalMs: 0,
    detectorLatencySamples: 0,
    detectorLatencyHistoryMs: [],
    ocrLatencyTotalMs: 0,
    ocrLatencySamples: 0,
    ocrLatencyHistoryMs: [],
    trackLifetimeTotalMs: 0,
    completedTrackCount: 0,
    lostTrackObservations: 0,
    reacquiredTrackCount: 0,
    duplicateOcrSkippedCount: 0,
    ocrAttemptCount: 0,
    ocrAcceptedCount: 0,
    ocrSkippedQueuePressureCount: 0,
    consensusAttemptCount: 0,
    falseAlertCount: 0,
    droppedFrameCount: 0,
    cropQualityTotal: 0,
    cropQualitySamples: 0,
    lastOcrQueueDepth: 0,
    maxOcrQueueDepth: 0,
    motionBuckets: {
      NORMAL: 0,
      UNSTABLE: 0,
      COLLECT_ONLY: 0,
      PAUSED: 0,
    },
    baseDeviceTier: deviceTier,
    deviceTier,
    adaptationLevel: 0,
    performanceMode: getPerformanceMode(deviceTier, deviceTier, 0),
    performanceModeReason: 'Desktop baseline profile',
    executionMode: getExecutionModeLabel(),
    cameraProfile: getCameraProfileLabel(deviceTier, 0, mobileOptimized),
    processingProfile: getProcessingProfileLabel(deviceTier, 0),
    ocrProfile: getOcrProfileLabel(deviceTier, 0),
    currentEnvironment: initialEnvironment.label,
    currentEnvironmentConfidence: initialEnvironment.confidence,
    currentEnvironmentSource: initialEnvironment.source,
    currentQuality: 'GOOD',
    currentQualityConfidence: 0,
    currentQualityBackend: 'heuristic',
    environmentDistribution: createEmptyDistribution(ENVIRONMENT_CLASSES),
    qualityDistribution: createEmptyDistribution(PLATE_QUALITY_CLASSES),
    qualityLatencyTotalMs: 0,
    qualityLatencySamples: 0,
    qualityLatencyHistoryMs: [],
    qualityAcceptedCropCount: 0,
    qualityRejectedCropCount: 0,
    qualityOcrAvoidedCount: 0,
    qualityCorrectableRecoveredCount: 0,
    bestFrameReplacementCount: 0,
    tracksWaitingForBetterCrop: 0,
    heuristicQualityUsageCount: 0,
    onnxQualityUsageCount: 0,
    qualityRejectionReasons: {},
    environmentStats: createEnvironmentStats(),
    cameraHealth: createInitialCameraHealth(),
    memoryBaselineMb,
    memoryCurrentMb: memoryBaselineMb,
  };

  applyRuntimePerformanceProfile(metrics, deviceTier, 0, metrics.performanceModeReason);
  return metrics;
}

function createMetricsSnapshot(
  metrics: ScannerRuntimeMetrics,
  tracks: ActiveTrack[]
): ScannerMetricsSnapshot {
  const lostAndVisible = metrics.lostTrackObservations + tracks.length;
  const averageTrackConfidence =
    tracks.length > 0
      ? tracks.reduce((sum, track) => sum + (track.trackConfidence ?? 0), 0) / tracks.length
      : 0;
  const duplicateOcrRate =
    metrics.ocrAttemptCount > 0 ? metrics.duplicateOcrSkippedCount / metrics.ocrAttemptCount : 0;
  const memoryCurrentMb = metrics.memoryCurrentMb ?? getUsedHeapMb();
  const memoryGrowthPercent =
    metrics.memoryBaselineMb && memoryCurrentMb
      ? ((memoryCurrentMb - metrics.memoryBaselineMb) / metrics.memoryBaselineMb) * 100
      : undefined;

  return {
    ...metrics,
    detectorLatencyAvgMs:
      metrics.detectorLatencySamples > 0 ? metrics.detectorLatencyTotalMs / metrics.detectorLatencySamples : 0,
    detectorLatencyMedianMs: getPercentile(metrics.detectorLatencyHistoryMs, 50),
    detectorLatencyP95Ms: getPercentile(metrics.detectorLatencyHistoryMs, 95),
    ocrLatencyAvgMs: metrics.ocrLatencySamples > 0 ? metrics.ocrLatencyTotalMs / metrics.ocrLatencySamples : 0,
    ocrLatencyMedianMs: getPercentile(metrics.ocrLatencyHistoryMs, 50),
    ocrLatencyP95Ms: getPercentile(metrics.ocrLatencyHistoryMs, 95),
    trackLifetimeAvgMs:
      metrics.completedTrackCount > 0 ? metrics.trackLifetimeTotalMs / metrics.completedTrackCount : 0,
    cropQualityAvg:
      metrics.cropQualitySamples > 0 ? metrics.cropQualityTotal / metrics.cropQualitySamples : 0,
    qualityLatencyAvgMs:
      metrics.qualityLatencySamples > 0 ? metrics.qualityLatencyTotalMs / metrics.qualityLatencySamples : 0,
    qualityLatencyP95Ms: getPercentile(metrics.qualityLatencyHistoryMs, 95),
    trackLossRate:
      lostAndVisible > 0 ? metrics.lostTrackObservations / lostAndVisible : 0,
    duplicateOcrRate,
    averageTrackConfidence,
    memoryCurrentMb,
    memoryGrowthPercent,
  };
}

function scoreTarget(value: number, target: number, higherIsBetter = false): number {
  if (target <= 0) return value <= target ? 100 : 0;
  if (higherIsBetter) {
    return Math.round(Math.min(1, value / target) * 100);
  }
  return Math.round(Math.min(1, target / Math.max(value, 1)) * 100);
}

function scoreCeilingTarget(value: number, target: number): number {
  if (value <= target) return 100;
  if (target <= 0) return 0;
  return Math.round(Math.max(0, 100 - ((value - target) / target) * 100));
}

function statusFromScore(score: number): HealthStatus {
  if (score >= 90) return 'OK';
  if (score >= 65) return 'WARN';
  return 'FAIL';
}

function createHealthComponent(
  label: string,
  score: number,
  detail: string,
  status?: HealthStatus
): HealthComponent {
  return {
    label,
    score,
    detail,
    status: status ?? statusFromScore(score),
  };
}

function createSystemHealthSnapshot(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number
): SystemHealthSnapshot {
  const targets = SCANNER_PERFORMANCE_TARGETS;
  const detectorLatencyScore = scoreTarget(snapshot.detectorLatencyP95Ms || snapshot.detectorLatencyAvgMs, targets.detectorP95LatencyMs);
  const detectorFpsScore = scoreTarget(detectorFps, targets.sustainedDetectorFps, true);
  const detectorScore = Math.round((detectorLatencyScore * 0.65) + (detectorFpsScore * 0.35));

  const ocrLatencyScore = snapshot.ocrLatencySamples > 0
    ? scoreTarget(snapshot.ocrLatencyP95Ms || snapshot.ocrLatencyAvgMs, targets.ocrP95LatencyMs)
    : 100;
  const duplicateScore = scoreCeilingTarget(snapshot.duplicateOcrRate, targets.duplicateOcrRate);
  const ocrScore = Math.round(ocrLatencyScore * 0.75 + duplicateScore * 0.25);

  const trackingLossScore = scoreCeilingTarget(snapshot.trackLossRate, targets.trackLossRate);
  const confidenceScore = scoreTarget(snapshot.averageTrackConfidence, targets.minAverageTrackConfidence, true);
  const trackingScore = Math.round(trackingLossScore * 0.55 + confidenceScore * 0.45);

  const queueScore = scoreCeilingTarget(snapshot.lastOcrQueueDepth, targets.maxOcrQueueDepth);
  const cameraScore = snapshot.cameraHealth.status === 'UNKNOWN'
    ? cameraFps > 0 ? Math.min(100, Math.round((cameraFps / 24) * 100)) : 0
    : snapshot.cameraHealth.score;
  const falseAlertScore = snapshot.falseAlertCount <= targets.falseExactMatches ? 100 : 0;
  const memoryScore =
    typeof snapshot.memoryGrowthPercent === 'number'
      ? scoreCeilingTarget(snapshot.memoryGrowthPercent, targets.memoryGrowthPercent)
      : 100;

  const components = [
    createHealthComponent('Detector', detectorScore, `${detectorFps.toFixed(0)} FPS · P95 ${snapshot.detectorLatencyP95Ms.toFixed(0)} ms`),
    createHealthComponent('OCR', ocrScore, `P95 ${snapshot.ocrLatencyP95Ms.toFixed(0)} ms · dup ${(snapshot.duplicateOcrRate * 100).toFixed(1)}%`),
    createHealthComponent('Tracking', trackingScore, `loss ${(snapshot.trackLossRate * 100).toFixed(1)}% · conf ${Math.round(snapshot.averageTrackConfidence * 100)}%`),
    createHealthComponent('Queue', queueScore, `depth ${snapshot.lastOcrQueueDepth} · max ${snapshot.maxOcrQueueDepth}`),
    createHealthComponent(
      'Memory',
      memoryScore,
      typeof snapshot.memoryGrowthPercent === 'number'
        ? `${snapshot.memoryCurrentMb?.toFixed(1) ?? '0.0'} MB · ${snapshot.memoryGrowthPercent.toFixed(1)}%`
        : 'heap unavailable',
      typeof snapshot.memoryGrowthPercent === 'number' ? undefined : 'UNKNOWN'
    ),
    createHealthComponent(
      'Camera',
      cameraScore,
      snapshot.cameraHealth.status === 'UNKNOWN' ? `${cameraFps.toFixed(0)} FPS` : snapshot.cameraHealth.detail,
      snapshot.cameraHealth.status === 'UNKNOWN' ? undefined : snapshot.cameraHealth.status
    ),
    createHealthComponent('Alerts', falseAlertScore, `${snapshot.falseAlertCount} false exact`, falseAlertScore === 100 ? 'OK' : 'FAIL'),
  ];

  const knownComponents = components.filter((component) => component.status !== 'UNKNOWN');
  const overallScore = Math.round(
    knownComponents.reduce((sum, component) => sum + component.score, 0) / Math.max(1, knownComponents.length)
  );

  return { overallScore, components };
}

function getSampleAverage(samples: number[], count: number, offsetFromEnd = 0): number {
  const end = Math.max(0, samples.length - offsetFromEnd);
  const start = Math.max(0, end - count);
  const slice = samples.slice(start, end);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

function getRuntimeAdaptationReason(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number
): string | null {
  const detectorTargetMs = getTierDetectorTargetMs(snapshot.deviceTier);
  const recentDetectorAvg = getSampleAverage(snapshot.detectorLatencyHistoryMs, 12);
  const previousDetectorAvg = getSampleAverage(snapshot.detectorLatencyHistoryMs, 12, 12);
  const recentOcrAvg = getSampleAverage(snapshot.ocrLatencyHistoryMs, 8);
  const detectorHasSamples = snapshot.detectorLatencySamples >= 8;
  const ocrHasSamples = snapshot.ocrLatencySamples >= 4;

  if (
    detectorHasSamples &&
    snapshot.detectorLatencyP95Ms > Math.max(SCANNER_PERFORMANCE_TARGETS.detectorP95LatencyMs, detectorTargetMs * 2.2)
  ) {
    return `Detector P95 ${snapshot.detectorLatencyP95Ms.toFixed(0)} ms exceeded Tier ${snapshot.deviceTier} target`;
  }

  if (detectorHasSamples && recentDetectorAvg > detectorTargetMs * 1.8) {
    return `Detector average ${recentDetectorAvg.toFixed(0)} ms is too slow`;
  }

  if (
    snapshot.detectorLatencySamples >= 30 &&
    previousDetectorAvg > 0 &&
    recentDetectorAvg > previousDetectorAvg * 1.35 &&
    recentDetectorAvg > detectorTargetMs * 1.25
  ) {
    return 'Thermal slowdown trend detected';
  }

  if (ocrHasSamples && snapshot.ocrLatencyP95Ms > Math.max(SCANNER_PERFORMANCE_TARGETS.ocrP95LatencyMs, 900)) {
    return `OCR P95 ${snapshot.ocrLatencyP95Ms.toFixed(0)} ms is too slow`;
  }

  if (ocrHasSamples && recentOcrAvg > 700 && snapshot.lastOcrQueueDepth >= 3) {
    return 'OCR queue is backing up';
  }

  if (cameraFps > 0 && cameraFps < 8 && detectorFps < Math.max(2, SCANNER_PERFORMANCE_TARGETS.sustainedDetectorFps * 0.5)) {
    return 'Camera frame rate dropped under load';
  }

  return null;
}

function canRecoverRuntimeProfile(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number
): boolean {
  const detectorTargetMs = getTierDetectorTargetMs(snapshot.deviceTier);
  const recentDetectorAvg = getSampleAverage(snapshot.detectorLatencyHistoryMs, 10);
  const detectorHealthy =
    snapshot.detectorLatencySamples < 8 ||
    (recentDetectorAvg > 0 && recentDetectorAvg < detectorTargetMs * 1.5);
  const cameraHealthy = cameraFps === 0 || cameraFps >= 8;

  return detectorHealthy && cameraHealthy;
}

function classifyDeviceTier(
  benchmark: AdmissionBenchmarkResult | null,
  runtimeState: ANPRRuntimeState
): DeviceTier {
  if (benchmark) {
    if (benchmark.estimatedFps >= 9) return 'A';
    if (benchmark.estimatedFps >= 6.5) return 'B';
    if (benchmark.estimatedFps >= 4) return 'C';
    return 'D';
  }

  if (runtimeState === 'READY_WEBGPU') return 'A';
  if (runtimeState === 'READY_WASM') return 'B';
  if (runtimeState === 'DEGRADED_PERFORMANCE') return 'C';
  return 'D';
}

function getTierDetectorTargetMs(tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return 90;
    case 'B':
      return 160;
    case 'C':
      return 280;
    case 'D':
      return 480;
    default:
      return DETECTION_TARGET_INTERVAL_MS;
  }
}

function getTierDetectorBusyIntervalMs(tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return DETECTION_BUSY_INTERVAL_MS;
    case 'B':
      return 240;
    case 'C':
      return 420;
    case 'D':
      return 700;
    default:
      return DETECTION_BUSY_INTERVAL_MS;
  }
}

function getTierOcrConcurrencyLimit(tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return 3;
    case 'B':
    case 'C':
      return 2;
    default:
      return 1;
  }
}

function isSupportedDesktopScannerBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const isChromeOrEdge = /Chrome|Chromium|Edg/i.test(userAgent) && !/OPR|Firefox|Safari\/.*Version/i.test(userAgent);
  const platform = navigator.platform || '';
  const isDesktopPlatform = /Mac|Win|Linux x86_64|Linux armv8l/i.test(platform);

  return isChromeOrEdge && isDesktopPlatform;
}

function getCameraPerformanceConstraints(
  adaptationLevel = 0,
  mobileOptimized = isMobileScannerDevice()
): MediaTrackConstraints {
  const { width, height, fps } = getCameraProfileValues(adaptationLevel, mobileOptimized);

  return {
    width: { ideal: width },
    height: { ideal: height },
    frameRate: { ideal: fps, max: 30 },
  };
}

function getActiveCameraCaptureConfig(
  cameraConfig: AdaptiveScannerConfig['camera'],
  adaptationLevel = 0
): AdaptiveScannerConfig['camera'] {
  if (!isMobileScannerDevice()) return cameraConfig;

  const profile = getCameraProfileValues(adaptationLevel, true);
  const fallbackWidth = adaptationLevel >= 2 ? 854 : 960;
  const fallbackHeight = adaptationLevel >= 2 ? 480 : 540;

  return {
    idealWidth: Math.min(cameraConfig.idealWidth, profile.width),
    idealHeight: Math.min(cameraConfig.idealHeight, profile.height),
    idealFps: Math.min(cameraConfig.idealFps, profile.fps),
    fallbackWidth: Math.min(cameraConfig.fallbackWidth, fallbackWidth),
    fallbackHeight: Math.min(cameraConfig.fallbackHeight, fallbackHeight),
  };
}

function getProcessingMaxLongEdge(tier: DeviceTier, adaptationLevel = 0, adaptiveMaxLongEdge?: number): number {
  if (adaptiveMaxLongEdge) return Math.max(720, adaptiveMaxLongEdge);
  if (adaptationLevel >= 3) return 720;
  if (adaptationLevel >= 2) return 800;
  if (adaptationLevel >= 1) return 960;

  if (tier === 'A') return 1600;
  if (tier === 'B') return 1280;
  if (tier === 'C') return 960;
  return 720;
}

function getProcessingDimensions(
  videoWidth: number,
  videoHeight: number,
  tier: DeviceTier,
  adaptationLevel = 0,
  adaptiveMaxLongEdge?: number
): { width: number; height: number } {
  if (videoWidth <= 0 || videoHeight <= 0) return { width: 0, height: 0 };

  const maxLongEdge = getProcessingMaxLongEdge(tier, adaptationLevel, adaptiveMaxLongEdge);
  const longEdge = Math.max(videoWidth, videoHeight);
  const scale = Math.min(1, maxLongEdge / longEdge);

  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale)),
  };
}

function getTierCropSampleIntervalMs(baseIntervalMs: number, tier: DeviceTier): number {
  switch (tier) {
    case 'A':
      return baseIntervalMs;
    case 'B':
      return Math.round(baseIntervalMs * 1.35);
    case 'C':
      return Math.round(baseIntervalMs * 1.9);
    case 'D':
      return Math.round(baseIntervalMs * 2.8);
    default:
      return baseIntervalMs;
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function getScannerCameraSettleMs(mode: ScannerNoticeMode): number {
  if (isMobileScannerDevice()) {
    return mode === 'RELOADING'
      ? MOBILE_SCANNER_CAMERA_RELOAD_SETTLE_MS
      : MOBILE_SCANNER_CAMERA_STARTUP_SETTLE_MS;
  }

  return mode === 'RELOADING' ? SCANNER_CAMERA_RELOAD_SETTLE_MS : SCANNER_CAMERA_STARTUP_SETTLE_MS;
}

function downloadJson(filename: string, payload: unknown): void {
  if (typeof document === 'undefined') return;

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function addEnvironmentDetectorSample(
  metrics: ScannerRuntimeMetrics,
  environment: EnvironmentClass,
  latencyMs: number
): void {
  const stats = metrics.environmentStats[environment];
  if (!stats) return;
  stats.frames++;
  stats.detectorLatencyTotalMs += latencyMs;
  stats.detectorLatencySamples++;
}

function addEnvironmentOcrSample(
  metrics: ScannerRuntimeMetrics,
  environment: EnvironmentClass,
  latencyMs: number,
  cropQuality: number
): void {
  const stats = metrics.environmentStats[environment];
  if (!stats) return;
  stats.ocrLatencyTotalMs += latencyMs;
  stats.ocrLatencySamples++;
  stats.cropQualityTotal += cropQuality;
  stats.cropQualitySamples++;
}

function addQualityAssessmentSample(metrics: ScannerRuntimeMetrics, assessment: PlateQualityAssessment): void {
  metrics.currentQuality = assessment.primaryClass;
  metrics.currentQualityConfidence = assessment.confidence;
  metrics.currentQualityBackend = assessment.backend;
  metrics.qualityDistribution = incrementDistribution(metrics.qualityDistribution, assessment.primaryClass);
  metrics.qualityLatencyTotalMs += assessment.latencyMs;
  metrics.qualityLatencySamples++;
  pushBoundedMetricSample(metrics.qualityLatencyHistoryMs, assessment.latencyMs);

  if (assessment.backend === 'heuristic') {
    metrics.heuristicQualityUsageCount++;
  } else {
    metrics.onnxQualityUsageCount++;
  }

  if (assessment.acceptableForOCR) {
    metrics.qualityAcceptedCropCount++;
  } else {
    metrics.qualityRejectedCropCount++;
    assessment.rejectionReasons.forEach((reason) => {
      metrics.qualityRejectionReasons[reason] = (metrics.qualityRejectionReasons[reason] ?? 0) + 1;
    });
  }
}

function attachQualityAssessmentToTrack(
  track: ActiveTrack,
  assessment: PlateQualityAssessment,
  submittedToOcr: boolean
): void {
  track.qualityClass = assessment.primaryClass;
  track.qualityConfidence = assessment.confidence;
  track.qualityScore = assessment.qualityScore;
  track.qualityBackend = assessment.backend;
  track.qualityAcceptedForOcr = assessment.acceptableForOCR;
  track.qualityRejectionReasons = assessment.rejectionReasons;
  track.qualityCropSize = {
    width: assessment.measurements.cropWidth,
    height: assessment.measurements.cropHeight,
  };
  track.qualitySharpness = assessment.measurements.sharpnessScore;
  track.qualitySelectedPreprocessing = assessment.selectedPreprocessing;
  track.qualitySubmittedToOcr = submittedToOcr;

  if (track.stats) {
    track.stats.bestCropQuality = Math.max(track.stats.bestCropQuality ?? 0, assessment.qualityScore);
    track.stats.lastQualityLatencyMs = Math.round(assessment.latencyMs);
  }
}

function serializeDistributionPercentages<T extends string>(distribution: Record<T, number>): Record<T, number> {
  return getDistributionPercentages(distribution);
}

function canvasToJpegDataUrl(canvas: HTMLCanvasElement, quality = 0.82): string {
  try {
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return '';
  }
}

const SCAN_LOCATIONS: ScanLocation[] = [
  { name: 'Sungai Besi Toll Plaza', gps: '3.0602, 101.7047' },
  { name: 'Jalan Tun Razak, Kuala Lumpur', gps: '3.1618, 101.7165' },
  { name: 'Federal Highway KM12', gps: '3.0837, 101.6129' },
  { name: 'Shah Alam Section 13', gps: '3.0831, 101.5443' },
  { name: 'Penang Bridge Checkpoint', gps: '5.3674, 100.3422' },
];

const RECENT_DETECTIONS_STORAGE_KEY = 'track_recent_live_detections';
const DETECTION_TARGET_INTERVAL_MS = 90;
const DETECTION_BUSY_INTERVAL_MS = 125;
const DETECTION_MIN_DELAY_MS = 16;
const DETECTOR_VALIDATION_INTERVAL_MS = 2000;
const CROP_SAMPLE_FAST_MS = 90;
const CROP_SAMPLE_NORMAL_MS = 160;
const OCR_FIRST_READ_RETRY_MS = 80;
const OCR_REPEAT_READ_RETRY_MS = 180;
const OCR_MIN_TRACK_FRAMES = 2;
const OCR_MIN_BUFFERED_CROPS = 1;
const OCR_FIRST_READ_MIN_TRACK_CONFIDENCE = 0.56;
const OCR_MIN_TRACK_CONFIDENCE = 0.70;
const OCR_FAST_FIRST_READ_MIN_DETECTOR_CONFIDENCE = 0.58;
const OCR_DEFAULT_MIN_READABLE_WIDTH = 48;
const OCR_MAX_BEST_CROP_AGE_MS = 1800;
const OCR_FIRST_READ_MIN_QUALITY = 0.24;
const OCR_REPEAT_READ_MIN_QUALITY = 0.20;
const OCR_MAX_CONCURRENCY = 4;
const OCR_RECENT_LOST_RESULT_GRACE_MS = 1800;
const OCR_SINGLE_READ_COMMIT_MIN_CONFIDENCE = 0.45;
const OCR_SINGLE_READ_COMMIT_MIN_SCORE = 0.68;
const OCR_FINAL_LOCK_MIN_CONFIDENCE = 0.95;
const OCR_DB_EXACT_LOCK_MIN_CONFIDENCE = 0.58;
const OCR_DB_POSSIBLE_LOCK_MIN_CONFIDENCE = 0.56;
const OCR_REPEATED_OMISSION_LOCK_MIN_CONFIDENCE = 0.62;
const OCR_NO_MATCH_COMMIT_MIN_CONFIDENCE = 0.50;
const OCR_QUICK_DB_MIN_SCORE = 0.58;
const OCR_QUICK_DB_MIN_CONFIDENCE = 0.26;
const OCR_DESKEW_MIN_ANGLE_RAD = 0.055;
const MOTION_NORMAL_MAX = 0.15;
const MOTION_UNSTABLE_MAX = 0.30;
const MOTION_COLLECT_ONLY_MAX = 0.50;
const OVERLAY_ANGLE_SAMPLE_MS = 140;
const MAX_OVERLAY_TILT_RAD = 0.35;
const SCANNER_MAINTENANCE_INTERVAL_MS = 1000;
const COOLDOWN_MAP_MAX_ENTRIES = 120;
const PERFORMANCE_ADAPTATION_CHECK_MS = 5000;
const PERFORMANCE_ADAPTATION_COOLDOWN_MS = 20000;
const PERFORMANCE_RECOVERY_COOLDOWN_MS = 8000;
const CAMERA_CONSTRAINT_APPLY_COOLDOWN_MS = 10000;
const ENVIRONMENT_SAMPLE_INTERVAL_MS = 1200;
const DATASET_SAMPLE_LIMIT = 20;
const MOBILE_SCANNER_PREVENTIVE_REFRESH_MS = 20 * 60 * 1000;
const MOBILE_SCANNER_RELOAD_MIN_UPTIME_MS = 90 * 1000;
const MOBILE_SCANNER_RELOAD_COOLDOWN_MS = 2 * 60 * 1000;
const MOBILE_SCANNER_RELOAD_NOTICE_MS = 3500;
const MOBILE_SCANNER_ISSUE_CONFIRM_MS = 12 * 1000;
const MOBILE_SCANNER_STREAM_CONFIRM_MS = 2500;
const MOBILE_SCANNER_STREAM_COOLDOWN_MS = 15000;
const MOBILE_SCANNER_LOW_FPS_THRESHOLD = 7;
const MOBILE_SCANNER_MEMORY_GROWTH_PERCENT = 18;
const MOBILE_SCANNER_OCR_QUEUE_DEPTH = 6;
const SCANNER_CAMERA_STARTUP_SETTLE_MS = 900;
const SCANNER_CAMERA_RELOAD_SETTLE_MS = 1200;
const MOBILE_SCANNER_CAMERA_STARTUP_SETTLE_MS = 1800;
const MOBILE_SCANNER_CAMERA_RELOAD_SETTLE_MS = 2200;
const SCANNER_UI_FLUSH_INTERVAL_MS = 500;

type MotionOcrMode = MotionBucket;
type OcrQueuePressure = 'EMPTY' | 'MODERATE' | 'LARGE' | 'CRITICAL';

function getTrackColor(track: ActiveTrack): string {
  if (track.matchType === 'EXACT') return '#ef4444';
  if (track.matchType === 'POSSIBLE') return '#f59e0b';
  if (track.matchType === 'NONE') return '#06b6d4';
  if (track.ocrState === 'COOLDOWN') return '#64748b';
  return '#06b6d4';
}

function getTrackStatusLabel(track: ActiveTrack): string {
  if (track.matchType === 'EXACT') return 'MATCH';
  if (track.matchType === 'POSSIBLE') return 'POSSIBLE';
  if (track.matchType === 'NONE') return 'NO CASE';

  switch (track.ocrState) {
    case 'DETECTED':
      return 'DETECTED';
    case 'COLLECTING':
      return 'COLLECTING';
    case 'OCR_RUNNING':
      return 'READING';
    case 'CONSENSUS_BUILDING':
      return 'ANALYSING';
    case 'DB_CHECKING':
      return 'CHECKING';
    case 'COOLDOWN':
      return 'COOLDOWN';
    default:
      return 'SCANNING';
  }
}

function getTrackSeenPlateTone(track: ActiveTrack): SeenPlateTone {
  if (track.matchType === 'EXACT') return 'EXACT';
  if (track.matchType === 'POSSIBLE') return 'POSSIBLE';
  if (track.matchType === 'NONE') return 'NONE';
  if (track.ocrState === 'DB_CHECKING') return 'CHECKING';
  if (track.ocrState === 'OCR_RUNNING' || track.pipelineState === 'READING') return 'READING';
  if (getTrackVoteCount(track) > 0 || track.stabilizedPlate) return 'CHECKING';
  return 'READING';
}

function getDetectionSeenPlateTone(detection: SessionDetection): SeenPlateTone {
  if (detection.matchType === 'EXACT' || detection.matched) return 'EXACT';
  if (detection.matchType === 'POSSIBLE') return 'POSSIBLE';
  return 'NONE';
}

function getSeenPlateStatusLabel(tone: SeenPlateTone, language: string): string {
  const isBm = language === 'BM';
  if (tone === 'EXACT') return isBm ? 'Padan' : 'Match';
  if (tone === 'POSSIBLE') return isBm ? 'Semak' : 'Review';
  if (tone === 'NONE') return isBm ? 'Tiada' : 'None';
  if (tone === 'CHECKING') return isBm ? 'Semak DB' : 'DB Check';
  return isBm ? 'Membaca' : 'Reading';
}

function getSeenPlateBorderClass(tone: SeenPlateTone): string {
  if (tone === 'EXACT') return 'border-red-800/70 bg-red-950/25';
  if (tone === 'POSSIBLE') return 'border-amber-800/70 bg-amber-950/20';
  if (tone === 'NONE') return 'border-slate-800 bg-slate-900/80';
  if (tone === 'CHECKING') return 'border-cyan-800 bg-cyan-950/25';
  return 'border-slate-800 bg-slate-950/80';
}

function getSeenPlateBadgeClass(tone: SeenPlateTone): string {
  if (tone === 'EXACT') return 'bg-red-600 text-white';
  if (tone === 'POSSIBLE') return 'bg-amber-500 text-slate-950';
  if (tone === 'NONE') return 'bg-slate-800/90 text-slate-300';
  if (tone === 'CHECKING') return 'border border-cyan-700 bg-cyan-950 text-cyan-200';
  return 'border border-slate-700 bg-slate-950 text-slate-300';
}

function getTrackDisplayConfidencePercent(track: ActiveTrack): number {
  if (track.stabilizedConfidence !== undefined) {
    return Math.round(clampNumber(track.stabilizedConfidence, 0, 1) * 100);
  }

  let topAverageConfidence = 0;
  track.votes?.forEach((vote) => {
    if (vote.count > 0) {
      topAverageConfidence = Math.max(topAverageConfidence, vote.totalConfidence / vote.count);
    }
  });

  const confidence = Math.max(
    topAverageConfidence,
    track.qualityScore ?? 0,
    track.trackConfidence ?? 0,
    track.bbox.confidence ?? 0
  );

  return Math.round(clampNumber(confidence, 0, 1) * 100);
}

function getTrackPlateText(track: ActiveTrack): string {
  if (track.stabilizedPlate) return track.stabilizedPlate;
  if (!track.votes || track.votes.size === 0) return '';

  let topPlate = '';
  let topCount = 0;
  let topTotalConfidence = 0;
  track.votes.forEach((data, plateStr) => {
    if (data.count > topCount || (data.count === topCount && data.totalConfidence > topTotalConfidence)) {
      topPlate = plateStr;
      topCount = data.count;
      topTotalConfidence = data.totalConfidence;
    }
  });

  return topPlate;
}

function isRuntimeScanningReady(state: ANPRRuntimeState): boolean {
  return state === 'READY_WEBGPU' || state === 'READY_WASM' || state === 'DEGRADED_PERFORMANCE';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampPercentToThreshold(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clampNumber(value / 100, min, max);
}

function getExpectedMinPlateChars(crop: HTMLCanvasElement): number {
  const aspect = crop.width / Math.max(1, crop.height);
  if (aspect >= 3.0) return 4;
  if (aspect >= 2.3) return 4;
  return 2;
}

function countPlateChars(text: string): { letters: number; digits: number } {
  return {
    letters: (text.match(/[A-Z]/g) || []).length,
    digits: (text.match(/[0-9]/g) || []).length,
  };
}

function isPlausiblePlateCandidate(text: string, expectedMinChars: number, patternScore: number): boolean {
  if (!text || text.length < 2) return false;

  const { letters, digits } = countPlateChars(text);
  if (letters === 0 || digits === 0) return false;

  const pattern = validateMalaysianPattern(text);
  const highValueShortPlate = text.length <= 3 && pattern.isValid && pattern.score >= 0.70;
  if (highValueShortPlate) return true;

  const hasEnoughLength = text.length >= expectedMinChars || (text.length >= 3 && Math.max(patternScore, pattern.score) >= 0.85);
  if (!hasEnoughLength) return false;

  if (text.length >= 5 && digits < 2) return false;
  if (/^([A-Z0-9]{2,4})\1$/.test(text)) return false;

  return true;
}

function canCommitFinalPlateOutcome(text: string, voteCount: number = 1): boolean {
  const pattern = validateMalaysianPattern(text);
  const { letters, digits } = countPlateChars(text);

  if (!pattern.isValid || pattern.score < 0.55) return false;
  if (letters === 0 || digits === 0) return false;
  if (text.length >= 5 && digits < 2) return false;
  if (voteCount < 2 && !isCompleteSingleReadCandidate(text, pattern, voteCount)) return false;

  return true;
}

function canCommitNoMatchOutcome(text: string, confidence: number, score: number, voteCount: number): boolean {
  const pattern = validateMalaysianPattern(text);
  const { letters, digits } = countPlateChars(text);

  // A single fast OCR pass may be useful for alerting an exact DB match, but it
  // must not finalize "no case"; partial reads like AN756 can look valid.
  if (voteCount < 2) return false;
  if (Math.max(confidence, score) < OCR_NO_MATCH_COMMIT_MIN_CONFIDENCE) return false;
  if (text.length < 2 || letters === 0 || digits === 0) return false;
  if (text.length >= 5 && digits < 2) return false;
  if (!canCommitFinalPlateOutcome(text, voteCount)) return false;
  if (!isCompleteNoMatchCandidate(text, pattern, confidence, score, voteCount)) return false;

  return pattern.isValid || pattern.score >= 0.45;
}

function isCompleteNoMatchCandidate(
  text: string,
  pattern: ReturnType<typeof validateMalaysianPattern>,
  confidence: number,
  score: number,
  voteCount: number
): boolean {
  const { letters, digits } = countPlateChars(text);
  const category = pattern.category;

  if (!pattern.isValid || letters === 0 || digits === 0 || text.length < 2) return false;
  if (category === 'UNKNOWN_VALID_CANDIDATE') return false;
  if (text.length <= 3) return pattern.score >= 0.70;
  if (category === 'STANDARD') {
    if (digits >= 3) return true;
    return voteCount >= 3 || Math.max(confidence, score) >= 0.72;
  }
  if (category === 'EV_SPECIAL') return digits >= 3;
  if (category === 'LETTER_NUMBER_SUFFIX') return pattern.hasTrailingSuffix && digits >= 2;
  if (category === 'LANGKAWI' || category === 'SABAH' || category === 'SARAWAK') {
    return pattern.hasTrailingSuffix ? digits >= 2 : digits >= 4;
  }

  return isCompleteSingleReadCandidate(text, pattern, voteCount);
}

function isCompleteSingleReadCandidate(
  text: string,
  pattern: ReturnType<typeof validateMalaysianPattern>,
  voteCount: number = 1
): boolean {
  const { letters, digits } = countPlateChars(text);
  const category = pattern.category;
  const patternId = pattern.pattern?.id ?? '';

  if (letters === 0 || digits === 0) return false;
  if (text.length < 2) return false;
  if (text.length > 10 && pattern.score < 0.80) return false;
  if (text.length <= 3) return pattern.isValid && pattern.score >= 0.70;

  if (category === 'STANDARD') {
    return digits >= 3 || text.length <= 4 || voteCount >= 3;
  }

  if (category === 'LETTER_NUMBER_SUFFIX') {
    return pattern.hasTrailingSuffix && digits >= 2;
  }

  if (category === 'LANGKAWI' || category === 'SABAH' || category === 'SARAWAK') {
    if (pattern.hasTrailingSuffix) return digits >= 2;
    return digits >= 4 || text.length >= 6;
  }

  if (category === 'EV_SPECIAL') {
    return digits >= 3 || text.length <= 4;
  }

  if (category === 'DIPLOMATIC') {
    return text.length >= 5 && digits >= 2;
  }

  if (category === 'GOVERNMENT' || category === 'SPECIAL_SERIES') {
    return digits >= 3 || pattern.score >= 0.82;
  }

  if (patternId === 'GENERIC_MALAYSIAN') return false;

  return true;
}

function canCommitSingleReadOutcome(text: string, confidence: number, score: number): boolean {
  const pattern = validateMalaysianPattern(text);

  if (!pattern.isValid || pattern.score < 0.70) return false;
  if (!isCompleteSingleReadCandidate(text, pattern, 1)) return false;

  return confidence >= OCR_SINGLE_READ_COMMIT_MIN_CONFIDENCE && score >= OCR_SINGLE_READ_COMMIT_MIN_SCORE;
}

function canCommitQuickDatabaseOutcome(text: string, confidence: number, score: number, voteCount: number): boolean {
  const pattern = validateMalaysianPattern(text);
  const { letters, digits } = countPlateChars(text);

  if (text.length < 4 || letters === 0 || digits === 0) return false;
  if (digits < 2 && pattern.score < 0.7) return false;
  if (!pattern.isValid && pattern.score < 0.65) return false;

  if (voteCount >= 2 && Math.max(confidence, score) >= 0.42) return true;

  if (!canCommitSingleReadOutcome(text, confidence, score)) return false;

  return confidence >= OCR_QUICK_DB_MIN_CONFIDENCE && score >= OCR_QUICK_DB_MIN_SCORE;
}

function getDatabaseFinalLockMinConfidence(
  resolvedMatchType: 'EXACT' | 'POSSIBLE' | 'NONE',
  recoveredRepeatedOmission: boolean,
  commitNoCase: boolean,
  recognitionThreshold: number
): number {
  if (recoveredRepeatedOmission) return OCR_REPEATED_OMISSION_LOCK_MIN_CONFIDENCE;
  if (resolvedMatchType === 'EXACT') {
    return Math.max(OCR_DB_EXACT_LOCK_MIN_CONFIDENCE, Math.min(recognitionThreshold, 0.65));
  }
  if (resolvedMatchType === 'POSSIBLE') {
    return Math.max(OCR_DB_POSSIBLE_LOCK_MIN_CONFIDENCE, Math.min(recognitionThreshold, 0.62));
  }
  if (resolvedMatchType === 'NONE' && commitNoCase) {
    return OCR_NO_MATCH_COMMIT_MIN_CONFIDENCE;
  }

  return OCR_FINAL_LOCK_MIN_CONFIDENCE;
}

function getTrackVoteCount(track: ActiveTrack): number {
  return Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0);
}

function isTrackAvailableForReading(track: ActiveTrack): boolean {
  return track.trackState === 'VISIBLE' && track.visibleThisFrame !== false && (track.missedFrames ?? 0) === 0;
}

function isOcrResultStillUseful(track: ActiveTrack, now: number = Date.now()): boolean {
  if (track.trackState === 'REMOVED' || track.cooldownActive) return false;
  if (isTrackAvailableForReading(track)) return true;

  return now - (track.lastSeenTimestamp || 0) <= OCR_RECENT_LOST_RESULT_GRACE_MS;
}

function isTrackDrawable(track: ActiveTrack): boolean {
  if (track.trackState === 'REMOVED') return false;
  return track.trackState === 'VISIBLE' && track.visibleThisFrame !== false;
}

function getMotionOcrMode(track: ActiveTrack): MotionOcrMode {
  const score = track.motionScore ?? 0;
  if (score < MOTION_NORMAL_MAX) return 'NORMAL';
  if (score < MOTION_UNSTABLE_MAX) return 'UNSTABLE';
  if (score < MOTION_COLLECT_ONLY_MAX) return 'COLLECT_ONLY';
  return 'PAUSED';
}

function isFastFirstReadCandidate(track: ActiveTrack, voteCount: number = getTrackVoteCount(track)): boolean {
  if (voteCount > 0 || track.cooldownActive || track.ocrRunning || track.ocrJobQueued) return false;

  return (track.bbox.confidence ?? 0) >= OCR_FAST_FIRST_READ_MIN_DETECTOR_CONFIDENCE;
}

function canAttemptOcrForMotion(track: ActiveTrack, mode: MotionOcrMode): boolean {
  if (isFastFirstReadCandidate(track)) return true;
  if (mode === 'NORMAL') return true;
  if (mode === 'UNSTABLE') return getTrackVoteCount(track) === 0 || track.framesSeen % 2 === 0;
  if (mode === 'COLLECT_ONLY') {
    return getTrackVoteCount(track) === 0 && (track.bbox.confidence >= 0.55 || track.framesSeen >= OCR_MIN_TRACK_FRAMES);
  }
  return getTrackVoteCount(track) === 0 && track.bbox.confidence >= 0.65;
}

function getOcrQueuePressure(
  queueDepth: number,
  activeJobs: number,
  maxConcurrency: number
): OcrQueuePressure {
  if (queueDepth === 0) return 'EMPTY';
  if (activeJobs >= maxConcurrency && queueDepth >= maxConcurrency * 2) return 'CRITICAL';
  if (queueDepth > maxConcurrency * 2) return 'LARGE';
  if (queueDepth > maxConcurrency) return 'MODERATE';
  return 'EMPTY';
}

function shouldSkipTrackForOcrPressure(
  track: ActiveTrack,
  pressure: OcrQueuePressure,
  priorityIndex: number,
  maxConcurrency: number,
  qualityScore: number
): boolean {
  if (pressure === 'EMPTY') return false;
  const voteCount = getTrackVoteCount(track);
  const timeSinceAttempt = track.lastOcrAttemptAt ? Date.now() - track.lastOcrAttemptAt : Number.POSITIVE_INFINITY;
  const needsFirstRead = voteCount === 0;
  const starving = timeSinceAttempt > 1400;

  if (needsFirstRead && qualityScore >= 0.30 && (track.trackConfidence ?? 0) >= OCR_FIRST_READ_MIN_TRACK_CONFIDENCE) {
    return false;
  }

  if (pressure === 'MODERATE') return !starving && track.framesSeen % 2 !== 0;
  if (pressure === 'LARGE') {
    return priorityIndex >= maxConcurrency * 2 || (track.trackConfidence ?? 0) < 0.78 || qualityScore < 0.36;
  }

  return priorityIndex >= Math.max(1, maxConcurrency) || (track.trackConfidence ?? 0) < 0.86 || qualityScore < 0.48;
}

function getMotionAwareDetectorTargetMs(
  adaptiveConfig: AdaptiveScannerConfig,
  tier: DeviceTier,
  tracks: ActiveTrack[]
): number {
  const tierTarget = getTierDetectorTargetMs(tier);
  const peakMotion = tracks.reduce((max, track) => Math.max(max, track.motionScore ?? 0), 0);
  const movingEnvironment = adaptiveConfig.environment.label === 'HIGHWAY' || adaptiveConfig.environment.label === 'TRAFFIC';
  const parkedEnvironment = adaptiveConfig.environment.label === 'PARKING';

  if (movingEnvironment || peakMotion >= MOTION_UNSTABLE_MAX) {
    return Math.max(DETECTION_MIN_DELAY_MS, Math.min(adaptiveConfig.detector.targetIntervalMs, Math.round(tierTarget * 0.72)));
  }

  if (peakMotion >= MOTION_NORMAL_MAX) {
    return Math.max(DETECTION_MIN_DELAY_MS, Math.min(tierTarget, adaptiveConfig.detector.targetIntervalMs));
  }

  if (parkedEnvironment && tracks.length > 0) {
    return Math.max(adaptiveConfig.detector.targetIntervalMs, Math.round(tierTarget * 1.25));
  }

  return Math.max(adaptiveConfig.detector.targetIntervalMs, tierTarget);
}

function getMotionAwareCropSampleIntervalMs(
  track: ActiveTrack,
  baseIntervalMs: number,
  adaptiveConfig: AdaptiveScannerConfig
): number {
  const motion = track.motionScore ?? 0;
  const movingEnvironment = adaptiveConfig.environment.label === 'HIGHWAY' || adaptiveConfig.environment.label === 'TRAFFIC';
  const multiplier = movingEnvironment || motion >= MOTION_UNSTABLE_MAX
    ? 0.45
    : motion >= MOTION_NORMAL_MAX
      ? 0.65
      : 1;

  return Math.max(35, Math.round(baseIntervalMs * adaptiveConfig.buffer.cropSampleIntervalMultiplier * multiplier));
}

function pruneCooldownMap(cooldowns: Map<string, number>, cooldownMs: number, now: number): void {
  const maxAgeMs = Math.max(cooldownMs * 2, 30000);
  for (const [plate, timestamp] of cooldowns.entries()) {
    if (now - timestamp > maxAgeMs) {
      cooldowns.delete(plate);
    }
  }

  if (cooldowns.size <= COOLDOWN_MAP_MAX_ENTRIES) return;

  const entries = Array.from(cooldowns.entries()).sort((a, b) => b[1] - a[1]);
  cooldowns.clear();
  entries.slice(0, COOLDOWN_MAP_MAX_ENTRIES).forEach(([plate, timestamp]) => {
    cooldowns.set(plate, timestamp);
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }

  const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

function estimatePlateOverlayAngle(
  sourceCanvas: HTMLCanvasElement,
  bbox: { x: number; y: number; width: number; height: number },
  previousAngle = 0
): number {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  const x = clampNumber(Math.round(bbox.x), 0, Math.max(0, sourceWidth - 1));
  const y = clampNumber(Math.round(bbox.y), 0, Math.max(0, sourceHeight - 1));
  const width = clampNumber(Math.round(bbox.width), 1, sourceWidth - x);
  const height = clampNumber(Math.round(bbox.height), 1, sourceHeight - y);

  if (width < 30 || height < 10) return previousAngle;

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return previousAngle;

  try {
    const image = ctx.getImageData(x, y, width, height);
    const { data } = image;
    const step = Math.max(1, Math.floor(Math.max(width, height) / 90));
    let weightSum = 0;
    let meanX = 0;
    let meanY = 0;

    const lumaAt = (px: number, py: number) => {
      const idx = (py * width + px) * 4;
      return data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
    };

    for (let py = step; py < height - step; py += step) {
      for (let px = step; px < width - step; px += step) {
        const gx = Math.abs(lumaAt(px + step, py) - lumaAt(px - step, py));
        const gy = Math.abs(lumaAt(px, py + step) - lumaAt(px, py - step));
        const edge = gx + gy;
        if (edge < 28) continue;
        weightSum += edge;
        meanX += px * edge;
        meanY += py * edge;
      }
    }

    if (weightSum < 1) return previousAngle;

    meanX /= weightSum;
    meanY /= weightSum;

    let covXX = 0;
    let covXY = 0;
    let covYY = 0;

    for (let py = step; py < height - step; py += step) {
      for (let px = step; px < width - step; px += step) {
        const gx = Math.abs(lumaAt(px + step, py) - lumaAt(px - step, py));
        const gy = Math.abs(lumaAt(px, py + step) - lumaAt(px, py - step));
        const edge = gx + gy;
        if (edge < 28) continue;
        const dx = px - meanX;
        const dy = py - meanY;
        covXX += dx * dx * edge;
        covXY += dx * dy * edge;
        covYY += dy * dy * edge;
      }
    }

    let angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    if (Math.abs(angle) > MAX_OVERLAY_TILT_RAD) angle = previousAngle;

    return previousAngle * 0.6 + angle * 0.4;
  } catch {
    return previousAngle;
  }
}

function getCameraPreflightError(): string | null {
  if (typeof window === 'undefined') return null;

  if (!window.isSecureContext) {
    return `Camera access is blocked on this address (${window.location.host}). Open the scanner over HTTPS, or use localhost.`;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return 'This browser does not expose camera access. Open the scanner in the latest Chrome or Edge on Windows/macOS and allow camera permission.';
  }

  return null;
}

function canRunMultiCameraOnCurrentDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const phoneLikeUserAgent = /Mobi|Android|iPhone|iPod|Windows Phone/i.test(userAgent);
  const narrowViewport = window.matchMedia('(max-width: 767px)').matches;

  return !phoneLikeUserAgent && !narrowViewport;
}

function isMobileScannerDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  const phoneLikeUserAgent = /Mobi|Android|iPhone|iPod|iPad|Windows Phone/i.test(userAgent);
  const narrowViewport = window.matchMedia('(max-width: 767px)').matches;

  return phoneLikeUserAgent || narrowViewport;
}

function getMobileScannerReloadTrigger(
  snapshot: ScannerMetricsSnapshot,
  detectorFps: number,
  cameraFps: number,
  streams: MediaStream[],
  lastReloadAt: number,
  now: number
): ScannerReloadTrigger | null {
  if (streams.some(streamNeedsReconnect)) {
    return {
      code: 'STREAM_RECONNECT',
      message: 'Camera stream stalled',
      confirmationMs: MOBILE_SCANNER_STREAM_CONFIRM_MS,
    };
  }

  const lastRefreshAt = lastReloadAt || snapshot.sessionStartedAt;
  if (now - lastRefreshAt >= MOBILE_SCANNER_PREVENTIVE_REFRESH_MS) {
    return {
      code: 'SCHEDULED_REFRESH',
      message: 'Preventive mobile scanner refresh',
      confirmationMs: 0,
    };
  }

  if (cameraFps > 0 && cameraFps < MOBILE_SCANNER_LOW_FPS_THRESHOLD && detectorFps < 2) {
    return {
      code: 'CAMERA_FPS_DROP',
      message: 'Camera FPS dropped',
      confirmationMs: MOBILE_SCANNER_ISSUE_CONFIRM_MS,
    };
  }

  const detectorTargetMs = getTierDetectorTargetMs(snapshot.deviceTier);
  const detectorTooSlow =
    snapshot.detectorLatencySamples >= 20 &&
    snapshot.detectorLatencyP95Ms > Math.max(650, detectorTargetMs * 3);
  if (detectorTooSlow) {
    return {
      code: 'DETECTOR_SLOWDOWN',
      message: 'Scanner processing slowed down',
      confirmationMs: MOBILE_SCANNER_ISSUE_CONFIRM_MS,
    };
  }

  const ocrBacklog =
    snapshot.ocrLatencySamples >= 6 &&
    snapshot.lastOcrQueueDepth >= MOBILE_SCANNER_OCR_QUEUE_DEPTH &&
    snapshot.ocrLatencyP95Ms > 900;
  if (ocrBacklog) {
    return {
      code: 'OCR_QUEUE_BACKLOG',
      message: 'OCR queue backed up',
      confirmationMs: MOBILE_SCANNER_ISSUE_CONFIRM_MS,
    };
  }

  if (
    typeof snapshot.memoryGrowthPercent === 'number' &&
    snapshot.memoryGrowthPercent >= MOBILE_SCANNER_MEMORY_GROWTH_PERCENT
  ) {
    return {
      code: 'MEMORY_GROWTH',
      message: 'Mobile browser memory grew',
      confirmationMs: MOBILE_SCANNER_ISSUE_CONFIRM_MS,
    };
  }

  return null;
}

function mapVehicleToCase(vehicle: Vehicle): VehicleCase {
  const normalizedPlate = cleanPlateNumber(vehicle.plate);

  // Map the storage-layer Vehicle status to the VehicleCase CaseStatus used by
  // the matching engine. Only CLOSED cases are excluded from DB matching.
  // FLAGGED and PENDING are active pursuit cases — map them to ON_HOLD so the
  // matching engine still finds them. CLEARED cases are treated as RECOVERED.
  const statusMap: Record<string, VehicleCase['status']> = {
    ACTIVE: 'ACTIVE',
    FLAGGED: 'ON_HOLD',
    PENDING: 'ON_HOLD',
    CLEARED: 'RECOVERED',
  };
  const caseStatus: VehicleCase['status'] = statusMap[vehicle.status] ?? 'ACTIVE';

  return {
    id: vehicle.id,
    plateNumber: normalizedPlate,
    normalizedPlate,
    customerName: vehicle.customerName,
    customerReference: vehicle.customerId,
    vehicleMake: vehicle.brand,
    vehicleModel: vehicle.model,
    vehicleColor: vehicle.colour,
    vehicleYear: vehicle.year,
    financeCompany: vehicle.financeCompany,
    outstandingAmount: vehicle.outstandingAmount,
    caseReference: vehicle.reference,
    status: caseStatus,
    notes: vehicle.remark,
    createdAt: vehicle.createdDate,
    updatedAt: vehicle.updatedDate,
  };
}

export default function ScannerPage() {
  const { t, language } = useLanguage();
  const { vehicles, addHistoryLog, updateVehicle, settings } = useStorage();
  const { role } = useAuth();
  const canUseDiagnostics = false;

  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const canvasRefs = useRef<Record<string, HTMLCanvasElement | null>>({});
  const slotRuntimesRef = useRef<Record<string, SlotScannerRuntime>>({});
  const slotMetricsRef = useRef<Record<string, SlotMetrics>>({});
  const activeStreamsRef = useRef<Record<string, MediaStream>>({});
  const activeCameraSlotIdRef = useRef('camera-slot-1');
  const cameraSlotsRef = useRef<CameraSlot[]>([{ id: 'camera-slot-1', deviceId: '' }]);
  const availableCamerasRef = useRef<DesktopCameraDevice[]>([]);
  const cameraMetadataBySlotRef = useRef<Record<string, CameraRuntimeMetadata>>({});
  const supportsMultiCameraScanRef = useRef(false);
  const isCameraReadyRef = useRef(false);
  const isScanningRef = useRef(false);
  const developerModeRef = useRef(false);
  const datasetModeRef = useRef(false);
  const runtimeStateRef = useRef<ANPRRuntimeState>('UNINITIALIZED');
  const vehiclesRef = useRef(vehicles);
  const addHistoryLogRef = useRef(addHistoryLog);
  const soundEnabledRef = useRef(true);
  const settingsRef = useRef<ScannerSettings>({ ...INITIAL_SETTINGS, debugMode: false });
  const cooldownMap = useRef<Map<string, number>>(new Map());
  const activeOcrCount = useRef(0);
  const lastMetricsFlushTs = useRef(Date.now());
  const runtimeMetricsRef = useRef<ScannerRuntimeMetrics>(createInitialRuntimeMetrics());
  const completedTrackEventsRef = useRef<CompletedTrackEvent[]>([]);
  const datasetSamplesRef = useRef<DatasetSample[]>([]);
  const lostTrackIdsRef = useRef<Set<string>>(new Set());
  const adaptiveConfigRef = useRef<AdaptiveScannerConfig>(
    createAdaptiveScannerConfig(createDefaultEnvironmentProfile())
  );
  const environmentProfileRef = useRef<EnvironmentProfile>(createDefaultEnvironmentProfile());
  const environmentStatsRef = useRef<FrameImageStats | undefined>(undefined);
  const environmentInferenceRunningRef = useRef(false);
  const lastPerformanceAdaptationAtRef = useRef(0);
  const lastCameraConstraintApplyAtRef = useRef(0);
  const cameraOperationIdRef = useRef(0);
  const stopCameraRef = useRef<(options?: CameraStopOptions) => void>(() => undefined);
  const startVisibleCamerasRef = useRef<(options?: { resumeScanning?: boolean }) => Promise<boolean>>(async () => false);
  const scannerReloadInFlightRef = useRef(false);
  const scannerStartupInFlightRef = useRef(false);
  const scannerProcessingPausedRef = useRef(false);
  const lastScannerReloadAtRef = useRef(0);
  const scannerReloadIssueRef = useRef<{ code: ScannerReloadTriggerCode; firstSeenAt: number } | null>(null);
  const scannerReloadNoticeTimerRef = useRef<number | null>(null);
  const mobilePinchZoomRef = useRef<{ startDistance: number; startZoom: number } | null>(null);
  const mobileFacingModeRef = useRef<MobileFacingMode>('environment');
  const resetLiveScanUiRef = useRef<() => void>(() => undefined);

  const [availableCameras, setAvailableCameras] = useState<DesktopCameraDevice[]>([]);
  const [cameraSlots, setCameraSlots] = useState<CameraSlot[]>([{ id: 'camera-slot-1', deviceId: '' }]);
  const [activeCameraSlotId, setActiveCameraSlotId] = useState('camera-slot-1');
  const [supportsMultiCameraScan, setSupportsMultiCameraScan] = useState(false);
  const [previewSlotIds, setPreviewSlotIds] = useState<string[]>([]);
  const [cameraMetadataBySlot, setCameraMetadataBySlot] = useState<Record<string, CameraRuntimeMetadata>>({});
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scannerProcessingPaused, setScannerProcessingPausedState] = useState(false);
  const [mobileCameraZoom, setMobileCameraZoom] = useState(1);
  const [mobileFacingMode, setMobileFacingMode] = useState<MobileFacingMode>('environment');
  const [scannerReloadNotice, setScannerReloadNotice] = useState<ScannerReloadNotice | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [developerMode, setDeveloperMode] = useState(false);
  const [datasetMode, setDatasetMode] = useState(false);
  const [environmentProfile, setEnvironmentProfile] = useState<EnvironmentProfile>(() => createDefaultEnvironmentProfile());
  const [adaptiveConfigSnapshot, setAdaptiveConfigSnapshot] = useState<AdaptiveScannerConfig>(() =>
    createAdaptiveScannerConfig(createDefaultEnvironmentProfile())
  );
  const [, setCurrentPlate] = useState('READY');
  const [, setLastDetectedSlotId] = useState('');
  const [activeAlertMatchesBySlot, setActiveAlertMatchesBySlot] = useState<Record<string, AlertMatch>>({});
  const [liveDetections, setLiveDetections] = useState<SessionDetection[]>([]);
  const [expandedDetectionId, setExpandedDetectionId] = useState<string | null>(null);
  const [runtimeState, setRuntimeState] = useState<ANPRRuntimeState>('UNINITIALIZED');
  const [benchmarkResult, setBenchmarkResult] = useState<AdmissionBenchmarkResult | null>(null);
  const [runtimeErrorMessage, setRuntimeErrorMessage] = useState<string | null>(null);
  const [detectorProvider, setDetectorProvider] = useState<ActiveExecutionProvider>('NONE');
  const [ocrProvider, setOcrProvider] = useState<ActiveOcrProvider>('NONE');
  const [camFps, setCamFps] = useState(0);
  const [detFps, setDetFps] = useState(0);
  const [, setPlatesVisible] = useState(0);
  const [activeTracksCount, setActiveTracksCount] = useState(0);
  const [tracksList, setTracksList] = useState<ActiveTrack[]>([]);
  const [runtimeMetricsSnapshot, setRuntimeMetricsSnapshot] = useState<ScannerMetricsSnapshot>(() =>
    createMetricsSnapshot(createInitialRuntimeMetrics(), [])
  );
  const [systemHealthSnapshot, setSystemHealthSnapshot] = useState<SystemHealthSnapshot>(() =>
    createSystemHealthSnapshot(createMetricsSnapshot(createInitialRuntimeMetrics(), []), 0, 0)
  );
  const effectiveDeveloperMode = canUseDiagnostics && developerMode;
  const effectiveDatasetMode = canUseDiagnostics && datasetMode;

  const getSlotRuntime = useCallback((slotId: string): SlotScannerRuntime => {
    if (!slotRuntimesRef.current[slotId]) {
      slotRuntimesRef.current[slotId] = {
        tracker: new PlateTracker(20, 8),
        bestFrameSelector: new BestFrameSelector(),
        processingCanvas: null,
        lastMaintenanceTs: 0,
      };
    }

    return slotRuntimesRef.current[slotId];
  }, []);

  const ensureSlotMetrics = useCallback((slotId: string): SlotMetrics => {
    if (!slotMetricsRef.current[slotId]) {
      slotMetricsRef.current[slotId] = {
        camFrames: 0,
        detFrames: 0,
        platesVisible: 0,
        activeTracks: 0,
        tracks: [],
      };
    }

    return slotMetricsRef.current[slotId];
  }, []);

  const applyActiveCameraConstraints = useCallback(async () => {
    const now = Date.now();
    if (now - lastCameraConstraintApplyAtRef.current < CAMERA_CONSTRAINT_APPLY_COOLDOWN_MS) return;
    lastCameraConstraintApplyAtRef.current = now;

    const metrics = runtimeMetricsRef.current;
    const adaptiveCamera = getActiveCameraCaptureConfig(
      adaptiveConfigRef.current.camera,
      metrics.adaptationLevel
    );
    const constraints: MediaTrackConstraints = {
      ...getCameraPerformanceConstraints(metrics.adaptationLevel),
      width: { ideal: adaptiveCamera.idealWidth },
      height: { ideal: adaptiveCamera.idealHeight },
      frameRate: { ideal: adaptiveCamera.idealFps, max: 30 },
    };
    const tracks = Object.values(activeStreamsRef.current).flatMap((stream) => stream.getVideoTracks());

    await Promise.all(
      tracks.map(async (track) => {
        if (typeof track.applyConstraints !== 'function') return;
        try {
          await track.applyConstraints(constraints);
        } catch {
          // Some desktop webcams expose fixed capture modes and reject live renegotiation.
        }
      })
    );

    metrics.cameraProfile = getCameraProfileLabel(
      metrics.deviceTier,
      metrics.adaptationLevel,
      isMobileScannerDevice()
    );
  }, []);

  const maybeAdaptRuntimePerformance = useCallback(
    (snapshot: ScannerMetricsSnapshot, detectorFps: number, cameraFps: number) => {
      const now = Date.now();
      if (now - lastPerformanceAdaptationAtRef.current < PERFORMANCE_ADAPTATION_CHECK_MS) return;

      const metrics = runtimeMetricsRef.current;
      const baseTier = classifyDeviceTier(getLatestBenchmarkResult(), runtimeStateRef.current);
      const reason = getRuntimeAdaptationReason(snapshot, detectorFps, cameraFps);

      if (
        reason &&
        metrics.adaptationLevel < 3 &&
        now - lastPerformanceAdaptationAtRef.current >= PERFORMANCE_ADAPTATION_COOLDOWN_MS
      ) {
        applyRuntimePerformanceProfile(metrics, baseTier, metrics.adaptationLevel + 1, reason);
        lastPerformanceAdaptationAtRef.current = now;
        void applyActiveCameraConstraints();
        return;
      }

      if (
        !reason &&
        metrics.adaptationLevel > 0 &&
        now - lastPerformanceAdaptationAtRef.current >= PERFORMANCE_RECOVERY_COOLDOWN_MS &&
        canRecoverRuntimeProfile(snapshot, detectorFps, cameraFps)
      ) {
        applyRuntimePerformanceProfile(metrics, baseTier, metrics.adaptationLevel - 1, 'Recovered sustained performance');
        lastPerformanceAdaptationAtRef.current = now;
        void applyActiveCameraConstraints();
        return;
      }

      applyRuntimePerformanceProfile(metrics, baseTier, metrics.adaptationLevel, metrics.performanceModeReason);
    },
    [applyActiveCameraConstraints]
  );

  const clearScannerReloadNoticeTimer = useCallback(() => {
    if (scannerReloadNoticeTimerRef.current) {
      window.clearTimeout(scannerReloadNoticeTimerRef.current);
      scannerReloadNoticeTimerRef.current = null;
    }
  }, []);

  const setScannerProcessingPaused = useCallback((paused: boolean) => {
    scannerProcessingPausedRef.current = paused;
    setScannerProcessingPausedState(paused);
  }, []);

  const requestScannerOnlyReload = useCallback(
    async (trigger: ScannerReloadTrigger) => {
      if (scannerReloadInFlightRef.current || !isScanningRef.current) return false;

      scannerReloadInFlightRef.current = true;
      scannerReloadIssueRef.current = null;
      clearScannerReloadNoticeTimer();

      const startedAt = Date.now();
      lastScannerReloadAtRef.current = startedAt;
      setScannerProcessingPaused(true);
      setCurrentPlate('RELOADING');
      setScannerReloadNotice((prev) => ({
        isReloading: true,
        reason: trigger.message,
        startedAt,
        count: (prev?.count ?? 0) + 1,
        mode: 'RELOADING',
      }));

      try {
        // Reset tracker/OCR/best-frame state before reconnecting so stale
        // track data from the previous stream does not bleed into the new one.
        resetLiveScanUiRef.current();

        const started = await startVisibleCamerasRef.current({ resumeScanning: true });
        if (started) {
          await waitMs(getScannerCameraSettleMs('RELOADING'));
          resetLiveScanUiRef.current();
        }
        const completedAt = Date.now();

        if (!started) {
          setScannerProcessingPaused(false);
          setIsScanning(false);
          setCurrentPlate('READY');
        } else {
          setScannerProcessingPaused(false);
          setCurrentPlate('SCANNING');
        }

        setScannerReloadNotice((prev) =>
          prev?.startedAt === startedAt
            ? {
              ...prev,
              isReloading: false,
              completedAt,
              reason: started ? `${trigger.message} complete` : trigger.message,
            }
            : prev
        );

        scannerReloadNoticeTimerRef.current = window.setTimeout(() => {
          setScannerReloadNotice((prev) => (prev && !prev.isReloading ? null : prev));
          scannerReloadNoticeTimerRef.current = null;
        }, MOBILE_SCANNER_RELOAD_NOTICE_MS);

        return started;
      } finally {
        if (scannerReloadInFlightRef.current) {
          setScannerProcessingPaused(false);
        }
        scannerReloadInFlightRef.current = false;
      }
    },
    [clearScannerReloadNoticeTimer, setScannerProcessingPaused]
  );

  const maybeAutoReloadMobileScanner = useCallback(
    (snapshot: ScannerMetricsSnapshot, detectorFps: number, cameraFps: number) => {
      if (!isScanningRef.current || !isCameraReadyRef.current || !isMobileScannerDevice()) {
        scannerReloadIssueRef.current = null;
        return;
      }

      if (scannerReloadInFlightRef.current) return;

      const now = Date.now();
      const streams = Object.values(activeStreamsRef.current);
      if (streams.length === 0) return;

      const trigger = getMobileScannerReloadTrigger(
        snapshot,
        detectorFps,
        cameraFps,
        streams,
        lastScannerReloadAtRef.current,
        now
      );

      if (!trigger) {
        scannerReloadIssueRef.current = null;
        return;
      }

      const freshScannerRuntime =
        now - Math.max(snapshot.sessionStartedAt, lastScannerReloadAtRef.current || 0) < MOBILE_SCANNER_RELOAD_MIN_UPTIME_MS;
      if (freshScannerRuntime && trigger.code !== 'STREAM_RECONNECT') return;

      const reloadCooldownMs =
        trigger.code === 'STREAM_RECONNECT' ? MOBILE_SCANNER_STREAM_COOLDOWN_MS : MOBILE_SCANNER_RELOAD_COOLDOWN_MS;
      if (lastScannerReloadAtRef.current && now - lastScannerReloadAtRef.current < reloadCooldownMs) return;

      const existingIssue = scannerReloadIssueRef.current;
      if (!existingIssue || existingIssue.code !== trigger.code) {
        scannerReloadIssueRef.current = {
          code: trigger.code,
          firstSeenAt: now,
        };
        if (trigger.confirmationMs > 0) return;
      }

      const issueFirstSeenAt = scannerReloadIssueRef.current?.firstSeenAt ?? now;
      if (now - issueFirstSeenAt < trigger.confirmationMs) return;

      void requestScannerOnlyReload(trigger);
    },
    [requestScannerOnlyReload]
  );

  const flushScannerMetrics = useCallback(() => {
    const metrics = Object.values(slotMetricsRef.current);
    const aggregate = metrics.reduce(
      (acc, item) => {
        acc.camFrames += item.camFrames;
        acc.detFrames += item.detFrames;
        acc.platesVisible += item.platesVisible;
        acc.activeTracks += item.activeTracks;
        acc.tracks.push(...item.tracks);
        return acc;
      },
      { camFrames: 0, detFrames: 0, platesVisible: 0, activeTracks: 0, tracks: [] as ActiveTrack[] }
    );

    setCamFps(aggregate.camFrames);
    setDetFps(aggregate.detFrames);
    setPlatesVisible(aggregate.platesVisible);
    setActiveTracksCount(aggregate.activeTracks);
    setTracksList(aggregate.tracks);
    runtimeMetricsRef.current.memoryCurrentMb = getUsedHeapMb() ?? runtimeMetricsRef.current.memoryCurrentMb;
    runtimeMetricsRef.current.cameraHealth = createCameraHealthSnapshot(
      environmentStatsRef.current,
      aggregate.camFrames,
      runtimeMetricsRef.current.droppedFrameCount
    );
    const snapshot = createMetricsSnapshot(runtimeMetricsRef.current, aggregate.tracks);
    maybeAdaptRuntimePerformance(snapshot, aggregate.detFrames, aggregate.camFrames);
    const adaptedSnapshot = createMetricsSnapshot(runtimeMetricsRef.current, aggregate.tracks);
    setRuntimeMetricsSnapshot(adaptedSnapshot);
    setSystemHealthSnapshot(createSystemHealthSnapshot(adaptedSnapshot, aggregate.detFrames, aggregate.camFrames));
    maybeAutoReloadMobileScanner(adaptedSnapshot, aggregate.detFrames, aggregate.camFrames);

    Object.values(slotMetricsRef.current).forEach((item) => {
      item.camFrames = 0;
      item.detFrames = 0;
    });
  }, [maybeAdaptRuntimePerformance, maybeAutoReloadMobileScanner]);

  const resetLiveScanUi = useCallback(() => {
    Object.values(slotRuntimesRef.current).forEach((runtime) => {
      runtime.tracker.clear();
      runtime.bestFrameSelector.resetAll();
      runtime.processingCanvas = null;
      runtime.lastMaintenanceTs = 0;
    });
    slotMetricsRef.current = {};
    activeOcrCount.current = 0;
    lastMetricsFlushTs.current = Date.now();
    runtimeMetricsRef.current = createInitialRuntimeMetrics(
      classifyDeviceTier(getLatestBenchmarkResult(), runtimeStateRef.current)
    );
    lastPerformanceAdaptationAtRef.current = Date.now();
    lastCameraConstraintApplyAtRef.current = 0;
    completedTrackEventsRef.current = [];
    lostTrackIdsRef.current.clear();
    const emptySnapshot = createMetricsSnapshot(runtimeMetricsRef.current, []);
    setRuntimeMetricsSnapshot(emptySnapshot);
    setSystemHealthSnapshot(createSystemHealthSnapshot(emptySnapshot, 0, 0));
    setTracksList([]);
    setPlatesVisible(0);
    setActiveTracksCount(0);
    setCamFps(0);
    setDetFps(0);
    Object.values(canvasRefs.current).forEach((canvas) => {
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    });
  }, []);

  const syncRuntimeStatus = useCallback(() => {
    const nextState = getANPRRuntimeState();
    const latestBenchmark = getLatestBenchmarkResult();
    runtimeStateRef.current = nextState;
    setRuntimeState((prev) => (prev === nextState ? prev : nextState));
    setBenchmarkResult(latestBenchmark);
    setRuntimeErrorMessage(getRuntimeErrorMessage());
    setDetectorProvider(getActiveDetectorProvider());
    setOcrProvider(getActivePpOcrProvider());
    applyRuntimePerformanceProfile(
      runtimeMetricsRef.current,
      classifyDeviceTier(latestBenchmark, nextState),
      runtimeMetricsRef.current.adaptationLevel,
      runtimeMetricsRef.current.performanceModeReason
    );
  }, []);

  const startRuntimeInit = useCallback(async () => {
    runtimeStateRef.current = 'LOADING_MODELS';
    setRuntimeState('LOADING_MODELS');
    setRuntimeErrorMessage(null);

    const progressTimer = window.setInterval(syncRuntimeStatus, 500);
    try {
      const res = await initializeANPRRuntime();
      runtimeStateRef.current = res.state;
      setRuntimeState(res.state);
      if (res.benchmark) setBenchmarkResult(res.benchmark);
    } finally {
      window.clearInterval(progressTimer);
      syncRuntimeStatus();
    }
  }, [syncRuntimeStatus]);

  useEffect(() => {
    vehiclesRef.current = vehicles;
  }, [vehicles]);

  useEffect(() => {
    cameraSlotsRef.current = cameraSlots;
  }, [cameraSlots]);

  useEffect(() => {
    availableCamerasRef.current = availableCameras;
  }, [availableCameras]);

  useEffect(() => {
    cameraMetadataBySlotRef.current = cameraMetadataBySlot;
  }, [cameraMetadataBySlot]);

  useEffect(() => {
    activeCameraSlotIdRef.current = activeCameraSlotId;
  }, [activeCameraSlotId]);

  useEffect(() => {
    isCameraReadyRef.current = isCameraReady;
  }, [isCameraReady]);

  useEffect(() => {
    isScanningRef.current = isScanning;
  }, [isScanning]);

  useEffect(() => {
    developerModeRef.current = effectiveDeveloperMode;
  }, [effectiveDeveloperMode]);

  useEffect(() => {
    datasetModeRef.current = effectiveDatasetMode;
  }, [effectiveDatasetMode]);

  useEffect(() => {
    supportsMultiCameraScanRef.current = supportsMultiCameraScan;
  }, [supportsMultiCameraScan]);

  useEffect(() => {
    const updateCapability = () => {
      const nextSupportsMultiCamera = canRunMultiCameraOnCurrentDevice();
      supportsMultiCameraScanRef.current = nextSupportsMultiCamera;
      setSupportsMultiCameraScan(nextSupportsMultiCamera);
      void applyActiveCameraConstraints();

      if (!nextSupportsMultiCamera) {
        setCameraSlots((slots) => {
          const selectedSlot = slots.find((slot) => slot.id === activeCameraSlotIdRef.current) || slots[0];
          return selectedSlot ? [selectedSlot] : slots;
        });
        setPreviewSlotIds((ids) => ids.filter((id) => id === activeCameraSlotIdRef.current));
      }
    };

    const id = window.setTimeout(updateCapability, 0);
    window.addEventListener('resize', updateCapability);
    window.addEventListener('orientationchange', updateCapability);

    return () => {
      window.clearTimeout(id);
      window.removeEventListener('resize', updateCapability);
      window.removeEventListener('orientationchange', updateCapability);
    };
  }, [applyActiveCameraConstraints]);

  useEffect(() => {
    addHistoryLogRef.current = addHistoryLog;
  }, [addHistoryLog]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    settingsRef.current = {
      ...settingsRef.current,
      soundEnabled: soundEnabled && settings.soundAlerts,
      detectionThreshold: clampPercentToThreshold(
        settings.detectionConfidence,
        INITIAL_SETTINGS.detectionThreshold,
        0.25,
        0.65
      ),
      recognitionThreshold: clampPercentToThreshold(
        settings.ocrConfidence,
        INITIAL_SETTINGS.recognitionThreshold,
        0.35,
        0.7
      ),
      debugMode: effectiveDeveloperMode,
      showCenterGuide: false,
    };
  }, [effectiveDeveloperMode, settings, soundEnabled]);

  useEffect(() => {
    const initTimer = window.setTimeout(() => {
      void startRuntimeInit();
    }, 0);
    const id = window.setInterval(syncRuntimeStatus, 1000);
    return () => {
      window.clearTimeout(initTimer);
      window.clearInterval(id);
    };
  }, [startRuntimeInit, syncRuntimeStatus]);

  useEffect(() => {
    stopCameraRef.current = stopCamera;
    startVisibleCamerasRef.current = startVisibleCameras;
    resetLiveScanUiRef.current = resetLiveScanUi;
  });

  useEffect(() => {
    return () => {
      clearScannerReloadNoticeTimer();
    };
  }, [clearScannerReloadNoticeTimer]);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const storedDetections = localStorage.getItem(RECENT_DETECTIONS_STORAGE_KEY);
        if (storedDetections) {
          const parsedDetections = JSON.parse(storedDetections) as SessionDetection[];
          setLiveDetections(parsedDetections.slice(0, 8));
          if (parsedDetections[0]) {
            setCurrentPlate(parsedDetections[0].plate);
            setLastDetectedSlotId(parsedDetections[0].cameraId);
          }
        }
      } catch {
        localStorage.removeItem(RECENT_DETECTIONS_STORAGE_KEY);
      }

      void refreshCameraList();
    }, 0);

    return () => {
      window.clearTimeout(restoreTimer);
      stopCameraRef.current();
    };
  }, []);

  useEffect(() => {
    if (!isCameraReadyRef.current) return;
    const resumeScanning = isScanningRef.current;
    window.setTimeout(() => {
      void startVisibleCamerasRef.current({ resumeScanning });
    }, 0);
  }, [cameraSlots.length]);

  async function refreshCameraList() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraError('Camera devices are not available in this browser.');
      return [] as DesktopCameraDevice[];
    }

    try {
      const videoDevices = await enumerateDesktopCameras();
      const rememberedDeviceId = getRememberedCameraId();
      const preferredCamera = selectPreferredCamera(videoDevices, rememberedDeviceId);
      setCameraSlots((slots) =>
        slots.map((slot, index) => ({
          ...slot,
          deviceId:
            slot.deviceId ||
            (index === 0 ? preferredCamera?.deviceId : videoDevices[index]?.deviceId) ||
            videoDevices[0]?.deviceId ||
            '',
        }))
      );
      setAvailableCameras(videoDevices);
      setCameraError('');
      return videoDevices;
    } catch {
      setCameraError('Unable to read camera list. Please allow camera access.');
      return [] as DesktopCameraDevice[];
    }
  }

  function getCameraSlotLabel(slot: CameraSlot | undefined, index: number) {
    if (!slot) return language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera';
    const device = availableCameras.find((cameraDevice) => cameraDevice.deviceId === slot.deviceId);
    return device?.label || (index === 0 ? (language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera') : `Camera ${index + 1}`);
  }

  function stopCamera(options: CameraStopOptions = {}) {
    const preserveScanningState = options.preserveScanningState ?? false;
    const invalidatePendingStarts = options.invalidatePendingStarts ?? !preserveScanningState;

    if (invalidatePendingStarts) {
      cameraOperationIdRef.current++;
    }

    isCameraReadyRef.current = false;
    if (!preserveScanningState) {
      isScanningRef.current = false;
      scannerReloadInFlightRef.current = false;
      scannerStartupInFlightRef.current = false;
      setScannerProcessingPaused(false);
    }

    Object.values(activeStreamsRef.current).forEach((stream) => {
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
    });
    activeStreamsRef.current = {};

    Object.values(videoRefs.current).forEach((video) => {
      if (!video) return;
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // Older mobile browsers can reject load() after a stream is detached.
      }
    });

    scannerReloadIssueRef.current = null;
    setPreviewSlotIds([]);
    setCameraMetadataBySlot({});
    setIsCameraReady(false);
    if (!preserveScanningState) {
      if (!scannerStartupInFlightRef.current) {
        clearScannerReloadNoticeTimer();
        setScannerReloadNotice(null);
      }
      setIsScanning(false);
    }
    resetLiveScanUi();
  }

  async function startCameraForSlot(slot: CameraSlot, operationId = cameraOperationIdRef.current) {
    const preflightError = getCameraPreflightError();
    if (preflightError) {
      setCameraError(preflightError);
      return false;
    }

    try {
      if (operationId !== cameraOperationIdRef.current) return false;

      const facingMode = isMobileScannerDevice() ? mobileFacingModeRef.current : undefined;
      const cameraDeviceId = facingMode ? '' : slot.deviceId;
      const streamKey = cameraDeviceId || `default-camera-${facingMode ?? 'any'}`;
      let stream = activeStreamsRef.current[streamKey];

      if (!stream) {
        stream = await openDesktopCameraStream(
          cameraDeviceId,
          getActiveCameraCaptureConfig(
            adaptiveConfigRef.current.camera,
            runtimeMetricsRef.current.adaptationLevel
          ),
          facingMode
        );
        if (operationId !== cameraOperationIdRef.current) {
          stream.getTracks().forEach((track) => {
            track.onended = null;
            track.stop();
          });
          return false;
        }
        activeStreamsRef.current[streamKey] = stream;
      }

      if (operationId !== cameraOperationIdRef.current) return false;
      const cameraDevice = cameraDeviceId
        ? availableCamerasRef.current.find((device) => device.deviceId === cameraDeviceId) || null
        : null;
      const cameraMetadata = getCameraRuntimeMetadata(stream, cameraDevice);

      const video = videoRefs.current[slot.id];
      if (video) {
        if (operationId !== cameraOperationIdRef.current) return false;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('webkit-playsinline', 'true');
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }

      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          if (operationId !== cameraOperationIdRef.current) return;
          if (!isCameraReadyRef.current && !isScanningRef.current) return;
          window.setTimeout(() => {
            if (operationId !== cameraOperationIdRef.current) return;
            void startVisibleCamerasRef.current({ resumeScanning: isScanningRef.current });
          }, 1200);
        };
      });

      if (!facingMode) rememberSelectedCamera(slot.deviceId || cameraMetadata.deviceId);
      setCameraMetadataBySlot((prev) => ({ ...prev, [slot.id]: cameraMetadata }));
      setPreviewSlotIds((ids) => (ids.includes(slot.id) ? ids : [...ids, slot.id]));
      setCameraError('');
      return true;
    } catch {
      setCameraError('Unable to start camera. Please allow camera permission and try again.');
      return false;
    }
  }

  async function startVisibleCameras(options: { resumeScanning?: boolean } = {}) {
    const resumeScanning = options.resumeScanning ?? false;
    const operationId = cameraOperationIdRef.current + 1;
    cameraOperationIdRef.current = operationId;
    stopCamera({ preserveScanningState: resumeScanning, invalidatePendingStarts: false });
    const devices = await refreshCameraList();
    if (operationId !== cameraOperationIdRef.current) return false;

    const resolvedSlots =
      cameraSlots.length > 0
        ? cameraSlots.map((slot, index) => ({
            ...slot,
            deviceId: slot.deviceId || devices[index]?.deviceId || devices[0]?.deviceId || '',
          }))
        : [{ id: 'camera-slot-1', deviceId: devices[0]?.deviceId || '' }];
    const slots = supportsMultiCameraScanRef.current
      ? resolvedSlots
      : [resolvedSlots.find((slot) => slot.id === activeCameraSlotIdRef.current) || resolvedSlots[0]];

    setCameraSlots(slots);
    const startedResults = await Promise.all(slots.map((slot) => startCameraForSlot(slot, operationId)));
    if (operationId !== cameraOperationIdRef.current) return false;

    const started = startedResults.some(Boolean);
    if (resumeScanning && !isScanningRef.current) {
      stopCamera({ invalidatePendingStarts: false });
      return false;
    }

    isCameraReadyRef.current = started;
    setIsCameraReady(started);
    if (started && resumeScanning) {
      setCurrentPlate('SCANNING');
      isScanningRef.current = true;
      setIsScanning(true);
    }
    return started;
  }

  const handleUseCamera = async (slot: CameraSlot, index: number) => {
    const operationId = cameraOperationIdRef.current + 1;
    cameraOperationIdRef.current = operationId;
    stopCamera({ invalidatePendingStarts: false });
    const devices = await refreshCameraList();
    if (operationId !== cameraOperationIdRef.current) return;

    const resolvedSlot = {
      ...slot,
      deviceId: slot.deviceId || devices[index]?.deviceId || devices[0]?.deviceId || '',
    };
    setCameraSlots((slots) => slots.map((item) => (item.id === slot.id ? resolvedSlot : item)));
    handleSelectActiveSlot(slot.id);
    const started = await startCameraForSlot(resolvedSlot, operationId);
    if (operationId !== cameraOperationIdRef.current) return;
    if (started) {
      isCameraReadyRef.current = true;
      setIsCameraReady(true);
    }
  };

  const handleSelectActiveSlot = (slotId: string) => {
    setActiveCameraSlotId(slotId);
    if (isScanning) {
      setLastDetectedSlotId(slotId);
      setCurrentPlate((plate) => (plate === 'READY' || plate === 'PAUSED' ? 'SCANNING' : plate));
    }
  };

  const handleCameraSlotDeviceChange = (slotId: string, deviceId: string) => {
    const hadActiveCamera =
      isCameraReadyRef.current || isScanningRef.current || previewSlotIds.includes(slotId);
    rememberSelectedCamera(deviceId);
    setCameraSlots((slots) => slots.map((slot) => (slot.id === slotId ? { ...slot, deviceId } : slot)));
    setPreviewSlotIds((ids) => ids.filter((id) => id !== slotId));
    handleSelectActiveSlot(slotId);

    if (hadActiveCamera) {
      stopCamera();
      setCurrentPlate('READY');
    }
  };

  const handleStartScanning = async () => {
    if (scannerStartupInFlightRef.current || scannerReloadInFlightRef.current) return;

    scannerStartupInFlightRef.current = true;
    scannerReloadIssueRef.current = null;
    clearScannerReloadNoticeTimer();
    setScannerProcessingPaused(true);
    const startedAt = Date.now();
    setCurrentPlate('RELOADING');
    setScannerReloadNotice((prev) => ({
      isReloading: true,
      reason: language === 'BM' ? 'Kamera sedang dimulakan' : 'Camera initializing',
      startedAt,
      count: (prev?.count ?? 0) + 1,
      mode: 'STARTING',
    }));

    try {
      const started = await startVisibleCameras();
      if (!started) {
        setScannerProcessingPaused(false);
        setScannerReloadNotice(null);
        setCurrentPlate('READY');
        return;
      }

      if (!isRuntimeScanningReady(runtimeStateRef.current)) {
        void startRuntimeInit();
      }

      await waitMs(getScannerCameraSettleMs('STARTING'));
      resetLiveScanUi();
      lastScannerReloadAtRef.current = Date.now();
      setCurrentPlate('SCANNING');
      isCameraReadyRef.current = true;
      isScanningRef.current = true;
      setIsScanning(true);
      setScannerProcessingPaused(false);

      const completedAt = Date.now();
      setScannerReloadNotice((prev) =>
        prev?.startedAt === startedAt
          ? {
              ...prev,
              isReloading: false,
              completedAt,
              reason: language === 'BM' ? 'Kamera sedia' : 'Camera ready',
            }
          : prev
      );
      scannerReloadNoticeTimerRef.current = window.setTimeout(() => {
        setScannerReloadNotice((prev) => (prev && !prev.isReloading ? null : prev));
        scannerReloadNoticeTimerRef.current = null;
      }, MOBILE_SCANNER_RELOAD_NOTICE_MS);
    } finally {
      scannerStartupInFlightRef.current = false;
      if (!isScanningRef.current) {
        setScannerProcessingPaused(false);
      }
    }
  };

  const handleStopScanning = () => {
    scannerStartupInFlightRef.current = false;
    setScannerProcessingPaused(false);
    stopCamera();
    setCurrentPlate('READY');
  };

  const handleMobileFacingModeChange = (mode: MobileFacingMode) => {
    if (mobileFacingModeRef.current === mode) return;

    mobileFacingModeRef.current = mode;
    setMobileFacingMode(mode);

    if (!isMobileScannerDevice()) return;

    const wasScanning = isScanningRef.current;
    const hadCameraOpen = isCameraReadyRef.current || previewSlotIds.length > 0;
    if (!hadCameraOpen && !wasScanning) return;

    stopCamera({ preserveScanningState: wasScanning, invalidatePendingStarts: false });
    void startVisibleCamerasRef.current({ resumeScanning: wasScanning });
  };

  const handleAddCamera = async () => {
    if (!supportsMultiCameraScanRef.current) return;

    const devices = await refreshCameraList();
    setCameraSlots((slots) => {
      if (slots.length >= 4) return slots;
      const nextIndex = slots.length;
      const nextDeviceId = devices[nextIndex]?.deviceId || devices[0]?.deviceId || slots[0]?.deviceId || '';
      return [...slots, { id: `camera-slot-${Date.now()}`, deviceId: nextDeviceId }];
    });
  };

  const handleRemoveCamera = (slotId: string) => {
    setCameraSlots((slots) => {
      if (slots.length <= 1) return slots;
      const nextSlots = slots.filter((slot) => slot.id !== slotId);
      if (activeCameraSlotId === slotId) {
        setActiveCameraSlotId(nextSlots[0]?.id || 'camera-slot-1');
      }
      setPreviewSlotIds((ids) => ids.filter((id) => id !== slotId));
      setActiveAlertMatchesBySlot((alerts) => {
        if (!alerts[slotId]) return alerts;
        const nextAlerts = { ...alerts };
        delete nextAlerts[slotId];
        return nextAlerts;
      });
      return nextSlots;
    });
  };

  function playAlertChime() {
    if (!soundEnabledRef.current) return;
    try {
      const audioWindow = window as AudioWindow;
      const AudioCtor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
      if (!AudioCtor) return;
      const audioCtx = new AudioCtor();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    } catch {
      // Silent fallback when audio playback is blocked by the browser.
    }
  }

  const getCameraSlotLabelFromRefs = useCallback(
    (slotId: string) => {
      const slots = cameraSlotsRef.current;
      const slotIndex = slots.findIndex((slot) => slot.id === slotId);
      const slot = slots[slotIndex] || slots[0];
      if (!slot) return language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera';
      const device = availableCamerasRef.current.find((cameraDevice) => cameraDevice.deviceId === slot.deviceId);
      return (
        device?.label ||
        (slotIndex <= 0 ? (language === 'BM' ? 'Kamera Laptop' : 'Laptop Camera') : `Camera ${slotIndex + 1}`)
      );
    },
    [language]
  );

  const runDatabaseMatch = useCallback(
    async (
      track: ActiveTrack,
      plate: string,
      confidence: number,
      slotId: string,
      options: { commitNoCase?: boolean } = {}
    ) => {
      const commitNoCase = options.commitNoCase ?? true;
      const normalizedPlate = cleanPlateNumber(plate);
      const cooldownMs = settingsRef.current.duplicateCooldown * 1000;
      const now = Date.now();
      const lastSearch = cooldownMap.current.get(normalizedPlate) ?? 0;
      const trackSearchThrottleMs = commitNoCase ? 0 : 1000;

      if (commitNoCase && now - lastSearch < cooldownMs) {
        track.ocrState = 'COOLDOWN';
        track.pipelineState = 'COOLDOWN';
        track.cooldownActive = true;
        track.cooldownStartedAt = now;
        runtimeMetricsRef.current.duplicateOcrSkippedCount++;
        return;
      }

      if (trackSearchThrottleMs > 0 && track.lastSearchedAt && now - track.lastSearchedAt < trackSearchThrottleMs) {
        return;
      }

      track.lastSearchedAt = now;
      track.ocrState = 'DB_CHECKING';
      track.pipelineState = 'CONSENSUS';

      const vehicleCases = vehiclesRef.current.map(mapVehicleToCase);
      const evaluation = evaluateDatabaseMatch(
        normalizedPlate,
        confidence,
        vehicleCases,
        undefined,
        Math.min(settingsRef.current.recognitionThreshold, 0.6)
      );
      const matchedVehicle =
        evaluation.matchedVehicle ? vehiclesRef.current.find((vehicle) => vehicle.id === evaluation.matchedVehicle?.id) || null : null;
      const possibleVehicles = evaluation.possibleMatches
        .map((possibleVehicle) => vehiclesRef.current.find((vehicle) => vehicle.id === possibleVehicle.id) || null)
        .filter((vehicle): vehicle is Vehicle => Boolean(vehicle));

      if (evaluation.matchType === 'INSUFFICIENT_CONFIDENCE') {
        track.ocrState = 'CONSENSUS_BUILDING';
        track.pipelineState = 'CONSENSUS';
        return;
      }

      const resolvedMatchType =
        evaluation.matchType === 'EXACT' && matchedVehicle
          ? 'EXACT'
          : evaluation.matchType === 'POSSIBLE' && possibleVehicles.length > 0
          ? 'POSSIBLE'
          : 'NONE';
      const resolvedPlate =
        resolvedMatchType === 'POSSIBLE' && possibleVehicles.length === 1
          ? cleanPlateNumber(possibleVehicles[0].plate)
          : cleanPlateNumber(evaluation.normalizedPlate || normalizedPlate);
      const recoveredRepeatedOmission =
        resolvedMatchType === 'EXACT' &&
        Boolean(matchedVehicle) &&
        resolvedPlate !== normalizedPlate &&
        isRepeatedCharacterOmission(normalizedPlate, resolvedPlate);
      const resolvedConfidence = Math.max(confidence, evaluation.confidence);

      if (recoveredRepeatedOmission) {
        promoteCorrectedOcrVote(track, normalizedPlate, resolvedPlate, resolvedConfidence);
      }

      if (!commitNoCase && resolvedMatchType === 'NONE') {
        track.ocrState = 'CONSENSUS_BUILDING';
        track.pipelineState = 'CONSENSUS';
        return;
      }

      const finalLockMinConfidence = getDatabaseFinalLockMinConfidence(
        resolvedMatchType,
        recoveredRepeatedOmission,
        commitNoCase,
        settingsRef.current.recognitionThreshold
      );

      if (resolvedConfidence < finalLockMinConfidence) {
        track.ocrState = 'CONSENSUS_BUILDING';
        track.pipelineState = 'CONSENSUS';
        track.matchType = undefined;
        track.matchedVehicle = undefined;
        track.possibleMatchVehicles = undefined;
        track.scanEventId = undefined;
        track.cooldownActive = false;
        track.cooldownStartedAt = undefined;
        if (!recoveredRepeatedOmission) {
          track.stabilizedPlate = undefined;
          track.stabilizedConfidence = undefined;
        }
        return;
      }

      const shouldSuppressResolvedDuplicate = resolvedMatchType !== 'NONE' || commitNoCase;
      const resolvedLastSearch = cooldownMap.current.get(resolvedPlate) ?? 0;
      if (shouldSuppressResolvedDuplicate && now - resolvedLastSearch < cooldownMs) {
        track.ocrState = 'COOLDOWN';
        track.pipelineState = 'COOLDOWN';
        track.cooldownActive = true;
        track.cooldownStartedAt = now;
        runtimeMetricsRef.current.duplicateOcrSkippedCount++;
        return;
      }

      cooldownMap.current.set(resolvedPlate, now);
      track.stabilizedPlate = resolvedPlate;
      track.stabilizedConfidence = resolvedConfidence;

      const timestamp = new Date();
      const scanCameraName = getCameraSlotLabelFromRefs(slotId);
      const scanLocation = SCAN_LOCATIONS[Math.floor(Math.random() * SCAN_LOCATIONS.length)];
      const confidencePercent = Number((confidence * 100).toFixed(1));
      const detectionId = `det-${timestamp.getTime()}-${Math.floor(Math.random() * 1000)}`;
      const newDetection: SessionDetection = {
        id: detectionId,
        plate: resolvedPlate,
        confidence: confidencePercent,
        matched: resolvedMatchType === 'EXACT',
        vehicleId: matchedVehicle?.id,
        timestamp: timestamp.toLocaleTimeString('en-GB'),
        cameraId: slotId || 'laptop-camera',
        cameraName: scanCameraName,
        name: scanLocation.name,
        gps: scanLocation.gps,
        matchType: resolvedMatchType,
        possibleVehicleIds: possibleVehicles.map((vehicle) => vehicle.id),
      };

      setCurrentPlate(resolvedPlate);
      setLastDetectedSlotId(slotId);
      setLiveDetections((prevStream) => {
        const nextStream = [newDetection, ...prevStream.slice(0, 7)];
        localStorage.setItem(RECENT_DETECTIONS_STORAGE_KEY, JSON.stringify(nextStream));
        return nextStream;
      });

      addHistoryLogRef.current({
        type: 'DETECTION',
        action:
          resolvedMatchType === 'EXACT'
            ? `Tanda Tindakan (Pengimbas): ${resolvedPlate}`
            : resolvedMatchType === 'POSSIBLE'
            ? `Possible Match (Pengimbas): ${resolvedPlate}`
            : `Live Scan: ${resolvedPlate}`,
        plate: resolvedPlate,
        details:
          resolvedMatchType === 'EXACT' && matchedVehicle
            ? `AI Confidence: ${confidencePercent}% - Tanda Tindakan: ${matchedVehicle.brand} ${matchedVehicle.model} - Location: ${scanLocation.name} (${scanLocation.gps})`
            : resolvedMatchType === 'POSSIBLE'
            ? `AI Confidence: ${confidencePercent}% - Possible Match: ${possibleVehicles
                .map((vehicle) => vehicle.plate)
                .join(', ')} - Location: ${scanLocation.name} (${scanLocation.gps})`
            : `AI Confidence: ${confidencePercent}% - No Match Found - Location: ${scanLocation.name} (${scanLocation.gps})`,
        note:
          resolvedMatchType === 'EXACT' && matchedVehicle
            ? `Match Found: ${matchedVehicle.brand} ${matchedVehicle.model} via ${scanCameraName} at ${scanLocation.name}`
            : resolvedMatchType === 'POSSIBLE'
            ? `Possible match from ${scanCameraName}: ${possibleVehicles.map((vehicle) => vehicle.plate).join(', ')}`
            : `No match from ${scanCameraName} at ${scanLocation.name}`,
        cameraId: slotId || 'laptop-camera',
        cameraName: scanCameraName,
        userRole: role,
        statusMatch: resolvedMatchType,
      });

      const completedAt = Date.now();
      const startedAt = track.stats?.startedAt ?? completedAt;
      const consensusCount = Array.from(track.votes.values()).reduce((sum, vote) => sum + vote.count, 0);
      const processingTimeMs = Math.max(0, completedAt - startedAt);
      runtimeMetricsRef.current.completedTrackCount++;
      runtimeMetricsRef.current.trackLifetimeTotalMs += processingTimeMs;
      if (track.stats) {
        track.stats.finishedAt = completedAt;
        track.stats.finalConfidence = confidence;
      }
      completedTrackEventsRef.current.unshift({
        id: detectionId,
        trackId: track.trackId,
        cameraId: slotId || 'laptop-camera',
        cameraName: scanCameraName,
        plate: resolvedPlate,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(completedAt).toISOString(),
        durationMs: processingTimeMs,
        detectorConfidence: Math.round((track.bbox.confidence ?? 0) * 100) / 100,
        detectorLatencyMs: track.stats?.lastDetectorLatencyMs ?? Math.round(runtimeMetricsRef.current.detectorLatencySamples > 0
          ? runtimeMetricsRef.current.detectorLatencyTotalMs / runtimeMetricsRef.current.detectorLatencySamples
          : 0),
        trackConfidence: Math.round((track.trackConfidence ?? 0) * 100) / 100,
        confidenceComponents: track.confidenceComponents,
        ocrConfidence: Math.round(confidence * 100) / 100,
        ocrLatencyMs: track.stats?.lastOcrLatencyMs ?? Math.round(runtimeMetricsRef.current.ocrLatencySamples > 0
          ? runtimeMetricsRef.current.ocrLatencyTotalMs / runtimeMetricsRef.current.ocrLatencySamples
          : 0),
        consensusCount,
        matchType: resolvedMatchType,
        motionLevel: getMotionOcrMode(track),
        cropQuality: Math.round((track.stats?.bestCropQuality ?? 0) * 100) / 100,
        processingTimeMs,
        reasonForCompletion:
          resolvedMatchType === 'EXACT'
            ? 'DATABASE_EXACT_MATCH'
            : resolvedMatchType === 'POSSIBLE'
            ? 'DATABASE_POSSIBLE_MATCH'
            : 'DATABASE_NO_MATCH',
        deviceTier: runtimeMetricsRef.current.deviceTier,
        environment: runtimeMetricsRef.current.currentEnvironment,
        environmentConfidence: runtimeMetricsRef.current.currentEnvironmentConfidence,
        qualityClass: runtimeMetricsRef.current.currentQuality,
        qualityConfidence: runtimeMetricsRef.current.currentQualityConfidence,
      });
      if (completedTrackEventsRef.current.length > 50) {
        completedTrackEventsRef.current.length = 50;
      }

      track.matchType = resolvedMatchType;
      track.matchedVehicle = matchedVehicle ?? undefined;
      track.possibleMatchVehicles = possibleVehicles;
      track.ocrState =
        resolvedMatchType === 'EXACT' ? 'MATCHED' : resolvedMatchType === 'POSSIBLE' ? 'POSSIBLE MATCH' : 'NO CASE';
      track.pipelineState = resolvedMatchType === 'EXACT' ? 'MATCHED' : 'COOLDOWN';
      track.scanEventId = detectionId;

      if (resolvedMatchType === 'EXACT' && matchedVehicle) {
        const alertSlotId = slotId || 'laptop-camera';
        setActiveAlertMatchesBySlot((prev) => ({
          ...prev,
          [alertSlotId]: { vehicle: matchedVehicle, cameraName: scanCameraName, cameraId: alertSlotId },
        }));
        playAlertChime();
      }

      track.ocrState = 'COOLDOWN';
      track.pipelineState = 'COOLDOWN';
      track.cooldownActive = true;
      track.cooldownStartedAt = Date.now();
    },
    [getCameraSlotLabelFromRefs, role]
  );

  const queueEnvironmentSample = useCallback(
    (sourceCanvas: HTMLCanvasElement, cameraFpsEstimate: number) => {
      if (environmentInferenceRunningRef.current || sourceCanvas.width === 0 || sourceCanvas.height === 0) return;

      environmentInferenceRunningRef.current = true;
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = sourceCanvas.width;
      sampleCanvas.height = sourceCanvas.height;
      const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
      if (!sampleCtx) {
        environmentInferenceRunningRef.current = false;
        return;
      }

      sampleCtx.drawImage(sourceCanvas, 0, 0);

      void (async () => {
        try {
          const profile = await classifyEnvironment(sampleCanvas, environmentStatsRef.current);
          const shouldAdapt = isEnvironmentProfileActionable(profile);
          environmentStatsRef.current = profile.stats;

          const metrics = runtimeMetricsRef.current;
          metrics.environmentDistribution = incrementDistribution(metrics.environmentDistribution, profile.label);
          metrics.cameraHealth = createCameraHealthSnapshot(
            profile.stats,
            cameraFpsEstimate,
            metrics.droppedFrameCount
          );

          if (shouldAdapt) {
            environmentProfileRef.current = profile;
            const nextConfig = createAdaptiveScannerConfig(profile);
            adaptiveConfigRef.current = nextConfig;

            metrics.currentEnvironment = profile.label;
            metrics.currentEnvironmentConfidence = profile.confidence;
            metrics.currentEnvironmentSource = profile.source;

            setEnvironmentProfile(profile);
            setAdaptiveConfigSnapshot(nextConfig);

            Object.values(slotRuntimesRef.current).forEach((runtime) => {
              runtime.bestFrameSelector.configure({
                maxBufferSize: nextConfig.buffer.maxSize,
                maxEntryAgeMs: nextConfig.buffer.maxEntryAgeMs,
              });
            });

            void applyActiveCameraConstraints();
          } else {
            const activeProfile = environmentProfileRef.current;
            metrics.currentEnvironment = activeProfile.label;
            metrics.currentEnvironmentConfidence = activeProfile.confidence;
            metrics.currentEnvironmentSource = activeProfile.source;
          }
        } catch (err) {
          console.warn('[Scanner] Environment classifier failed:', err);
        } finally {
          releaseCanvasMemory(sampleCanvas);
          environmentInferenceRunningRef.current = false;
        }
      })();
    },
    [applyActiveCameraConstraints]
  );

  const collectDatasetSample = useCallback(
    (args: {
      sourceCanvas: HTMLCanvasElement;
      cropCanvas: HTMLCanvasElement;
      sourceSlotId: string;
      environment: EnvironmentClass;
      environmentConfidence: number;
      qualityClass: PlateQualityClass;
      qualityConfidence: number;
      qualityScore: number;
      qualityBackend: PlateQualityAssessment['backend'];
      qualityRejectionReasons: string[];
      selectedPreprocessing: string[];
      ocrResult: string;
      ocrConfidence: number;
      detectorConfidence: number;
      trackConfidence: number;
    }) => {
      if (!datasetModeRef.current) return;

      const timestamp = new Date().toISOString();
      const id = `sample-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const folderPath = `dataset/${args.environment.toLowerCase()}/${args.qualityClass.toLowerCase()}/${id}`;
      const sample: DatasetSample = {
        id,
        timestamp,
        folderPath,
        originalImageDataUrl: canvasToJpegDataUrl(args.sourceCanvas, 0.72),
        plateCropDataUrl: canvasToJpegDataUrl(args.cropCanvas, 0.88),
        environmentClass: args.environment,
        environmentConfidence: args.environmentConfidence,
        qualityClass: args.qualityClass,
        qualityConfidence: args.qualityConfidence,
        qualityScore: args.qualityScore,
        qualityBackend: args.qualityBackend,
        qualityRejectionReasons: args.qualityRejectionReasons,
        selectedPreprocessing: args.selectedPreprocessing,
        ocrResult: args.ocrResult,
        ocrConfidence: args.ocrConfidence,
        detectorConfidence: args.detectorConfidence,
        trackConfidence: args.trackConfidence,
        camera: cameraMetadataBySlotRef.current[args.sourceSlotId] ?? null,
      };

      datasetSamplesRef.current.unshift(sample);
      if (datasetSamplesRef.current.length > DATASET_SAMPLE_LIMIT) {
        datasetSamplesRef.current.length = DATASET_SAMPLE_LIMIT;
      }
    },
    []
  );

  useEffect(() => {
    if (!isCameraReady || !isScanning || scannerProcessingPaused) return;

    let stopped = false;
    const slotsToScan = (supportsMultiCameraScan
      ? cameraSlots
      : cameraSlots.filter((slot) => slot.id === activeCameraSlotIdRef.current)
    ).filter((slot) => previewSlotIds.includes(slot.id) && videoRefs.current[slot.id]);

    if (slotsToScan.length === 0) return;

    const cleanupRunners = slotsToScan.map((slot) => {
      const slotId = slot.id;
      const runtime = getSlotRuntime(slotId);
      const metrics = ensureSlotMetrics(slotId);
      let animId: number;
      let detectionTimeout: ReturnType<typeof setTimeout> | undefined;
      let lastVideoTime = -1;
      let lastDetectorValidationAt = 0;
      let lastEnvironmentSampleAt = 0;
      let adaptiveDetectorIntervalMs = getTierDetectorTargetMs(runtimeMetricsRef.current.deviceTier);

      const scheduleDetection = (delay = 100) => {
        if (stopped) return;
        detectionTimeout = setTimeout(runDetection, delay);
      };

      const runDetection = async () => {
        if (stopped) return;

        const video = videoRefs.current[slotId];

        if (!video) {
          scheduleDetection(150);
          return;
        }

        if (!isRuntimeScanningReady(runtimeStateRef.current)) {
          scheduleDetection(250);
          return;
        }

        if (video.readyState < 2 || video.videoWidth === 0) {
          scheduleDetection(150);
          return;
        }

        if (!runtime.processingCanvas) {
          runtime.processingCanvas = document.createElement('canvas');
        }

        const processingCanvas = runtime.processingCanvas;
        const adaptiveConfig = adaptiveConfigRef.current;
        const processingDimensions = getProcessingDimensions(
          video.videoWidth,
          video.videoHeight,
          runtimeMetricsRef.current.deviceTier,
          runtimeMetricsRef.current.adaptationLevel,
          adaptiveConfig.processing.maxLongEdge
        );
        if (processingCanvas.width !== processingDimensions.width || processingCanvas.height !== processingDimensions.height) {
          processingCanvas.width = processingDimensions.width;
          processingCanvas.height = processingDimensions.height;
        }

        const processingCtx = processingCanvas.getContext('2d', { willReadFrequently: true });
        if (!processingCtx) {
          scheduleDetection(150);
          return;
        }

        const detectionStartedAt = performance.now();
        processingCtx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
        await yieldToBrowser();

        const sampleNow = Date.now();
        if (sampleNow - lastEnvironmentSampleAt >= ENVIRONMENT_SAMPLE_INTERVAL_MS) {
          lastEnvironmentSampleAt = sampleNow;
          queueEnvironmentSample(processingCanvas, metrics.camFrames);
        }

        const scannerSettings = settingsRef.current;
        runtime.tracker.setLostTrackTimeout(
          Math.round((scannerSettings.lostTrackTimeout || INITIAL_SETTINGS.lostTrackTimeout) * adaptiveConfigRef.current.track.lifetimeMultiplier)
        );
        runtime.tracker.configureRuntime({
          maxPredictionFrames: adaptiveConfigRef.current.track.maxPredictionFrames,
          lostTrackTimeoutMs: adaptiveConfigRef.current.track.lostTrackTimeoutMs,
          unconfirmedTrackTimeoutMs: adaptiveConfigRef.current.track.unconfirmedTrackTimeoutMs,
        });
        runtime.tracker.setMaxActiveTracks(scannerSettings.maxTracks || INITIAL_SETTINGS.maxTracks);
        let detectedPlates: Awaited<ReturnType<typeof detectMalaysianPlates>> = [];

        try {
          detectedPlates = await detectMalaysianPlates(processingCanvas, {
            minConfidence: Math.max(scannerSettings.detectionThreshold, adaptiveConfigRef.current.detector.minConfidence),
            enginePreference: scannerSettings.detectorEngine,
            developerMode: scannerSettings.debugMode,
          });
        } catch (err) {
          console.warn(`[Scanner:${slotId}] Detector frame failed:`, err);
        }

        const detectorElapsedMs = performance.now() - detectionStartedAt;
        const runtimeMetrics = runtimeMetricsRef.current;
        runtimeMetrics.detectorLatencyTotalMs += detectorElapsedMs;
        runtimeMetrics.detectorLatencySamples++;
        pushBoundedMetricSample(runtimeMetrics.detectorLatencyHistoryMs, detectorElapsedMs);
        addEnvironmentDetectorSample(runtimeMetrics, runtimeMetrics.currentEnvironment, detectorElapsedMs);
        if (detectorElapsedMs > adaptiveDetectorIntervalMs * 1.5) {
          runtimeMetrics.droppedFrameCount++;
        }

        if (detectedPlates.length === 0) {
          const now = Date.now();
          if (now - lastDetectorValidationAt > DETECTOR_VALIDATION_INTERVAL_MS) {
            lastDetectorValidationAt = now;
            await validateDetector();
          }
        }

        const bboxList = detectedPlates.map((plateBox) => ({
          x: plateBox.bbox.x,
          y: plateBox.bbox.y,
          width: plateBox.bbox.width,
          height: plateBox.bbox.height,
          confidence: plateBox.confidence,
        }));

        const allTracks = runtime.tracker.updateTracks(bboxList);
        const confirmedTracks = runtime.tracker.getActiveTracks(true);
        const readableConfirmedTracks = confirmedTracks.filter(isTrackAvailableForReading);
        const displayTracks = (scannerSettings.debugMode ? allTracks : confirmedTracks).filter(isTrackDrawable);
        const loopNow = Date.now();

        confirmedTracks.forEach((track) => {
          const slotTrackKey = `${slotId}:${track.trackId}`;
          if (track.trackState === 'LOST' && !lostTrackIdsRef.current.has(slotTrackKey)) {
            lostTrackIdsRef.current.add(slotTrackKey);
            runtimeMetricsRef.current.lostTrackObservations++;
          } else if (track.trackState === 'VISIBLE' && lostTrackIdsRef.current.has(slotTrackKey)) {
            lostTrackIdsRef.current.delete(slotTrackKey);
            runtimeMetricsRef.current.reacquiredTrackCount++;
          }

          if (track.trackState === 'VISIBLE' && track.stats) {
            track.stats.lastDetectorLatencyMs = Math.round(detectorElapsedMs);
          }

          if (track.cooldownActive && !track.cooldownStartedAt) {
            track.cooldownStartedAt = loopNow;
          }
        });

        if (loopNow - runtime.lastMaintenanceTs >= SCANNER_MAINTENANCE_INTERVAL_MS) {
          const activeTrackNumbers = new Set(allTracks.map((track) => track.trackNumber));
          runtime.bestFrameSelector.clearExcept(activeTrackNumbers);
          runtime.bestFrameSelector.pruneStale(undefined, activeTrackNumbers, loopNow);
          pruneCooldownMap(cooldownMap.current, scannerSettings.duplicateCooldown * 1000, loopNow);
          runtime.lastMaintenanceTs = loopNow;
        }

        metrics.platesVisible = bboxList.length;
        metrics.activeTracks = readableConfirmedTracks.length;
        metrics.tracks = [...displayTracks];

        const cropSampleNow = loopNow;
        confirmedTracks.forEach((track) => {
          if (!isTrackAvailableForReading(track)) return;

          if (
            !track.lastOverlayAngleAt ||
            cropSampleNow - track.lastOverlayAngleAt >= OVERLAY_ANGLE_SAMPLE_MS
          ) {
            track.overlayAngle = estimatePlateOverlayAngle(processingCanvas, track.bbox, track.overlayAngle ?? 0);
            track.lastOverlayAngleAt = cropSampleNow;
          }

          if (track.ocrState === 'COOLDOWN' || track.ocrState === 'MATCHED') return;
          const motionMode = getMotionOcrMode(track);
          const needsFastFirstRead = isFastFirstReadCandidate(track);
          runtimeMetricsRef.current.motionBuckets[motionMode]++;

          if (motionMode === 'PAUSED' && !needsFastFirstRead && track.bbox.confidence < 0.65) {
            track.pipelineState = 'TRACKING';
            return;
          }

          const existingCrop = runtime.bestFrameSelector.getBestCrop(track.trackNumber);
          const baseSampleInterval = getTierCropSampleIntervalMs(
            track.bbox.confidence >= 0.7 ? CROP_SAMPLE_FAST_MS : CROP_SAMPLE_NORMAL_MS,
            runtimeMetricsRef.current.deviceTier
          );
          const sampleInterval = getMotionAwareCropSampleIntervalMs(track, baseSampleInterval, adaptiveConfigRef.current);
          if (existingCrop && track.lastCropSampledAt && cropSampleNow - track.lastCropSampledAt < sampleInterval) {
            return;
          }

          track.pipelineState = 'COLLECTING';
          const previousBestId = existingCrop?.id;
          const sourceScaleX = video.videoWidth / Math.max(1, processingCanvas.width);
          const sourceScaleY = video.videoHeight / Math.max(1, processingCanvas.height);
          const sourceBbox = scaleBoundingBox(track.bbox, sourceScaleX, sourceScaleY);
          const cropAngle = track.overlayAngle ?? 0;
          const shouldDeskewCrop = Math.abs(cropAngle) >= OCR_DESKEW_MIN_ANGLE_RAD;
          const cropCanvas = shouldDeskewCrop
            ? cropDeskewedCanvasRegionFast(video, sourceBbox, cropAngle)
            : cropCanvasRegionFast(video, sourceBbox);
          const perspectiveScore = shouldDeskewCrop
            ? Math.max(0.62, 1 - Math.abs(cropAngle) / (MAX_OVERLAY_TILT_RAD * 2.6))
            : Math.max(0, 1 - Math.abs(cropAngle) / MAX_OVERLAY_TILT_RAD);
          const cropQuality = runtime.bestFrameSelector.addCropCandidate(track.trackNumber, cropCanvas, sourceBbox, {
            trackStability: track.trackConfidence ?? 0.55,
            perspectiveScore,
          });
          const nextBestId = runtime.bestFrameSelector.getBestCrop(track.trackNumber)?.id;
          if (previousBestId && nextBestId && previousBestId !== nextBestId) {
            runtimeMetricsRef.current.bestFrameReplacementCount++;
            if (track.stats) {
              track.stats.bestFrameReplacementCount = (track.stats.bestFrameReplacementCount ?? 0) + 1;
            }
          }
          runtimeMetricsRef.current.cropQualityTotal += cropQuality.overallScore;
          runtimeMetricsRef.current.cropQualitySamples++;
          if (track.stats) {
            track.stats.bestCropQuality = Math.max(track.stats.bestCropQuality ?? 0, cropQuality.overallScore);
          }
          track.lastCropSampledAt = cropSampleNow;
        });

        processOcrQueue(readableConfirmedTracks, processingCanvas, scannerSettings, runtime, slotId);
        metrics.detFrames++;

        const motionAwareTargetMs = getMotionAwareDetectorTargetMs(
          adaptiveConfigRef.current,
          runtimeMetricsRef.current.deviceTier,
          readableConfirmedTracks
        );
        const latencyDrivenInterval = clampNumber(
          Math.round(detectorElapsedMs * 1.45),
          motionAwareTargetMs,
          Math.max(250, adaptiveConfigRef.current.detector.busyIntervalMs)
        );
        adaptiveDetectorIntervalMs = Math.round(
          adaptiveDetectorIntervalMs * 0.75 + latencyDrivenInterval * 0.25
        );
        const realtimeTrackingMode =
          adaptiveConfigRef.current.environment.label === 'HIGHWAY' ||
          adaptiveConfigRef.current.environment.label === 'TRAFFIC' ||
          readableConfirmedTracks.some((track) => (track.motionScore ?? 0) >= MOTION_UNSTABLE_MAX);
        let targetInterval = adaptiveDetectorIntervalMs;
        if (activeOcrCount.current > 0) {
          targetInterval = Math.min(
            targetInterval + 20,
            Math.max(motionAwareTargetMs, 140)
          );
        }
        const nextDelay = Math.max(
          Math.max(DETECTION_MIN_DELAY_MS, adaptiveConfigRef.current.detector.minDelayMs),
          Math.round(targetInterval - (performance.now() - detectionStartedAt))
        );
        scheduleDetection(nextDelay);
      };

      const processOcrQueue = async (
        confirmedTracks: ActiveTrack[],
        canvas: HTMLCanvasElement,
        scannerSettings: ScannerSettings,
        slotRuntime: SlotScannerRuntime,
        sourceSlotId: string
      ) => {
        const adaptiveConfig = adaptiveConfigRef.current;

        if (!isPpOcrReady()) {
          confirmedTracks.forEach((track) => {
            if (!track.cooldownActive && track.ocrState !== 'MATCHED') {
              track.ocrState = 'COLLECTING';
              track.pipelineState = 'COLLECTING';
            }
          });
          return;
        }

        const maxOcrConcurrency = Math.min(
          OCR_MAX_CONCURRENCY,
          getTierOcrConcurrencyLimit(runtimeMetricsRef.current.deviceTier),
          adaptiveConfig.ocr.maxConcurrency,
          Math.max(1, scannerSettings.maxOcrConcurrency || INITIAL_SETTINGS.maxOcrConcurrency)
        );
        const priorityIds = prioritiseTracks(
          confirmedTracks.map((track) => ({
            trackId: track.trackId,
            bbox: track.bbox,
            framesSeen: track.framesSeen,
            ocrState: track.ocrState,
            lastOcrAttemptAt: track.lastOcrAttemptAt,
            voteCount: getTrackVoteCount(track),
          })),
          canvas.width,
          canvas.height,
          Math.max(maxOcrConcurrency, confirmedTracks.length)
        ).sort((leftId, rightId) => {
          const leftTrack = slotRuntime.tracker.getTrack(leftId);
          const rightTrack = slotRuntime.tracker.getTrack(rightId);
          if (!leftTrack || !rightTrack) return 0;

          if (adaptiveConfig.track.prioritizeHighestConfidence) {
            const leftConfidence = (leftTrack.trackConfidence ?? 0) + (leftTrack.bbox.confidence ?? 0);
            const rightConfidence = (rightTrack.trackConfidence ?? 0) + (rightTrack.bbox.confidence ?? 0);
            if (Math.abs(leftConfidence - rightConfidence) > 0.05) return rightConfidence - leftConfidence;
          }

          const leftVotes = getTrackVoteCount(leftTrack);
          const rightVotes = getTrackVoteCount(rightTrack);
          if (leftVotes === 0 && rightVotes > 0) return -1;
          if (rightVotes === 0 && leftVotes > 0) return 1;

          const leftLastAttempt = leftTrack.lastOcrAttemptAt ?? 0;
          const rightLastAttempt = rightTrack.lastOcrAttemptAt ?? 0;
          if (Math.abs(leftLastAttempt - rightLastAttempt) > 500) {
            return leftLastAttempt - rightLastAttempt;
          }

          return 0;
        });
        const ocrQueuePressure = getOcrQueuePressure(
          priorityIds.length,
          activeOcrCount.current,
          maxOcrConcurrency
        );
        runtimeMetricsRef.current.lastOcrQueueDepth = priorityIds.length;
        runtimeMetricsRef.current.maxOcrQueueDepth = Math.max(
          runtimeMetricsRef.current.maxOcrQueueDepth,
          priorityIds.length
        );
        runtimeMetricsRef.current.tracksWaitingForBetterCrop = 0;

        for (let priorityIndex = 0; priorityIndex < priorityIds.length; priorityIndex++) {
          const trackId = priorityIds[priorityIndex];
          const track = slotRuntime.tracker.getTrack(trackId);
          if (!track || !track.isConfirmed || track.cooldownActive) continue;
          if (track.ocrRunning || track.ocrJobQueued) {
            runtimeMetricsRef.current.duplicateOcrSkippedCount++;
            continue;
          }
          if (!isTrackAvailableForReading(track)) continue;
          if (activeOcrCount.current >= maxOcrConcurrency) break;

          const now = Date.now();
          const voteCount = getTrackVoteCount(track);
          const fastFirstRead = isFastFirstReadCandidate(track, voteCount);
          const retryDelay =
            voteCount === 0
              ? Math.max(OCR_FIRST_READ_RETRY_MS, adaptiveConfig.ocr.firstReadRetryMs)
              : Math.max(OCR_REPEAT_READ_RETRY_MS, adaptiveConfig.ocr.repeatReadRetryMs);
          if (track.lastOcrAttemptAt && now - track.lastOcrAttemptAt < retryDelay) continue;

          const motionMode = getMotionOcrMode(track);
          if (!canAttemptOcrForMotion(track, motionMode)) {
            track.ocrState = 'COLLECTING';
            track.pipelineState = motionMode === 'PAUSED' ? 'TRACKING' : 'COLLECTING';
            continue;
          }

          const configuredMinTrackConfidence =
            voteCount === 0
              ? Math.max(OCR_FIRST_READ_MIN_TRACK_CONFIDENCE, adaptiveConfig.ocr.firstReadMinTrackConfidence)
              : Math.max(OCR_MIN_TRACK_CONFIDENCE, adaptiveConfig.ocr.minTrackConfidence);
          const minTrackConfidence = fastFirstRead
            ? Math.min(configuredMinTrackConfidence, OCR_FIRST_READ_MIN_TRACK_CONFIDENCE)
            : configuredMinTrackConfidence;
          if ((track.trackConfidence ?? 0) < minTrackConfidence) {
            track.ocrState = 'COLLECTING';
            track.pipelineState = 'TRACKING';
            continue;
          }

          const minReadableWidth = Math.max(
            OCR_DEFAULT_MIN_READABLE_WIDTH,
            scannerSettings.minCropWidth || INITIAL_SETTINGS.minCropWidth
          );
          const bufferedCropCount = slotRuntime.bestFrameSelector.getCropCount(track.trackNumber);
          const requiredCropCount =
            voteCount === 0
              ? Math.max(OCR_MIN_BUFFERED_CROPS, adaptiveConfig.ocr.requiredBufferedCrops)
              : 1;
          const hasEnoughBufferedCrops = bufferedCropCount >= requiredCropCount;
          const canReadFirstFrame = track.framesSeen >= OCR_MIN_TRACK_FRAMES || fastFirstRead;

          if (
            !canReadFirstFrame ||
            !hasEnoughBufferedCrops ||
            track.bbox.width < minReadableWidth
          ) {
            track.ocrState = 'COLLECTING';
            track.pipelineState = 'COLLECTING';
            continue;
          }

          const minQualityForOcr = Math.max(
            scannerSettings.minCropQuality || INITIAL_SETTINGS.minCropQuality,
            adaptiveConfig.ocr.minQuality,
            voteCount === 0
              ? Math.max(OCR_FIRST_READ_MIN_QUALITY, adaptiveConfig.ocr.firstReadMinQuality)
              : Math.max(OCR_REPEAT_READ_MIN_QUALITY, adaptiveConfig.ocr.repeatReadMinQuality)
          );

          const candidateEntries = slotRuntime.bestFrameSelector.getTopCrops(
            track.trackNumber,
            Math.max(2, Math.min(4, adaptiveConfig.ocr.maxCandidateCrops))
          );
          if (candidateEntries.length === 0) {
            track.ocrState = 'LOW QUALITY';
            track.pipelineState = 'COLLECTING';
            runtimeMetricsRef.current.qualityOcrAvoidedCount++;
            runtimeMetricsRef.current.tracksWaitingForBetterCrop++;
            continue;
          }

          let targetCrop: HTMLCanvasElement | null = null;
          let targetCropFromBest = false;
          let modelQuality: PlateQualityAssessment | null = null;
          const maxBestCropAgeMs = Math.max(OCR_MAX_BEST_CROP_AGE_MS, adaptiveConfig.ocr.maxBestCropAgeMs);

          for (const candidate of candidateEntries) {
            const cropAgeMs = now - candidate.timestamp;
            if (voteCount === 0 && cropAgeMs > maxBestCropAgeMs) continue;

            const assessment = await classifyPlateQuality(candidate.canvas, {
              heuristicReport: candidate.quality,
              minReadableWidth,
              minQualityScore: minQualityForOcr,
              detectorConfidence: candidate.detectorConfidence,
              trackStability: candidate.trackStability,
              perspectiveScore: candidate.perspectiveScore,
              cropAgeMs,
              maxCropAgeMs: maxBestCropAgeMs,
              acceptedClasses: adaptiveConfig.qualityGate.acceptedClasses,
              marginalClasses: adaptiveConfig.qualityGate.marginalClasses,
              minimumClassifierConfidence: adaptiveConfig.qualityGate.minimumClassifierConfidence,
            });
            addQualityAssessmentSample(runtimeMetricsRef.current, assessment);
            attachQualityAssessmentToTrack(track, assessment, false);
            slotRuntime.bestFrameSelector.updateCropAssessment(track.trackNumber, candidate.id, assessment);

            if (assessment.acceptableForOCR) {
              targetCrop = candidate.canvas;
              targetCropFromBest = true;
              modelQuality = assessment;
              break;
            }

            const recovered = await recoverCorrectablePlateCrop(candidate.canvas, assessment, undefined, {
              minReadableWidth,
              minQualityScore: minQualityForOcr,
              detectorConfidence: candidate.detectorConfidence,
              trackStability: candidate.trackStability,
              perspectiveScore: candidate.perspectiveScore,
              cropAgeMs,
              maxCropAgeMs: maxBestCropAgeMs,
              minimumClassifierConfidence: adaptiveConfig.qualityGate.minimumClassifierConfidence,
            });

            if (recovered) {
              addQualityAssessmentSample(runtimeMetricsRef.current, recovered.assessment);
              runtimeMetricsRef.current.qualityCorrectableRecoveredCount++;
              targetCrop = recovered.crop;
              targetCropFromBest = false;
              modelQuality = {
                ...recovered.assessment,
                selectedPreprocessing: [recovered.variant],
              };
              break;
            }
          }

          if (!targetCrop || !modelQuality) {
            track.ocrState = 'LOW QUALITY';
            track.pipelineState = 'COLLECTING';
            runtimeMetricsRef.current.qualityOcrAvoidedCount++;
            runtimeMetricsRef.current.tracksWaitingForBetterCrop++;
            continue;
          }

          attachQualityAssessmentToTrack(track, modelQuality, false);
          const releaseRejectedTargetCrop = () => {
            if (!targetCropFromBest && targetCrop) releaseCanvasMemory(targetCrop);
          };

          if (
            shouldSkipTrackForOcrPressure(
              track,
              ocrQueuePressure,
              priorityIndex,
              maxOcrConcurrency,
              modelQuality.qualityScore
            )
          ) {
            track.ocrState = 'COLLECTING';
            track.pipelineState = 'COLLECTING';
            runtimeMetricsRef.current.ocrSkippedQueuePressureCount++;
            releaseRejectedTargetCrop();
            continue;
          }

          track.pipelineState = 'READY_FOR_OCR';
          attachQualityAssessmentToTrack(track, modelQuality, true);
          const isFirstReadAttempt = voteCount === 0;
          track.ocrRunning = true;
          track.ocrJobQueued = true;
          track.lastOcrAttemptAt = now;
          track.ocrState = 'OCR_RUNNING';
          track.pipelineState = 'READING';
          if (track.stats) track.stats.ocrAttempts++;
          runtimeMetricsRef.current.ocrAttemptCount++;
          activeOcrCount.current++;
          const ocrEnvironment = runtimeMetricsRef.current.currentEnvironment;
          const ocrEnvironmentConfidence = runtimeMetricsRef.current.currentEnvironmentConfidence;
          const ocrQualityClass = modelQuality.label;
          const ocrQualityConfidence = modelQuality.confidence;
          const ocrQualityScore = modelQuality.score;

          void (async () => {
            const ocrStartedAt = performance.now();
            const transientCanvases: HTMLCanvasElement[] = [];
            const rememberTransientCanvas = (crop?: HTMLCanvasElement | null) => {
              if (crop && !transientCanvases.includes(crop)) {
                transientCanvases.push(crop);
              }
            };

            try {
              if (!targetCropFromBest) rememberTransientCanvas(targetCrop);

              const activeTrackLoad = Math.max(1, confirmedTracks.length);
              const fastOcrPass =
                isFirstReadAttempt ||
                runtimeMetricsRef.current.deviceTier !== 'A' ||
                activeTrackLoad >= 2 ||
                adaptiveConfig.ocr.maxCandidateCrops <= 3;
              const ultraFastOcrPass =
                runtimeMetricsRef.current.deviceTier === 'D' ||
                adaptiveConfigRef.current.ocr.maxCandidateCrops <= 1;
              const innerCrops = ultraFastOcrPass
                ? []
                : (() => {
                    if (!adaptiveConfig.ocr.useInnerTextCrop) return [];
                    const innerTextCrop = createInnerPlateTextCrop(targetCrop);
                    rememberTransientCanvas(innerTextCrop);
                    return generateAdaptiveCrops(
                      innerTextCrop,
                      { x: 0, y: 0, width: innerTextCrop.width, height: innerTextCrop.height, confidence: 1 },
                      360,
                      108,
                      fastOcrPass ? ['ORIGINAL'] : adaptiveConfig.processing.preprocessingVariants.slice(0, 2)
                    );
                  })();
              innerCrops.forEach((crop) => {
                rememberTransientCanvas(crop.canvas);
                rememberTransientCanvas(crop.topLineCanvas);
                rememberTransientCanvas(crop.bottomLineCanvas);
              });

              const fullCropVariants =
                ultraFastOcrPass
                  ? (['ORIGINAL'] as const)
                : fastOcrPass
                  ? adaptiveConfig.processing.preprocessingVariants.slice(0, 2)
                : activeTrackLoad >= 3
                  ? adaptiveConfig.processing.preprocessingVariants.slice(0, 3)
                  : adaptiveConfig.processing.preprocessingVariants;
              const adaptiveCrops = generateAdaptiveCrops(
                targetCrop,
                { x: 0, y: 0, width: targetCrop.width, height: targetCrop.height, confidence: 1 },
                360,
                108,
                [...fullCropVariants]
              );
              adaptiveCrops.forEach((crop) => {
                rememberTransientCanvas(crop.canvas);
                rememberTransientCanvas(crop.topLineCanvas);
                rememberTransientCanvas(crop.bottomLineCanvas);
              });

              const maxCandidateCrops = Math.max(
                1,
                Math.min(adaptiveConfig.ocr.maxCandidateCrops, ultraFastOcrPass ? 1 : fastOcrPass ? 3 : activeTrackLoad >= 3 ? 4 : 6)
              );
              const candidateCrops = (fastOcrPass ? [...adaptiveCrops, ...innerCrops] : [...innerCrops, ...adaptiveCrops]).slice(
                0,
                maxCandidateCrops
              );
              const fallbackCrop = {
                canvas: targetCrop,
                isTwoLine: targetCrop.width / Math.max(1, targetCrop.height) < 2.3,
              };
              const expectedMinChars = getExpectedMinPlateChars(targetCrop);

              let text = '';
              let conf = 0;
              let bestScore = 0;
              let bestPatternValid = false;

              for (const crop of candidateCrops.length > 0 ? candidateCrops : [fallbackCrop]) {
                await yieldToBrowser();
                const result = await recognizePlateFromCanvas(crop.canvas, crop.isTwoLine);
                const resultText = result.normalizedPlate || result.text;
                const pattern = validateMalaysianPattern(resultText);
                const isPlausible = isPlausiblePlateCandidate(resultText, expectedMinChars, pattern.score);
                const lengthScore = Math.min(1, resultText.length / Math.max(expectedMinChars + 1, 6));
                const plausibilityPenalty = isPlausible ? 0 : 0.75;
                const score =
                  result.confidence * 0.45 +
                  pattern.score * 0.3 +
                  lengthScore * 0.2 +
                  (pattern.isValid ? 0.1 : 0) -
                  plausibilityPenalty;
                const isFullerCloseCandidate =
                  text.length > 0 &&
                  score >= bestScore - 0.025 &&
                  resultText.length > text.length &&
                  pattern.score >= validateMalaysianPattern(text).score - 0.05;

                if (resultText && isPlausible && (score > bestScore || isFullerCloseCandidate)) {
                  text = resultText;
                  conf = result.confidence;
                  bestScore = Math.max(bestScore, score);
                  bestPatternValid = pattern.isValid;
                }

                if (
                  resultText &&
                  isPlausible &&
                  result.confidence >= 0.25 &&
                  pattern.score >= 0.55 &&
                  score >= 0.58 &&
                  Math.max(result.confidence, score) >= OCR_FINAL_LOCK_MIN_CONFIDENCE
                ) {
                  break;
                }
              }

              collectDatasetSample({
                sourceCanvas: canvas,
                cropCanvas: targetCrop,
                sourceSlotId,
                environment: ocrEnvironment,
                environmentConfidence: ocrEnvironmentConfidence,
                qualityClass: ocrQualityClass,
                qualityConfidence: ocrQualityConfidence,
                qualityScore: modelQuality.qualityScore,
                qualityBackend: modelQuality.backend,
                qualityRejectionReasons: modelQuality.rejectionReasons,
                selectedPreprocessing: modelQuality.selectedPreprocessing,
                ocrResult: text,
                ocrConfidence: conf,
                detectorConfidence: track.bbox.confidence ?? 0,
                trackConfidence: track.trackConfidence ?? 0,
              });

              const updatedTrack = slotRuntime.tracker.getTrack(trackId);
              if (!updatedTrack || !isOcrResultStillUseful(updatedTrack)) return;

              if (text && conf >= 0.25) {
                addOcrVoteToTrack(updatedTrack, text, conf, modelQuality.score);
                if (updatedTrack.stats) updatedTrack.stats.ocrAccepted++;
                runtimeMetricsRef.current.ocrAcceptedCount++;
                updatedTrack.ocrState = 'CONSENSUS_BUILDING';
                updatedTrack.pipelineState = 'CONSENSUS';

                const acceptedVoteCount = getTrackVoteCount(updatedTrack);
                const { digits } = countPlateChars(text);
                const canFastMatch = bestPatternValid && digits >= (text.length >= 5 ? 2 : 1);
                const canSingleReadCommit = canCommitSingleReadOutcome(text, conf, bestScore);
                const adaptiveRecognitionThreshold = Math.max(
                  scannerSettings.recognitionThreshold,
                  adaptiveConfig.ocr.recognitionThreshold
                );
                const adaptiveConsensusVotes = Math.max(
                  scannerSettings.consensusVotes,
                  adaptiveConfig.ocr.consensusVotes
                );
                const veryStrongRead =
                  canFastMatch &&
                  (acceptedVoteCount >= 2 || canSingleReadCommit) &&
                  conf >= Math.max(0.6, adaptiveRecognitionThreshold) &&
                  bestScore >= 0.7;
                const desktopFastSingleRead =
                  fastOcrPass &&
                  adaptiveConfigRef.current.ocr.consensusVotes <= 2 &&
                  canSingleReadCommit &&
                  conf >= 0.32 &&
                  bestScore >= 0.62;
                const strongRead = canFastMatch && conf >= 0.32 && bestScore >= 0.56;
                const requiredVotes = veryStrongRead
                  ? 1
                  : desktopFastSingleRead
                    ? 1
                  : strongRead
                    ? Math.max(2, Math.min(2, adaptiveConsensusVotes))
                    : adaptiveConsensusVotes;
                const confidenceGate = veryStrongRead
                  ? Math.min(adaptiveRecognitionThreshold, 0.58)
                  : desktopFastSingleRead
                    ? Math.min(adaptiveRecognitionThreshold, 0.52)
                  : strongRead
                    ? Math.min(adaptiveRecognitionThreshold, 0.45)
                    : adaptiveRecognitionThreshold;
                if (updatedTrack.stats) updatedTrack.stats.consensusAttempts++;
                runtimeMetricsRef.current.consensusAttemptCount++;
                const consensus = evaluateConsensus(updatedTrack, requiredVotes, confidenceGate);

                if (consensus.isStabilized) {
                  const matchConfidence = Math.max(consensus.confidence, Math.min(0.98, bestScore));
                  updatedTrack.stabilizedPlate = consensus.normalizedPlate;
                  updatedTrack.stabilizedConfidence = matchConfidence;
                  const noMatchOutcomeReady = canCommitNoMatchOutcome(
                    consensus.normalizedPlate,
                    matchConfidence,
                    bestScore,
                    consensus.voteCount
                  );
                  await runDatabaseMatch(updatedTrack, consensus.normalizedPlate, matchConfidence, sourceSlotId, {
                    commitNoCase: noMatchOutcomeReady,
                  });
                } else if (canCommitQuickDatabaseOutcome(text, conf, bestScore, acceptedVoteCount)) {
                  const quickMatchConfidence = Math.max(conf, Math.min(0.98, bestScore));
                  updatedTrack.stabilizedPlate = text;
                  updatedTrack.stabilizedConfidence = quickMatchConfidence;
                  await runDatabaseMatch(updatedTrack, text, quickMatchConfidence, sourceSlotId, {
                    commitNoCase: canCommitNoMatchOutcome(text, quickMatchConfidence, bestScore, acceptedVoteCount),
                  });
                }
              } else if (updatedTrack.votes.size === 0) {
                updatedTrack.ocrState = 'COLLECTING';
                updatedTrack.pipelineState = 'COLLECTING';
              } else {
                updatedTrack.ocrState = 'CONSENSUS_BUILDING';
                updatedTrack.pipelineState = 'CONSENSUS';
              }
            } catch (err) {
              console.warn(`[OCR:${sourceSlotId}] Error:`, err);
            } finally {
              transientCanvases.forEach(releaseCanvasMemory);
              const ocrElapsedMs = performance.now() - ocrStartedAt;
              runtimeMetricsRef.current.ocrLatencyTotalMs += ocrElapsedMs;
              runtimeMetricsRef.current.ocrLatencySamples++;
              pushBoundedMetricSample(runtimeMetricsRef.current.ocrLatencyHistoryMs, ocrElapsedMs);
              addEnvironmentOcrSample(runtimeMetricsRef.current, ocrEnvironment, ocrElapsedMs, ocrQualityScore);
              const refreshedTrack = slotRuntime.tracker.getTrack(trackId);
              if (refreshedTrack) {
                refreshedTrack.ocrRunning = false;
                refreshedTrack.ocrJobQueued = false;
                refreshedTrack.lastOcrCompletedAt = Date.now();
                if (refreshedTrack.stats) {
                  refreshedTrack.stats.lastOcrLatencyMs = Math.round(ocrElapsedMs);
                }
                if (refreshedTrack.pipelineState === 'READING' && !refreshedTrack.cooldownActive) {
                  refreshedTrack.pipelineState = isTrackAvailableForReading(refreshedTrack) ? 'COLLECTING' : 'TRACKING';
                }
              }
              activeOcrCount.current = Math.max(0, activeOcrCount.current - 1);
            }
          })();
        }
      };

      const renderLoop = () => {
        const video = videoRefs.current[slotId];
        const overlayCanvas = canvasRefs.current[slotId];

        if (video && overlayCanvas && video.readyState >= 2 && video.videoWidth > 0) {
          const overlayDimensions = runtime.processingCanvas?.width
            ? { width: runtime.processingCanvas.width, height: runtime.processingCanvas.height }
            : getProcessingDimensions(
                video.videoWidth,
                video.videoHeight,
                runtimeMetricsRef.current.deviceTier,
                runtimeMetricsRef.current.adaptationLevel,
                adaptiveConfigRef.current.processing.maxLongEdge
              );
          if (overlayCanvas.width !== overlayDimensions.width || overlayCanvas.height !== overlayDimensions.height) {
            overlayCanvas.width = overlayDimensions.width;
            overlayCanvas.height = overlayDimensions.height;
          }

          const overlayCtx = overlayCanvas.getContext('2d');
          if (overlayCtx) {
            overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            const scannerSettings = settingsRef.current;
            const displayTracks = (scannerSettings.debugMode
              ? runtime.tracker.getActiveTracks(false)
              : runtime.tracker.getActiveTracks(true)).filter(isTrackDrawable);
            drawOverlays(
              overlayCtx,
              overlayCanvas.width,
              overlayCanvas.height,
              displayTracks,
              scannerSettings.debugMode
            );
          }

          if (video.currentTime !== lastVideoTime) {
            metrics.camFrames++;
            lastVideoTime = video.currentTime;
          }
        }

        const now = Date.now();
        if (now - lastMetricsFlushTs.current >= SCANNER_UI_FLUSH_INTERVAL_MS) {
          lastMetricsFlushTs.current = now;
          flushScannerMetrics();
        }

        animId = requestAnimationFrame(renderLoop);
      };

      animId = requestAnimationFrame(renderLoop);
      scheduleDetection(100);

      return () => {
        cancelAnimationFrame(animId);
        if (detectionTimeout) clearTimeout(detectionTimeout);
        metrics.platesVisible = 0;
        metrics.activeTracks = 0;
        metrics.tracks = [];
      };
    });

    return () => {
      stopped = true;
      cleanupRunners.forEach((cleanup) => cleanup());
      flushScannerMetrics();
    };
  }, [
    cameraSlots,
    collectDatasetSample,
    ensureSlotMetrics,
    flushScannerMetrics,
    getSlotRuntime,
    isCameraReady,
    isScanning,
    previewSlotIds,
    queueEnvironmentSample,
    runDatabaseMatch,
    scannerProcessingPaused,
    supportsMultiCameraScan,
  ]);

  function drawOverlays(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    tracks: ActiveTrack[],
    showGuide: boolean
  ) {
    if (showGuide) {
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      const guideWidth = width * 0.6;
      const guideHeight = guideWidth / 4;
      ctx.strokeRect((width - guideWidth) / 2, (height - guideHeight) / 2, guideWidth, guideHeight);
      ctx.setLineDash([]);
    }

    tracks.forEach((track) => {
      const { x, y, width: boxWidth, height: boxHeight } = track.smoothBbox;
      const color = getTrackColor(track);
      const plateText = getTrackPlateText(track);
      const label = plateText || (track.matchType ? getTrackStatusLabel(track) : '');
      const angle = track.overlayAngle ?? 0;

      // Do not draw persistent unconfirmed boxes on non-plates / background noise
      if (!label && (track.framesSeen >= 3 || (track.bbox.confidence ?? 0) < 0.65)) {
        return;
      }
      const cx = x + boxWidth / 2;
      const cy = y + boxHeight / 2;
      const drawWidth = boxWidth * 1.02;
      const drawHeight = boxHeight * 1.08;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      drawRoundedRect(ctx, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight, 7);
      ctx.stroke();
      ctx.restore();

      if (!label) return;

      ctx.save();
      ctx.font = 'bold 14px sans-serif';
      const textWidth = ctx.measureText(label).width;
      const pillWidth = Math.max(56, textWidth + 18);
      const pillHeight = 26;
      const normalX = Math.sin(angle);
      const normalY = -Math.cos(angle);
      const pillCx = clampNumber(cx + normalX * (drawHeight / 2 + pillHeight / 2 + 6), pillWidth / 2 + 2, width - pillWidth / 2 - 2);
      const pillCy = clampNumber(cy + normalY * (drawHeight / 2 + pillHeight / 2 + 6), pillHeight / 2 + 2, height - pillHeight / 2 - 2);
      const pillX = pillCx - pillWidth / 2;
      const pillY = pillCy - pillHeight / 2;

      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = color;
      ctx.beginPath();
      drawRoundedRect(ctx, pillX, pillY, pillWidth, pillHeight, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = track.matchType === 'EXACT' ? '#ffffff' : '#020617';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pillCx, pillCy);
      ctx.restore();

      if (showGuide) {
        const debugLines = [
          `Q ${track.qualityClass ?? 'WAIT'} ${Math.round((track.qualityConfidence ?? 0) * 100)}% score ${Math.round((track.qualityScore ?? 0) * 100)}%`,
          `engine ${track.qualityBackend ?? getPlateQualityBackend()} ${track.qualityAcceptedForOcr ? 'ACCEPT' : 'WAIT'}`,
          `crop ${track.qualityCropSize ? `${track.qualityCropSize.width}x${track.qualityCropSize.height}` : '-'} sharp ${Math.round((track.qualitySharpness ?? 0) * 100)}%`,
          `prep ${(track.qualitySelectedPreprocessing ?? ['ORIGINAL']).join(',')} submitted ${track.qualitySubmittedToOcr ? 'YES' : 'NO'}`,
          track.qualityRejectionReasons?.length ? `reason ${track.qualityRejectionReasons.slice(0, 2).join(',')}` : '',
        ].filter(Boolean);
        const lineHeight = 13;
        const panelWidth = Math.min(width - 8, Math.max(180, ...debugLines.map((line) => ctx.measureText(line).width + 12)));
        const panelHeight = debugLines.length * lineHeight + 8;
        const panelX = clampNumber(x, 4, Math.max(4, width - panelWidth - 4));
        const panelY = clampNumber(y + boxHeight + 8, 4, Math.max(4, height - panelHeight - 4));

        ctx.save();
        ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        drawRoundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 5);
        ctx.fill();
        ctx.stroke();
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#cffafe';
        debugLines.forEach((line, index) => {
          ctx.fillText(line, panelX + 6, panelY + 5 + index * lineHeight);
        });
        ctx.restore();
      }
    });
  }

  const handleMarkAsSeen = (slotId: string) => {
    const activeAlertMatch = activeAlertMatchesBySlot[slotId];
    if (activeAlertMatch) {
      const flaggedObj = { ...activeAlertMatch.vehicle, status: 'FLAGGED' as const };
      updateVehicle(flaggedObj);
      addHistoryLog({
        type: 'DETECTION',
        action: `Tanda Tindakan (Disemak): ${activeAlertMatch.vehicle.plate}`,
        plate: activeAlertMatch.vehicle.plate,
        details: `Alert Tanda Tindakan disemak oleh ${role} pada ${activeAlertMatch.cameraName}`,
        note: `Ditanda Tindakan oleh ${role} pada ${activeAlertMatch.cameraName}`,
        cameraId: activeAlertMatch.cameraId,
        cameraName: activeAlertMatch.cameraName,
        userRole: role,
        statusMatch: 'EXACT',
      });
    }
    setActiveAlertMatchesBySlot((alerts) => {
      if (!alerts[slotId]) return alerts;
      const nextAlerts = { ...alerts };
      delete nextAlerts[slotId];
      return nextAlerts;
    });
  };

  const handleExportScannerMetrics = () => {
    if (!canUseDiagnostics) return;
    const snapshot = createMetricsSnapshot(runtimeMetricsRef.current, tracksList);
    const health = createSystemHealthSnapshot(snapshot, detFps, camFps);
    const payload = {
      exportedAt: new Date().toISOString(),
      device: typeof navigator !== 'undefined'
        ? {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
          }
        : null,
      benchmark: benchmarkResult,
      performanceTargets: SCANNER_PERFORMANCE_TARGETS,
      health,
      metrics: snapshot,
      environment: {
        current: snapshot.currentEnvironment,
        confidence: snapshot.currentEnvironmentConfidence,
        source: snapshot.currentEnvironmentSource,
        modelStatus: getEnvironmentModelStatus(),
        distributionPercent: serializeDistributionPercentages(snapshot.environmentDistribution),
        perEnvironmentStats: snapshot.environmentStats,
      },
      quality: {
        current: snapshot.currentQuality,
        confidence: snapshot.currentQualityConfidence,
        backend: snapshot.currentQualityBackend,
        engine: getPlateQualityEngineLabel(),
        modelStatus: getPlateQualityModelStatus(),
        latencyAvgMs: snapshot.qualityLatencyAvgMs,
        latencyP95Ms: snapshot.qualityLatencyP95Ms,
        acceptedCrops: snapshot.qualityAcceptedCropCount,
        rejectedCrops: snapshot.qualityRejectedCropCount,
        rejectionReasons: snapshot.qualityRejectionReasons,
        ocrAvoided: snapshot.qualityOcrAvoidedCount,
        correctableRecovered: snapshot.qualityCorrectableRecoveredCount,
        heuristicUsage: snapshot.heuristicQualityUsageCount,
        onnxUsage: snapshot.onnxQualityUsageCount,
        distributionPercent: serializeDistributionPercentages(snapshot.qualityDistribution),
      },
      camera: {
        selectedSlotId: activeCameraSlotIdRef.current,
        metadataBySlot: cameraMetadataBySlotRef.current,
        health: snapshot.cameraHealth,
      },
      runtimeConfig: {
        executionMode: snapshot.executionMode,
        cameraProfile: snapshot.cameraProfile,
        processingProfile: snapshot.processingProfile,
        ocrProfile: snapshot.ocrProfile,
        baseDeviceTier: snapshot.baseDeviceTier,
        activeDeviceTier: snapshot.deviceTier,
        adaptationLevel: snapshot.adaptationLevel,
        performanceMode: snapshot.performanceMode,
        performanceModeReason: snapshot.performanceModeReason,
        detectorTargetMs: getTierDetectorTargetMs(snapshot.deviceTier),
        detectorBusyIntervalMs: getTierDetectorBusyIntervalMs(snapshot.deviceTier),
        adaptiveConfig: adaptiveConfigRef.current,
        supportedDesktopBrowser: isSupportedDesktopScannerBrowser(),
      },
      detectorMetrics: {
        medianLatencyMs: snapshot.detectorLatencyMedianMs,
        p95LatencyMs: snapshot.detectorLatencyP95Ms,
        averageLatencyMs: snapshot.detectorLatencyAvgMs,
        fps: detFps,
        frames: snapshot.detectorLatencySamples,
      },
      ocrMetrics: {
        medianLatencyMs: snapshot.ocrLatencyMedianMs,
        p95LatencyMs: snapshot.ocrLatencyP95Ms,
        averageLatencyMs: snapshot.ocrLatencyAvgMs,
        attempts: snapshot.ocrAttemptCount,
        accepted: snapshot.ocrAcceptedCount,
        duplicateRate: snapshot.duplicateOcrRate,
        queuePressureSkips: snapshot.ocrSkippedQueuePressureCount,
      },
      databaseMetrics: {
        completedEvents: completedTrackEventsRef.current.length,
        falseExactMatches: snapshot.falseAlertCount,
        exactMatches: completedTrackEventsRef.current.filter((event) => event.matchType === 'EXACT').length,
        possibleMatches: completedTrackEventsRef.current.filter((event) => event.matchType === 'POSSIBLE').length,
        noMatches: completedTrackEventsRef.current.filter((event) => event.matchType === 'NONE').length,
      },
      completedTrackEvents: completedTrackEventsRef.current,
      activeTracks: tracksList.map((track) => ({
        trackId: track.trackId,
        state: track.trackState,
        pipelineState: track.pipelineState,
        framesSeen: track.framesSeen,
        missedFrames: track.missedFrames ?? 0,
        motionScore: track.motionScore ?? 0,
        trackConfidence: track.trackConfidence ?? 0,
        confidenceComponents: track.confidenceComponents,
        quality: {
          className: track.qualityClass,
          confidence: track.qualityConfidence,
          score: track.qualityScore,
          backend: track.qualityBackend,
          acceptedForOcr: track.qualityAcceptedForOcr,
          rejectionReasons: track.qualityRejectionReasons,
          cropSize: track.qualityCropSize,
          sharpness: track.qualitySharpness,
          selectedPreprocessing: track.qualitySelectedPreprocessing,
          submittedToOcr: track.qualitySubmittedToOcr,
        },
        stats: track.stats,
        currentPlate: getTrackPlateText(track),
      })),
    };

    downloadJson(`track_scanner_metrics_${Date.now()}.json`, payload);
  };

  const handleExportDataset = () => {
    if (!canUseDiagnostics) return;
    const samples = datasetSamplesRef.current;
    const yoloDataset = samples.map((sample) => ({
      imagePath: `${sample.folderPath}/original.jpg`,
      cropPath: `${sample.folderPath}/plate_crop.jpg`,
      label: 'license-plate',
      detectorConfidence: sample.detectorConfidence,
      environmentClass: sample.environmentClass,
      camera: sample.camera,
      timestamp: sample.timestamp,
    }));
    const ocrDataset = samples.map((sample) => ({
      imagePath: `${sample.folderPath}/plate_crop.jpg`,
      text: sample.ocrResult,
      confidence: sample.ocrConfidence,
      qualityClass: sample.qualityClass,
      qualityScore: sample.qualityScore,
      qualityBackend: sample.qualityBackend,
      selectedPreprocessing: sample.selectedPreprocessing,
      environmentClass: sample.environmentClass,
      timestamp: sample.timestamp,
    }));
    const classificationDataset = samples.flatMap((sample) => [
      {
        imagePath: `${sample.folderPath}/original.jpg`,
        task: 'environment',
        className: sample.environmentClass,
        confidence: sample.environmentConfidence,
      },
      {
        imagePath: `${sample.folderPath}/plate_crop.jpg`,
        task: 'plate_quality',
        className: sample.qualityClass,
        confidence: sample.qualityConfidence,
        qualityScore: sample.qualityScore,
        backend: sample.qualityBackend,
        rejectionReasons: sample.qualityRejectionReasons,
      },
    ]);

    downloadJson(`track_dataset_export_${Date.now()}.json`, {
      exportedAt: new Date().toISOString(),
      schemaVersion: 2,
      sampleCount: samples.length,
      qualityTask: createPlateQualityDatasetSchema(),
      folderStructure: samples.map((sample) => sample.folderPath),
      yoloDataset,
      ocrDataset,
      classificationDataset,
      samples,
    });
  };

  const runtimeReady = isRuntimeScanningReady(runtimeState);
  const scannerReloadActive = Boolean(scannerReloadNotice?.isReloading);
  const scannerReloadComplete = Boolean(scannerReloadNotice && !scannerReloadNotice.isReloading);
  const scannerNoticeMode = scannerReloadNotice?.mode ?? 'RELOADING';
  const scannerNoticeStarting = scannerReloadActive && scannerNoticeMode === 'STARTING';
  const scannerNoticeTitle = scannerNoticeStarting
    ? language === 'BM'
      ? 'Kamera dimulakan'
      : 'Camera initializing'
    : scannerReloadActive
    ? language === 'BM'
      ? 'Pengimbas dimuat semula'
      : 'Scanner reloading'
    : scannerNoticeMode === 'STARTING'
    ? language === 'BM'
      ? 'Kamera sedia'
      : 'Camera ready'
    : language === 'BM'
    ? 'Pengimbas disegar'
    : 'Scanner refreshed';
  const scannerNoticeBody = scannerReloadActive
    ? scannerNoticeMode === 'STARTING'
      ? language === 'BM'
        ? 'Kamera dibuka semula dan distabilkan sebelum imbasan bermula.'
        : 'Opening a fresh camera stream and letting it settle before scanning.'
      : language === 'BM'
      ? 'Kamera disambung semula kerana prestasi atau sambungan perlu disegar.'
      : 'Refreshing the camera because performance or stream health needed a reset.'
    : language === 'BM'
    ? 'Imbasan disambung semula.'
    : 'Scanning has resumed.';
  const scannerControlBusy = scannerReloadActive || scannerProcessingPaused;
  const visibleTrack = tracksList.find((track) => getTrackPlateText(track)) || tracksList[0] || null;
  const activeScanTileCount = supportsMultiCameraScan
    ? cameraSlots.filter((slot) => previewSlotIds.includes(slot.id)).length
    : previewSlotIds.includes(activeCameraSlotId)
      ? 1
      : 0;
  const scannerStatusText = scannerReloadActive
    ? scannerNoticeMode === 'STARTING'
      ? 'Camera initializing - scanning starts after stream settles'
      : 'Scanner reloading - camera stream is being refreshed'
    : scannerReloadComplete
    ? scannerNoticeMode === 'STARTING'
      ? 'Camera ready and scanning started'
      : 'Scanner refreshed and scanning resumed'
    : cameraError
    ? 'Camera unavailable'
    : isScanning && runtimeReady && supportsMultiCameraScan
    ? `Scanning ${activeScanTileCount || 1} camera${(activeScanTileCount || 1) === 1 ? '' : 's'}${visibleTrack ? ` - ${getTrackStatusLabel(visibleTrack)}` : ''}`
    : isScanning && runtimeReady
    ? `Scanning selected camera${visibleTrack ? ` - ${getTrackStatusLabel(visibleTrack)}` : ''}`
    : isScanning
    ? 'AI models warming up'
    : previewSlotIds.length > 0
    ? 'Camera preview ready'
    : 'Choose camera in preview and start scanning';
  const latestDetection = liveDetections[0] || null;
  const latestExactVehicle =
    latestDetection?.vehicleId ? vehicles.find((vehicle) => vehicle.id === latestDetection.vehicleId) || null : null;
  const latestSearchHref = latestDetection ? `/search?plate=${encodeURIComponent(latestDetection.plate)}` : '/search';
  const latestResultTone =
    latestDetection?.matchType === 'EXACT' || latestDetection?.matched
      ? 'EXACT'
      : latestDetection?.matchType === 'POSSIBLE'
      ? 'POSSIBLE'
      : latestDetection
      ? 'NONE'
      : null;

  const showDeveloperOverlay = effectiveDeveloperMode;
  const showUnsupportedBrowserWarning = typeof navigator !== 'undefined' && !isSupportedDesktopScannerBrowser();
  const activeCameraMetadata = cameraMetadataBySlot[activeCameraSlotId];
  const environmentDistributionPercent = serializeDistributionPercentages(runtimeMetricsSnapshot.environmentDistribution);
  const qualityDistributionPercent = serializeDistributionPercentages(runtimeMetricsSnapshot.qualityDistribution);
  const activeCameraLabel = activeCameraMetadata?.label || getCameraSlotLabel(cameraSlots[0], 0);
  const simpleScannerStatus = cameraError
    ? language === 'BM'
      ? 'Kamera perlu disemak'
      : 'Camera needs attention'
    : scannerReloadActive
    ? scannerNoticeTitle
    : scannerReloadComplete
    ? scannerNoticeTitle
    : isScanning && runtimeReady
    ? language === 'BM'
      ? 'Sedang mengimbas'
      : 'Scanning'
    : isScanning
    ? language === 'BM'
      ? 'Memulakan pengimbas'
      : 'Starting scanner'
    : previewSlotIds.length > 0
    ? language === 'BM'
      ? 'Pratonton sedia'
      : 'Preview ready'
    : language === 'BM'
    ? 'Pilih kamera'
    : 'Choose camera';
  const simpleScannerHint = cameraError
    ? cameraError
    : scannerReloadActive
    ? scannerNoticeBody
    : scannerReloadComplete
    ? language === 'BM'
      ? `${scannerReloadNotice?.reason || 'Pengimbas disegar'}; imbasan disambung semula.`
      : `${scannerReloadNotice?.reason || 'Scanner refreshed'}; scanning has resumed.`
    : isScanning
    ? language === 'BM'
      ? 'Biarkan kamera aktif. Sistem akan terus mencari nombor plat.'
      : 'Keep the camera active. The scanner will continue looking for plates.'
    : previewSlotIds.length > 0
    ? language === 'BM'
      ? 'Tekan Mula Imbasan untuk mula.'
      : 'Press Start Scanning to begin.'
    : language === 'BM'
    ? 'Tekan Pratonton dan benarkan akses kamera.'
    : 'Press Preview and allow camera access.';
  const simpleLastResult = latestDetection
    ? latestResultTone === 'EXACT'
      ? language === 'BM'
        ? 'Padanan kes'
        : 'Match found'
      : latestResultTone === 'POSSIBLE'
      ? language === 'BM'
        ? 'Perlu semakan'
        : 'Needs review'
      : language === 'BM'
      ? 'Tiada padanan'
      : 'No match'
    : language === 'BM'
    ? 'Belum ada imbasan'
    : 'No scans yet';
  const simpleLastResultDetail = latestDetection
    ? `${latestDetection.plate} · ${latestDetection.confidence}%`
    : language === 'BM'
    ? 'Keputusan akan dipaparkan selepas plat dikesan.'
    : 'Results will appear after a plate is detected.';
  const recentDetectionByPlate = new Map<string, SessionDetection>();
  liveDetections.forEach((detection) => {
    const normalized = cleanPlateNumber(detection.plate);
    if (normalized && !recentDetectionByPlate.has(normalized)) {
      recentDetectionByPlate.set(normalized, detection);
    }
  });
  const activeSeenPlateItems: SeenPlateItem[] = tracksList
    .map((track) => {
      const plate = cleanPlateNumber(getTrackPlateText(track));
      if (!plate) return null;

      const recentDetection = recentDetectionByPlate.get(plate);
      const tone = recentDetection ? getDetectionSeenPlateTone(recentDetection) : getTrackSeenPlateTone(track);
      const matchedVehicle =
        recentDetection?.vehicleId
          ? vehicles.find((vehicle) => vehicle.id === recentDetection.vehicleId) || null
          : track.matchedVehicle
            ? (track.matchedVehicle as Vehicle)
            : null;
      const detail =
        tone === 'EXACT' && matchedVehicle
          ? `${matchedVehicle.brand} ${matchedVehicle.model}`
          : tone === 'POSSIBLE'
            ? language === 'BM'
              ? 'Perlu semakan'
              : 'Needs review'
            : tone === 'NONE'
              ? language === 'BM'
                ? 'Tiada padanan'
                : 'No match'
              : getTrackStatusLabel(track);

      return {
        id: `track-${track.trackId}`,
        plate,
        tone,
        confidence: recentDetection?.confidence ?? getTrackDisplayConfidencePercent(track),
        cameraName: recentDetection?.cameraName ?? activeCameraLabel,
        timestamp: recentDetection?.timestamp ?? new Date(track.lastSeenTimestamp || Date.now()).toLocaleTimeString('en-GB'),
        detail,
        searchHref: `/search?plate=${encodeURIComponent(plate)}`,
        active: true,
      };
    })
    .filter((item): item is SeenPlateItem => Boolean(item));
  const activeSeenPlateKeys = new Set(activeSeenPlateItems.map((item) => item.plate));
  const recentSeenPlateItems: SeenPlateItem[] = liveDetections
    .filter((detection) => !activeSeenPlateKeys.has(cleanPlateNumber(detection.plate)))
    .map((detection) => {
      const tone = getDetectionSeenPlateTone(detection);
      const matchedVehicle = detection.vehicleId
        ? vehicles.find((vehicle) => vehicle.id === detection.vehicleId) || null
        : null;
      return {
        id: `det-${detection.id}`,
        plate: cleanPlateNumber(detection.plate),
        tone,
        confidence: detection.confidence,
        cameraName: detection.cameraName,
        timestamp: detection.timestamp,
        detail:
          tone === 'EXACT' && matchedVehicle
            ? `${matchedVehicle.brand} ${matchedVehicle.model}`
            : tone === 'POSSIBLE'
              ? language === 'BM'
                ? 'Perlu semakan'
                : 'Needs review'
              : language === 'BM'
                ? 'Tiada padanan'
                : 'No match',
        searchHref: `/search?plate=${encodeURIComponent(detection.plate)}`,
        active: false,
      };
    });
  const seenPlateItems = [...activeSeenPlateItems, ...recentSeenPlateItems].slice(0, 8);
  const scannerCameraStyle = {
    '--scanner-camera-zoom': mobileCameraZoom.toFixed(2),
  } as React.CSSProperties;

  // Pinch-zoom refs — used by a non-passive native event listener so that
  // event.preventDefault() actually suppresses the browser's own zoom/scroll.
  const scannerCameraCardRef = useRef<HTMLDivElement | null>(null);
  const mobileCameraZoomRef = useRef(mobileCameraZoom);
  useEffect(() => {
    mobileCameraZoomRef.current = mobileCameraZoom;
  }, [mobileCameraZoom]);

  useEffect(() => {
    const el = scannerCameraCardRef.current;
    if (!el) return;

    const getTouchDist = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      mobilePinchZoomRef.current = {
        startDistance: getTouchDist(event.touches),
        startZoom: mobileCameraZoomRef.current,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !mobilePinchZoomRef.current) return;
      event.preventDefault(); // only works on a non-passive listener
      const { startDistance, startZoom } = mobilePinchZoomRef.current;
      if (startDistance <= 0) return;
      const ratio = getTouchDist(event.touches) / startDistance;
      setMobileCameraZoom(clampNumber(startZoom * ratio, 1, 3));
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) mobilePinchZoomRef.current = null;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false }); // non-passive to allow preventDefault
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []); // attach once — handlers read latest zoom via ref

  return (
    <div className="scanner-page max-w-6xl mx-auto space-y-3 sm:space-y-5">
      <div className="hidden bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl sm:flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Link
            href="/"
            className="p-2 rounded-xl bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white transition-all shrink-0"
            title={language === 'BM' ? 'Kembali ke Papan Utama' : 'Back to Dashboard'}
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-sm sm:text-base font-black text-white uppercase tracking-wider leading-tight">
              {t('liveScannerTitle')}
            </h1>
            <p className="text-[10px] text-slate-500 hidden sm:block">
              {scannerStatusText}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2 sm:flex sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => void refreshCameraList()}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-cyan-700 hover:text-cyan-300"
              title="Refresh cameras"
            >
              <RefreshCw className="w-4 h-4" />
              <span>{language === 'BM' ? 'Segar' : 'Refresh'}</span>
            </button>
            {canUseDiagnostics && (
              <button
                type="button"
                onClick={() => setDeveloperMode((value) => !value)}
                className={`hidden sm:inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                  developerMode
                    ? 'border-cyan-700 bg-cyan-950 text-cyan-200'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-cyan-700 hover:text-cyan-300'
                }`}
              >
                <Brain className="w-4 h-4" />
                <span>Diagnostics</span>
              </button>
            )}
            {canUseDiagnostics && (
              <button
                type="button"
                onClick={() => setDatasetMode((value) => !value)}
                className={`hidden sm:inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition-all ${
                  datasetMode
                    ? 'border-emerald-700 bg-emerald-950 text-emerald-200'
                    : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-emerald-700 hover:text-emerald-300'
                }`}
              >
                <Download className="w-4 h-4" />
                <span>Dataset</span>
              </button>
            )}
            {canUseDiagnostics && datasetSamplesRef.current.length > 0 && (
              <button
                type="button"
                onClick={handleExportDataset}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-emerald-800 bg-emerald-950 px-3 py-2 text-xs font-bold text-emerald-200 transition-all hover:bg-emerald-900"
              >
                <Download className="w-4 h-4" />
                <span>Export</span>
              </button>
            )}
            {supportsMultiCameraScan && (
              <button
                type="button"
                onClick={() => void handleAddCamera()}
                disabled={cameraSlots.length >= 4}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-bold text-slate-300 transition-all hover:border-cyan-700 hover:text-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                <span>{language === 'BM' ? 'Tambah Kamera' : 'Add Camera'}</span>
              </button>
            )}
            {isScanning ? (
              <button
                onClick={handleStopScanning}
                className="px-4 py-3 sm:py-2 rounded-xl border border-slate-700 bg-slate-900 text-slate-200 text-xs font-black uppercase flex items-center justify-center gap-2 hover:border-red-800 hover:text-red-200"
              >
                <span className="h-2.5 w-2.5 rounded-sm bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.45)]" />
                <span>{language === 'BM' ? 'Henti Imbasan' : 'Stop Scan'}</span>
              </button>
            ) : (
              <button
                onClick={() => void handleStartScanning()}
                className="px-4 py-3 sm:py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-black uppercase flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20"
              >
                <Play className="w-4 h-4" />
                <span>{language === 'BM' ? 'Mula Imbasan' : 'Start Scanning'}</span>
              </button>
            )}
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`p-3 sm:p-2 rounded-xl border text-xs font-bold transition-all shrink-0 ${
                soundEnabled
                  ? 'bg-cyan-950 text-cyan-400 border-cyan-800'
                  : 'bg-slate-800 text-slate-400 border-slate-700'
              }`}
              title="Toggle sound"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
        </div>
      </div>

      {cameraError && (
        <div className="hidden sm:block rounded-xl border border-red-800 bg-red-950/40 px-4 py-3 text-xs font-bold text-red-300">
          {cameraError}
        </div>
      )}

      {!cameraError && (
        <div className="hidden sm:block">
          <ModelStatusBanner
            runtimeState={runtimeState}
            detectorProvider={detectorProvider}
            ocrProvider={ocrProvider}
            benchmark={benchmarkResult}
            errorMessage={runtimeErrorMessage}
            debugMode={showDeveloperOverlay}
            onRetry={startRuntimeInit}
            onManualSearch={() => {
              window.location.href = '/search';
            }}
          />
        </div>
      )}

      {showUnsupportedBrowserWarning && (
        <div className="hidden sm:flex items-start gap-2 rounded-xl border border-amber-700 bg-amber-950/35 px-3 py-2 text-[11px] font-bold text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {language === 'BM'
              ? 'Pengimbas produksi ini disokong untuk Chrome atau Edge terkini pada komputer riba Windows/macOS.'
              : 'This production scanner is supported on the latest Chrome or Edge on Windows/macOS laptops.'}
          </span>
        </div>
      )}

      <div className="hidden sm:block rounded-2xl border border-slate-800 bg-slate-900/90 p-4 sm:p-3 shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-cyan-300" />
            <span className="text-[10px] font-black uppercase tracking-wider text-slate-300">
              {language === 'BM' ? 'Status Pengimbas' : 'Scanner Status'}
            </span>
          </div>
          {!showDeveloperOverlay && (
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] font-black uppercase text-slate-300">
              {isScanning ? (language === 'BM' ? 'Aktif' : 'Active') : language === 'BM' ? 'Sedia' : 'Ready'}
            </span>
          )}
          {showDeveloperOverlay && (
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] font-black uppercase text-slate-300">
              {runtimeMetricsSnapshot.performanceMode.replace('_', ' ')}
            </span>
          )}
        </div>

        {!showDeveloperOverlay ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [language === 'BM' ? 'Kamera' : 'Camera', activeCameraLabel],
              [language === 'BM' ? 'Keadaan' : 'Status', simpleScannerStatus],
              [language === 'BM' ? 'Keputusan Terkini' : 'Latest Result', simpleLastResult],
              [language === 'BM' ? 'Jumlah Sesi' : 'Session Scans', liveDetections.length.toString()],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-3 sm:py-2.5">
                <div className="truncate text-[10px] font-bold uppercase text-slate-500">{label}</div>
                <div className="mt-1 truncate text-sm font-black text-slate-100">{value}</div>
              </div>
            ))}
            <div className="rounded-lg border border-slate-800 bg-slate-950 px-3.5 py-3 sm:py-2.5 sm:col-span-2 lg:col-span-4">
              <div className="text-[10px] font-bold uppercase text-slate-500">
                {language === 'BM' ? 'Nota' : 'Message'}
              </div>
              <div className="mt-1 text-xs font-semibold text-slate-300">{simpleScannerHint}</div>
              <div className="mt-1 text-[11px] text-slate-500">{simpleLastResultDetail}</div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Camera', activeCameraLabel],
              [
                'Resolution',
                activeCameraMetadata?.width
                  ? `${activeCameraMetadata.width}x${activeCameraMetadata.height}`
                  : `${adaptiveConfigSnapshot.camera.idealWidth}x${adaptiveConfigSnapshot.camera.idealHeight}`,
              ],
              ['FPS', camFps ? camFps.toFixed(0) : activeCameraMetadata?.fps?.toFixed(0) || '0'],
              ['Environment', `${environmentProfile.label} ${Math.round(environmentProfile.confidence * 100)}%`],
              ['Backend', `${detectorProvider}/${ocrProvider}`],
              ['System Health', `${systemHealthSnapshot.overallScore}%`],
              ['Detector FPS', detFps.toFixed(0)],
              ['OCR Queue', runtimeMetricsSnapshot.lastOcrQueueDepth.toFixed(0)],
              ['Quality', `${runtimeMetricsSnapshot.currentQuality} ${Math.round(runtimeMetricsSnapshot.currentQualityConfidence * 100)}%`],
              ['Quality Engine', getPlateQualityEngineLabel().replace('QUALITY ENGINE: ', '')],
              ['Current Environment', runtimeMetricsSnapshot.currentEnvironment],
              ['Current Camera', activeCameraMetadata?.kind?.replaceAll('_', ' ') || 'UNKNOWN'],
              ['Developer Mode', developerMode ? 'ON' : 'OFF'],
              ['Dataset Mode', effectiveDatasetMode ? `${datasetSamplesRef.current.length} samples` : 'OFF'],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-2">
                <div className="truncate text-[9px] font-bold uppercase text-slate-500">{label}</div>
                <div className="mt-0.5 truncate font-mono text-[11px] font-black text-slate-100">{value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {latestDetection && latestResultTone && (
        <div
          className={`hidden sm:block rounded-xl border px-3 py-2.5 shadow-lg ${
            latestResultTone === 'EXACT'
              ? 'border-red-700 bg-red-950/45'
              : latestResultTone === 'POSSIBLE'
              ? 'border-amber-700 bg-amber-950/35'
              : 'border-slate-800 bg-slate-900/90'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                  latestResultTone === 'EXACT'
                    ? 'bg-red-600 text-white'
                    : latestResultTone === 'POSSIBLE'
                    ? 'bg-amber-500 text-slate-950'
                    : 'bg-slate-950 text-cyan-300'
                }`}
              >
                {latestResultTone === 'EXACT' ? (
                  <ShieldAlert className="h-4 w-4" />
                ) : latestResultTone === 'POSSIBLE' ? (
                  <AlertTriangle className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono text-sm font-black text-cyan-300">{latestDetection.plate}</span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${
                      latestResultTone === 'EXACT'
                        ? 'bg-red-600 text-white'
                        : latestResultTone === 'POSSIBLE'
                        ? 'bg-amber-500 text-slate-950'
                        : 'border border-slate-700 bg-slate-950 text-slate-100'
                    }`}
                  >
                    {latestResultTone === 'EXACT'
                      ? language === 'BM'
                        ? 'Padanan kes'
                        : 'Match'
                      : latestResultTone === 'POSSIBLE'
                      ? language === 'BM'
                        ? 'Semakan'
                        : 'Possible'
                      : language === 'BM'
                      ? 'TIADA PADANAN'
                      : 'NOT MATCH'}
                  </span>
                </div>
                <div className="truncate text-[10px] text-slate-400">
                  {latestDetection.confidence}% · {latestDetection.cameraName}
                  {latestResultTone === 'EXACT' && latestExactVehicle
                    ? ` · ${latestExactVehicle.brand} ${latestExactVehicle.model}`
                    : ''}
                </div>
              </div>
            </div>

            <Link
              href={latestSearchHref}
              className="shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[10px] font-black uppercase text-slate-300 hover:border-cyan-800 hover:text-cyan-200"
            >
              {language === 'BM' ? 'Semak' : 'View'}
            </Link>
          </div>
        </div>
      )}

      <div
        ref={scannerCameraCardRef}
        className="scanner-camera-card relative h-[42dvh] min-h-[240px] max-h-[330px] overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-xl sm:aspect-video sm:h-auto sm:min-h-0 sm:max-h-none"
        style={scannerCameraStyle}
        aria-busy={scannerControlBusy}
      >
        <div
          className={`grid h-full gap-2 p-2 sm:absolute sm:inset-0 ${
            cameraSlots.length === 1
              ? 'grid-cols-1'
              : cameraSlots.length === 2
              ? 'grid-cols-1 sm:grid-cols-2'
              : 'grid-cols-1 sm:grid-cols-2'
          }`}
        >
          {cameraSlots.map((slot, index) => {
            const slotLabel = getCameraSlotLabel(slot, index);
            const activeSlotAlert = activeAlertMatchesBySlot[slot.id];
            const isAlertSlot = Boolean(activeSlotAlert);

            return (
              <div
                key={slot.id}
                onClick={() => handleSelectActiveSlot(slot.id)}
                className={`relative min-h-0 rounded-xl overflow-hidden border bg-slate-950 text-left transition-all ${
                  isAlertSlot
                    ? 'border-red-500 ring-2 ring-red-500/40'
                    : 'border-slate-800'
                }`}
              >
                <video
                  ref={(node) => {
                    videoRefs.current[slot.id] = node;
                  }}
                  className="scanner-camera-media absolute inset-0 h-full w-full object-contain sm:object-cover"
                  muted
                  playsInline
                  autoPlay
                />

                {!previewSlotIds.includes(slot.id) && (
                  <div className="absolute inset-0 bg-slate-950 flex flex-col items-center justify-center gap-3 text-center p-6">
                    <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center">
                      <Video className="w-6 h-6 text-cyan-400" />
                    </div>
                    <div>
                      <div className="text-xs font-black text-white uppercase tracking-wider">{slotLabel}</div>
                      <div className="text-[10px] text-slate-500 mt-1">
                        <span className="sm:hidden">
                          {language === 'BM' ? 'Tekan Mula Imbasan untuk buka kamera.' : 'Tap Start Scan to open camera.'}
                        </span>
                        <span className="hidden sm:inline">
                          {language === 'BM'
                            ? 'Pilih kamera dan guna pratonton sebelum mengimbas.'
                            : 'Choose camera and use preview before scanning.'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <canvas
                  ref={(node) => {
                    canvasRefs.current[slot.id] = node;
                  }}
                  className="scanner-camera-media absolute inset-0 z-10 h-full w-full object-contain pointer-events-none sm:object-cover"
                />

                {scannerReloadActive && (
                  <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/75 px-6 text-center backdrop-blur-sm">
                    <div className="rounded-xl border border-cyan-800 bg-slate-950/90 px-4 py-3 shadow-xl">
                      <RefreshCw className="mx-auto h-5 w-5 animate-spin text-cyan-300" />
                      <div className="mt-2 text-xs font-black uppercase tracking-wider text-white">
                        {scannerNoticeTitle}
                      </div>
                      <div className="mt-1 max-w-[220px] text-[10px] font-semibold text-slate-400">
                        {scannerNoticeBody}
                      </div>
                    </div>
                  </div>
                )}

                {scannerReloadComplete && (
                  <div className="absolute inset-x-3 top-14 z-30 flex justify-center sm:top-12">
                    <div className="rounded-xl border border-emerald-800 bg-emerald-950/90 px-3 py-2 text-center shadow-xl backdrop-blur-md">
                      <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-300" />
                      <div className="mt-1 text-[10px] font-black uppercase tracking-wider text-emerald-100">
                        {scannerNoticeTitle}
                      </div>
                      <div className="mt-0.5 max-w-[220px] text-[9px] font-semibold text-emerald-200/80">
                        {scannerNoticeBody}
                      </div>
                    </div>
                  </div>
                )}

                <div className="absolute inset-x-2.5 top-2.5 z-20 hidden sm:flex items-center gap-1.5">
                  <select
                    value={slot.deviceId}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => handleCameraSlotDeviceChange(slot.id, event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900/90 px-2 text-[10px] font-bold text-slate-200 outline-none hover:border-cyan-700 focus:border-cyan-500"
                    title={language === 'BM' ? 'Pilih kamera' : 'Choose camera'}
                  >
                    {(availableCameras.length > 0
                      ? availableCameras
                      : [{ deviceId: '', groupId: '', label: slotLabel, kind: 'UNKNOWN_CAMERA' as const }]
                    ).map(
                      (cameraDevice, cameraIndex) => (
                        <option key={cameraDevice.deviceId || `camera-${cameraIndex}`} value={cameraDevice.deviceId}>
                          {cameraDevice.label || (cameraIndex === 0 ? slotLabel : `Camera ${cameraIndex + 1}`)}
                        </option>
                      )
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUseCamera(slot, index);
                    }}
                    className="h-7 rounded-lg border border-cyan-700 bg-cyan-950/90 px-2 text-[10px] font-bold text-cyan-200 hover:bg-cyan-900"
                  >
                    {language === 'BM' ? 'Pratonton' : 'Preview'}
                  </button>
                  {cameraSlots.length > 1 && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRemoveCamera(slot.id);
                      }}
                      className="h-7 w-7 rounded-lg border border-slate-700 bg-slate-900/90 text-slate-300 hover:border-red-700 hover:text-red-300"
                      title={language === 'BM' ? 'Buang kamera' : 'Remove camera'}
                    >
                      <X className="mx-auto h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {supportsMultiCameraScan && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleAddCamera();
                    }}
                    disabled={cameraSlots.length >= 4}
                    className="hidden absolute bottom-2.5 right-2.5 z-20 items-center gap-1 rounded-lg border border-slate-700 bg-slate-900/85 px-2.5 py-1 text-[10px] font-bold text-slate-300 disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                    <span>{language === 'BM' ? 'Tambah' : 'Add'}</span>
                  </button>
                )}
                {isAlertSlot && activeSlotAlert && (
                  <div className="scanner-alert-card absolute inset-1.5 z-30 bg-red-600 border-2 border-red-400 rounded-xl p-2.5 sm:p-4 shadow-2xl flex flex-col justify-between text-center overflow-hidden">
                    <div className="flex items-center justify-between border-b border-red-500/80 pb-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <ShieldAlert className="w-4 h-4 text-white animate-bounce shrink-0" />
                        <span className="text-[10px] sm:text-xs font-black uppercase text-white tracking-wider truncate">
                          {language === 'BM' ? 'AMARAN: PADANAN DIKESAN' : 'ALERT: MATCH DETECTED'}
                        </span>
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          runtimeMetricsRef.current.falseAlertCount++;
                          setActiveAlertMatchesBySlot((alerts) => {
                            const nextAlerts = { ...alerts };
                            delete nextAlerts[slot.id];
                            return nextAlerts;
                          });
                        }}
                        className="p-1 rounded-lg bg-red-700 hover:bg-red-800 text-white transition-all"
                        title={t('closeBtn')}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="bg-red-700 border border-red-400/50 rounded-lg p-2.5 sm:p-3 space-y-2 text-left shadow-inner">
                      <div className="grid grid-cols-2 gap-2 border-b border-red-500/80 pb-2">
                        <div>
                          <span className="text-[9px] text-red-100 font-bold uppercase block">{t('plateNumber')}</span>
                          <span className="plate-yellow text-base sm:text-xl font-mono font-black">
                            {activeSlotAlert.vehicle.plate}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-red-100 font-bold uppercase block">{t('outstandingAmount')}</span>
                          <span className="text-base sm:text-lg font-mono font-black text-white">
                            {formatMYR(activeSlotAlert.vehicle.outstandingAmount)}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[10px] sm:text-xs">
                        <div>
                          <span className="text-red-100 block">{t('vehicleDetails')}</span>
                          <strong className="text-white truncate block">
                            {activeSlotAlert.vehicle.brand} {activeSlotAlert.vehicle.model}
                          </strong>
                        </div>
                        <div>
                          <span className="text-red-100 block">{language === 'BM' ? 'Kamera' : 'Camera'}</span>
                          <strong className="text-white truncate block">{activeSlotAlert.cameraName}</strong>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-1.5 pt-2 border-t border-red-500/80">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          handleMarkAsSeen(slot.id);
                        }}
                        className="btn-mark-seen px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-red-600 text-[10px] sm:text-xs font-black uppercase tracking-wider flex items-center justify-center gap-1 shadow-md transition-all"
                      >
                        <BookmarkCheck className="w-3.5 h-3.5 text-red-600" />
                        <span>{t('markAction')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-2 sm:hidden">
          <div className="min-w-0 rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2 backdrop-blur-md">
            <div className="truncate text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300">
              {language === 'BM' ? 'Pengimbas' : 'Scanner'}
            </div>
            <div className="truncate text-[11px] font-bold text-slate-200">{simpleScannerStatus}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleMobileFacingModeChange(mobileFacingMode === 'environment' ? 'user' : 'environment');
              }}
              className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/75 text-cyan-200 shadow-lg shadow-slate-950/35 backdrop-blur-md transition-all hover:border-cyan-700 hover:text-cyan-100"
              title={language === 'BM' ? 'Tukar kamera' : 'Flip camera'}
              aria-label={language === 'BM' ? 'Tukar kamera' : 'Flip camera'}
            >
              <SwitchCamera className="h-5 w-5" />
            </button>
            <button
              onClick={() => setSoundEnabled(!soundEnabled)}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-xs font-bold shadow-lg shadow-slate-950/35 backdrop-blur-md transition-all ${
                soundEnabled
                  ? 'border-cyan-800/80 bg-slate-950/75 text-cyan-300'
                  : 'border-slate-700/80 bg-slate-950/75 text-slate-400'
              }`}
              title="Toggle sound"
              aria-label="Toggle sound"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="absolute inset-x-3 bottom-3 z-20 sm:hidden">
          {cameraError && (
            <div className="mb-2 rounded-xl border border-red-700 bg-red-950/80 px-3 py-2 text-[11px] font-bold text-red-200 backdrop-blur-md">
              {cameraError}
            </div>
          )}
          {isScanning ? (
            <button
              onClick={handleStopScanning}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-slate-700/90 bg-slate-950/82 text-xs font-black uppercase tracking-wider text-slate-100 shadow-xl shadow-slate-950/35 backdrop-blur-md transition-all active:scale-[0.99]"
            >
              <span className="h-3 w-3 rounded-sm bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.55)]" />
              <span>{language === 'BM' ? 'Henti Imbasan' : 'Stop Scan'}</span>
            </button>
          ) : (
            <button
              onClick={() => void handleStartScanning()}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-cyan-600 text-xs font-black uppercase tracking-wider text-white shadow-xl shadow-cyan-500/20"
            >
              <Play className="h-4 w-4" />
              <span>{language === 'BM' ? 'Mula Imbasan' : 'Start Scan'}</span>
            </button>
          )}
        </div>
      </div>

      <div
        className="scanner-mobile-result sm:hidden rounded-2xl border border-slate-800 bg-slate-900/90 p-3 shadow-xl shadow-slate-950/30"
      >
        {seenPlateItems.length > 0 ? (
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300">
                  {language === 'BM' ? 'Plat Dilihat' : 'Seen Plates'}
                </div>
                <div className="truncate text-[11px] font-semibold text-slate-400">
                  {activeSeenPlateItems.length} {language === 'BM' ? 'aktif' : 'active'} · {liveDetections.length}{' '}
                  {language === 'BM' ? 'keputusan sesi' : 'session results'}
                </div>
              </div>
              <span className="shrink-0 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] font-black text-slate-300">
                {tracksList.length}
              </span>
            </div>

            <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
              {seenPlateItems.map((item) => (
                <div
                  key={item.id}
                  className={`rounded-xl border px-3 py-2 ${getSeenPlateBorderClass(item.tone)}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-xl font-black leading-none text-cyan-300">
                          {item.plate}
                        </span>
                        <span
                          className={`shrink-0 rounded-md px-2 py-1 text-[9px] font-black uppercase ${getSeenPlateBadgeClass(item.tone)}`}
                        >
                          {getSeenPlateStatusLabel(item.tone, language)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-xs font-semibold text-slate-300">{item.detail}</div>
                      <div className="mt-0.5 truncate text-[10px] font-mono text-slate-500">
                        {item.confidence}% · {item.timestamp}
                        {item.active ? ` · ${language === 'BM' ? 'aktif' : 'active'}` : ''}
                      </div>
                    </div>
                    <Link
                      href={item.searchHref}
                      className="shrink-0 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-[10px] font-black uppercase text-slate-300"
                    >
                      {language === 'BM' ? 'Semak' : 'View'}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950">
              <Activity className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-black text-white">{simpleLastResult}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] font-medium leading-snug text-slate-400">
                {simpleLastResultDetail}
              </div>
            </div>
          </div>
        )}
      </div>

      {showDeveloperOverlay && (
        <div className="hidden sm:block rounded-2xl border border-cyan-900/70 bg-slate-950/95 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-black uppercase tracking-wider text-cyan-300">Developer Metrics</div>
              <div className="text-[10px] text-slate-500">
                Tier {runtimeMetricsSnapshot.deviceTier} · {runtimeMetricsSnapshot.performanceMode.replace('_', ' ')} · Health {systemHealthSnapshot.overallScore}% · {completedTrackEventsRef.current.length} completed track events
              </div>
            </div>
            <button
              type="button"
              onClick={handleExportScannerMetrics}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-800 bg-cyan-950 px-2.5 py-1.5 text-[10px] font-bold text-cyan-200 hover:bg-cyan-900"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Metrics</span>
            </button>
            <button
              type="button"
              onClick={handleExportDataset}
              disabled={datasetSamplesRef.current.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-800 bg-emerald-950 px-2.5 py-1.5 text-[10px] font-bold text-emerald-200 hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Dataset</span>
            </button>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {systemHealthSnapshot.components.map((component) => (
              <div key={component.label} className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[9px] font-bold uppercase text-slate-500">{component.label}</div>
                  <div
                    className={`text-[9px] font-black ${
                      component.status === 'OK'
                        ? 'text-emerald-300'
                        : component.status === 'WARN'
                        ? 'text-amber-300'
                        : component.status === 'FAIL'
                        ? 'text-red-300'
                        : 'text-slate-400'
                    }`}
                  >
                    {component.status}
                  </div>
                </div>
                <div className="mt-0.5 font-mono text-xs font-black text-slate-100">{component.score}%</div>
                <div className="mt-0.5 truncate text-[9px] text-slate-500">{component.detail}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {[
              ['Camera FPS', camFps.toFixed(0)],
              ['Detector FPS', detFps.toFixed(0)],
              ['Execution', runtimeMetricsSnapshot.executionMode],
              ['Camera', runtimeMetricsSnapshot.cameraProfile],
              ['Detector target', `${getTierDetectorTargetMs(runtimeMetricsSnapshot.deviceTier)} ms`],
              ['OCR profile', runtimeMetricsSnapshot.ocrProfile],
              ['Env model', getEnvironmentModelStatus()],
              ['Quality model', getPlateQualityModelStatus()],
              ['Quality engine', getPlateQualityEngineLabel().replace('QUALITY ENGINE: ', '')],
              ['Environment', `${runtimeMetricsSnapshot.currentEnvironment} ${Math.round(runtimeMetricsSnapshot.currentEnvironmentConfidence * 100)}%`],
              ['Quality', `${runtimeMetricsSnapshot.currentQuality} ${Math.round(runtimeMetricsSnapshot.currentQualityConfidence * 100)}%`],
              ['Quality P95', `${runtimeMetricsSnapshot.qualityLatencyP95Ms.toFixed(0)} ms`],
              ['Quality accept', runtimeMetricsSnapshot.qualityAcceptedCropCount.toFixed(0)],
              ['Quality reject', runtimeMetricsSnapshot.qualityRejectedCropCount.toFixed(0)],
              ['OCR avoided', runtimeMetricsSnapshot.qualityOcrAvoidedCount.toFixed(0)],
              ['Recovered', runtimeMetricsSnapshot.qualityCorrectableRecoveredCount.toFixed(0)],
              ['Best replacements', runtimeMetricsSnapshot.bestFrameReplacementCount.toFixed(0)],
              ['Waiting crops', runtimeMetricsSnapshot.tracksWaitingForBetterCrop.toFixed(0)],
              ['Heuristic/ONNX', `${runtimeMetricsSnapshot.heuristicQualityUsageCount}/${runtimeMetricsSnapshot.onnxQualityUsageCount}`],
              ['Detector P50', `${runtimeMetricsSnapshot.detectorLatencyMedianMs.toFixed(0)} ms`],
              ['Detector P95', `${runtimeMetricsSnapshot.detectorLatencyP95Ms.toFixed(0)} ms`],
              ['OCR P50', `${runtimeMetricsSnapshot.ocrLatencyMedianMs.toFixed(0)} ms`],
              ['OCR P95', `${runtimeMetricsSnapshot.ocrLatencyP95Ms.toFixed(0)} ms`],
              ['Tracks', activeTracksCount.toFixed(0)],
              ['Lost', runtimeMetricsSnapshot.lostTrackObservations.toFixed(0)],
              ['OCR queue', runtimeMetricsSnapshot.lastOcrQueueDepth.toFixed(0)],
              ['Avg conf', `${Math.round(runtimeMetricsSnapshot.averageTrackConfidence * 100)}%`],
              ['Crop quality', `${Math.round(runtimeMetricsSnapshot.cropQualityAvg * 100)}%`],
              ['Consensus', runtimeMetricsSnapshot.consensusAttemptCount.toFixed(0)],
              ['OCR attempts', runtimeMetricsSnapshot.ocrAttemptCount.toFixed(0)],
              ['Dup skips', runtimeMetricsSnapshot.duplicateOcrSkippedCount.toFixed(0)],
              ['Queue skips', runtimeMetricsSnapshot.ocrSkippedQueuePressureCount.toFixed(0)],
              ['Track loss', `${Math.round(runtimeMetricsSnapshot.trackLossRate * 100)}%`],
              ['Dropped', runtimeMetricsSnapshot.droppedFrameCount.toFixed(0)],
              ['False alerts', runtimeMetricsSnapshot.falseAlertCount.toFixed(0)],
              ['Target det P95', `<${SCANNER_PERFORMANCE_TARGETS.detectorP95LatencyMs} ms`],
              ['Target OCR P95', `<${SCANNER_PERFORMANCE_TARGETS.ocrP95LatencyMs} ms`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2">
                <div className="text-[9px] font-bold uppercase text-slate-500">{label}</div>
                <div className="mt-0.5 font-mono text-xs font-black text-slate-100">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(runtimeMetricsSnapshot.motionBuckets).map(([bucket, count]) => (
              <div key={bucket} className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2">
                <div className="text-[9px] font-bold uppercase text-slate-500">{bucket.replace('_', ' ')}</div>
                <div className="mt-0.5 font-mono text-xs font-black text-cyan-200">{count}</div>
              </div>
            ))}
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {Object.entries(environmentDistributionPercent)
              .filter(([, value]) => value > 0)
              .slice(0, 12)
              .map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2">
                  <div className="text-[9px] font-bold uppercase text-slate-500">{label}</div>
                  <div className="mt-0.5 font-mono text-xs font-black text-cyan-200">{value.toFixed(1)}%</div>
                </div>
              ))}
            {Object.entries(qualityDistributionPercent)
              .filter(([, value]) => value > 0)
              .slice(0, 8)
              .map(([label, value]) => (
                <div key={`quality-${label}`} className="rounded-lg border border-slate-800 bg-slate-900 px-2.5 py-2">
                  <div className="text-[9px] font-bold uppercase text-slate-500">{label}</div>
                  <div className="mt-0.5 font-mono text-xs font-black text-emerald-200">{value.toFixed(1)}%</div>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="hidden sm:block bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-cyan-400" />
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">
              {t('recentDetectionList')}
            </h2>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            {liveDetections.length} session scans
          </span>
        </div>

        {seenPlateItems.length > 0 && (
          <div className="hidden sm:grid grid-cols-2 gap-2 lg:grid-cols-4">
            {seenPlateItems.slice(0, 8).map((item) => (
              <Link
                key={item.id}
                href={item.searchHref}
                className={`rounded-lg border px-3 py-2 transition-all hover:border-cyan-700 ${getSeenPlateBorderClass(item.tone)}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-base font-black text-cyan-300">{item.plate}</span>
                  <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-black uppercase ${getSeenPlateBadgeClass(item.tone)}`}>
                    {getSeenPlateStatusLabel(item.tone, language)}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] font-semibold text-slate-300">{item.detail}</div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                  {item.confidence}% · {item.timestamp}
                </div>
              </Link>
            ))}
          </div>
        )}

        <div className="sm:hidden space-y-3">
          {liveDetections.length > 0 ? (
            liveDetections.map((det) => (
              <button
                key={det.id}
                type="button"
                onClick={() => setExpandedDetectionId((current) => (current === det.id ? null : det.id))}
                className="w-full p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-left space-y-3 hover:border-cyan-900/70 transition-all"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-black text-cyan-300 text-xs">{det.plate}</span>
                      <span className="text-[10px] text-slate-400 truncate">{det.cameraName}</span>
                    </div>
                    {det.matchType === 'EXACT' || det.matched ? (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-red-950 text-red-400 border border-red-700 inline-flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        <span>TANDA TINDAKAN</span>
                      </span>
                    ) : det.matchType === 'POSSIBLE' ? (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-amber-950 text-amber-300 border border-amber-700 inline-flex items-center gap-1">
                        <AlertTriangle className="w-2.5 h-2.5" />
                        <span>POSSIBLE</span>
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-900 text-slate-400 border border-slate-800 inline-flex items-center gap-1">
                        <XCircle className="w-2.5 h-2.5" />
                        <span>{language === 'BM' ? 'TIADA PADANAN' : 'NOT MATCH'}</span>
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 shrink-0">{det.timestamp}</span>
                </div>
                {expandedDetectionId === det.id && (
                  <div className="grid grid-cols-1 gap-1 border-t border-slate-800 pt-2 text-[10px] text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-3 w-3 text-cyan-400" />
                      <span>{det.name}</span>
                    </div>
                    <div className="font-mono">GPS: {det.gps}</div>
                  </div>
                )}
              </button>
            ))
          ) : (
            <div className="py-5 text-center text-xs text-slate-500">No scans in this session yet.</div>
          )}
        </div>

        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[560px]">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono text-[9px] sm:text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-2 px-3">{language === 'BM' ? 'Nombor Plat' : 'Plate Number'}</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Confidence</th>
                <th className="py-2 px-3">{language === 'BM' ? 'Kamera' : 'Camera'}</th>
                <th className="py-2 px-3 text-right">{language === 'BM' ? 'Masa' : 'Time'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono whitespace-nowrap">
              {liveDetections.length > 0 ? (
                liveDetections.map((det) => (
                  <React.Fragment key={det.id}>
                    <tr
                      onClick={() => setExpandedDetectionId((current) => (current === det.id ? null : det.id))}
                      className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                    >
                      <td className="py-2 px-3 font-black text-cyan-300 text-xs sm:text-sm">{det.plate}</td>
                      <td className="py-2 px-3">
                        {det.matchType === 'EXACT' || det.matched ? (
                          <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase bg-red-950 text-red-400 border border-red-700 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>TANDA TINDAKAN</span>
                          </span>
                        ) : det.matchType === 'POSSIBLE' ? (
                          <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase bg-amber-950 text-amber-300 border border-amber-700 inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            <span>POSSIBLE</span>
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold uppercase bg-slate-950 text-slate-400 border border-slate-800 inline-flex items-center gap-1">
                            <XCircle className="w-3 h-3" />
                            <span>{language === 'BM' ? 'TIADA PADANAN' : 'NOT MATCH'}</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-slate-300 text-[11px]">{det.confidence}%</td>
                      <td className="py-2 px-3 text-slate-300 text-[11px]">{det.cameraName}</td>
                      <td className="py-2 px-3 text-right text-slate-500 text-[10px] sm:text-[11px]">{det.timestamp}</td>
                    </tr>
                    {expandedDetectionId === det.id && (
                      <tr className="bg-slate-950/70">
                        <td colSpan={5} className="px-3 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px] text-slate-400">
                            <div className="flex items-center gap-1.5 md:col-span-2">
                              <MapPin className="h-3.5 w-3.5 text-cyan-400" />
                              <span className="text-slate-500">{language === 'BM' ? 'Lokasi Dijumpai:' : 'Found Location:'}</span>
                              <span className="text-slate-300">{det.name}</span>
                            </div>
                            <div className="font-mono text-slate-300">GPS: {det.gps}</div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500 font-sans">
                    No scans in this session yet. Start scanning to populate dashboard and audit history.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
