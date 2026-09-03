import { TrackOcrState } from '../db/types';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export type TrackLifecycleState = 'VISIBLE' | 'LOST' | 'REMOVED';
export type PlatePipelineState =
  | 'DETECTED'
  | 'TRACKING'
  | 'COLLECTING'
  | 'READY_FOR_OCR'
  | 'READING'
  | 'CONSENSUS'
  | 'MATCHED'
  | 'COOLDOWN'
  | 'FINISHED';

export interface TrackConfidenceComponents {
  detection: number;
  age: number;
  motion: number;
  iou: number;
  ocr: number;
}

export interface TrackRuntimeStats {
  startedAt: number;
  lastUpdatedAt: number;
  framesVisible: number;
  framesLost: number;
  ocrAttempts: number;
  ocrAccepted: number;
  consensusAttempts: number;
  finalConfidence?: number;
  finishedAt?: number;
  lastDetectorLatencyMs?: number;
  lastOcrLatencyMs?: number;
  bestCropQuality?: number;
  lastQualityLatencyMs?: number;
  bestFrameReplacementCount?: number;
}

export interface TrackerRuntimeTuning {
  maxPredictionFrames?: number;
  lostTrackTimeoutMs?: number;
  unconfirmedTrackTimeoutMs?: number;
}

export interface TrackCropSample {
  dataUrl?: string;
  qualityScore: number;
  timestamp: number;
  ocrText?: string;
  ocrConfidence?: number;
}

export interface ActiveTrack {
  trackId: string;
  trackNumber: number;
  bbox: BoundingBox;          // Raw detection bbox (used for IoU / matching / cropping)
  smoothBbox: BoundingBox;    // EMA-smoothed bbox (used strictly for UI overlay rendering)
  predictedBbox?: BoundingBox;
  overlayAngle?: number;
  lastOverlayAngleAt?: number;
  vx: number; // velocity x (pixels per frame)
  vy: number; // velocity y (pixels per frame)
  cropSamples: TrackCropSample[];
  lastSeenFrame: number;
  firstSeenFrame: number;
  lastSeenTimestamp: number;
  firstSeenTimestamp: number;
  framesSeen: number;
  visibleThisFrame?: boolean;
  missedFrames?: number;
  motionScore?: number;
  trackConfidence?: number;
  confidenceComponents?: TrackConfidenceComponents;
  qualityClass?: string;
  qualityConfidence?: number;
  qualityScore?: number;
  qualityBackend?: string;
  qualityAcceptedForOcr?: boolean;
  qualityRejectionReasons?: string[];
  qualityCropSize?: { width: number; height: number };
  qualitySharpness?: number;
  qualitySelectedPreprocessing?: string[];
  qualitySubmittedToOcr?: boolean;
  trackState?: TrackLifecycleState;
  pipelineState?: PlatePipelineState;
  stats?: TrackRuntimeStats;

  ocrState: TrackOcrState;
  ocrRunning: boolean;
  ocrJobQueued: boolean;
  lastCropSampledAt?: number;
  lastOcrAttemptAt?: number;
  lastOcrCompletedAt?: number;

  votes: Map<string, { count: number; totalConfidence: number }>;
  stabilizedPlate?: string;
  stabilizedConfidence?: number;

  matchType?: 'EXACT' | 'POSSIBLE' | 'NONE';
  matchedVehicle?: any;
  possibleMatchVehicles?: any[];

  possibleVerificationPlate?: string;
  possibleVerificationCount?: number;
  possibleVerificationStartedAt?: number;

  cooldownActive: boolean;
  cooldownStartedAt?: number;
  lastSearchedAt?: number;
  scanEventId?: string;

  isConfirmed?: boolean;
}

export function calculateIoU(boxA: BoundingBox, boxB: BoundingBox): number {
  const xA = Math.max(boxA.x, boxB.x);
  const yA = Math.max(boxA.y, boxB.y);
  const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interWidth = Math.max(0, xB - xA);
  const interHeight = Math.max(0, yB - yA);
  const interArea = interWidth * interHeight;

  if (interArea === 0) return 0;

  const boxAArea = boxA.width * boxA.height;
  const boxBArea = boxB.width * boxB.height;

  return interArea / (boxAArea + boxBArea - interArea);
}

export function calculateCentroidDistance(boxA: BoundingBox, boxB: BoundingBox): number {
  const cxA = boxA.x + boxA.width / 2;
  const cyA = boxA.y + boxA.height / 2;
  const cxB = boxB.x + boxB.width / 2;
  const cyB = boxB.y + boxB.height / 2;
  return Math.sqrt(Math.pow(cxA - cxB, 2) + Math.pow(cyA - cyB, 2));
}

/**
 * ByteTrack-inspired Multi-Object Tracker for Real-Time License Plate Tracking.
 * 
 * Key Features:
 * - High-confidence & low-confidence two-stage association.
 * - Velocity prediction (dx, dy) for moving vehicles & moving cameras.
 * - Max active tracks pool (default 8).
 * - Independent track memory buffer & state machine.
 */
export class PlateTracker {
  private activeTracks: Map<string, ActiveTrack> = new Map();
  private trackCounter: number = 1;
  private frameIndex: number = 0;
  private iouThreshold: number = 0.30;
  private lostTrackTimeout: number = 12; // Frames before a confirmed track is pruned (~600-800ms)
  private lostTrackTimeoutMs: number = 750; // Time-based expiration in milliseconds (invariant to FPS drops)
  private completedTrackLostTimeoutMs: number = 350;
  private unconfirmedTrackTimeoutMs: number = 200;
  private maxPredictionFrames: number = 2;
  private maxActiveTracks: number = 8;
  private minConfirmationFrames: number = 2;

  private isScaleCompatible(reference: BoundingBox, candidate: BoundingBox): boolean {
    const widthRatio = candidate.width / Math.max(1, reference.width);
    const heightRatio = candidate.height / Math.max(1, reference.height);
    const referenceAspect = reference.width / Math.max(1, reference.height);
    const candidateAspect = candidate.width / Math.max(1, candidate.height);
    const aspectRatio = candidateAspect / Math.max(0.1, referenceAspect);

    return (
      widthRatio >= 0.55 &&
      widthRatio <= 1.85 &&
      heightRatio >= 0.55 &&
      heightRatio <= 1.85 &&
      aspectRatio >= 0.55 &&
      aspectRatio <= 1.85
    );
  }

  private getAssociationDistanceLimit(track: ActiveTrack, targetBox: BoundingBox, confidence: number): number {
    const baseSize = Math.max(targetBox.width, targetBox.height, 1);
    const framesMissing = Math.max(0, this.frameIndex - track.lastSeenFrame - 1);
    const velocityBoost = Math.min(baseSize * 0.40, Math.hypot(track.vx, track.vy) * Math.max(1, framesMissing + 1));
    const missedFrameBoost = Math.min(baseSize * 0.15, framesMissing * baseSize * 0.08);
    const confidenceBoost = confidence >= 0.70 ? baseSize * 0.10 : 0;

    return baseSize * 0.85 + velocityBoost + missedFrameBoost + confidenceBoost;
  }

  private shouldPredictTrack(track: ActiveTrack): boolean {
    const dt = this.frameIndex - track.lastSeenFrame;
    if (dt <= 0) return true;
    if (track.cooldownActive || track.stabilizedPlate) return false;
    return dt <= this.maxPredictionFrames;
  }

  private getAdaptiveSmoothAlpha(
    motionScore: number,
    associationIoU: number,
    detectorConfidence: number,
    baseAlpha: number
  ): number {
    if (detectorConfidence >= 0.82 && associationIoU < 0.10) return 1.0;
    if (motionScore >= 0.30) return 0.96;
    if (motionScore >= 0.18) return 0.86;
    if (motionScore >= 0.08) return 0.64;
    if (motionScore >= 0.03) return Math.max(baseAlpha, 0.42);
    return Math.min(baseAlpha, 0.28);
  }

  private shouldSkipAssociationAfterGap(track: ActiveTrack): boolean {
    const frameGap = this.frameIndex - track.lastSeenFrame;

    if (track.cooldownActive && frameGap > 1) return true;
    if (track.stabilizedPlate && frameGap > 1) return true;
    if (track.votes.size > 0 && frameGap > Math.max(4, Math.floor(this.lostTrackTimeout * 0.35))) return true;

    return false;
  }

  private getOcrStabilityScore(track: ActiveTrack): number {
    let totalVotes = 0;
    let topVotes = 0;

    track.votes.forEach((vote) => {
      totalVotes += vote.count;
      topVotes = Math.max(topVotes, vote.count);
    });

    if (totalVotes === 0) return 0.55;
    return topVotes / totalVotes;
  }

  private calculateTrackConfidence(
    track: ActiveTrack,
    detectorConfidence: number,
    associationIoU: number
  ): number {
    const components: TrackConfidenceComponents = {
      detection: detectorConfidence,
      age: Math.min(1, track.framesSeen / 4),
      motion: 1 - Math.min(1, (track.motionScore ?? 0) / 0.50),
      iou: associationIoU > 0 ? Math.min(1, associationIoU / 0.50) : 0.55,
      ocr: this.getOcrStabilityScore(track),
    };

    const confidence =
      components.detection * 0.38 +
      components.age * 0.18 +
      components.motion * 0.16 +
      components.iou * 0.16 +
      components.ocr * 0.12;

    track.confidenceComponents = components;
    return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  }

  private calculateInitialTrackConfidence(detectorConfidence: number): number {
    const components: TrackConfidenceComponents = {
      detection: detectorConfidence,
      age: 0.25,
      motion: 1.0,
      iou: 0.55,
      ocr: 0.55,
    };

    const confidence =
      components.detection * 0.38 +
      components.age * 0.18 +
      components.motion * 0.16 +
      components.iou * 0.16 +
      components.ocr * 0.12;

    return Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  }

  private createInitialConfidenceComponents(detectorConfidence: number): TrackConfidenceComponents {
    return {
      detection: detectorConfidence,
      age: 0.25,
      motion: 1,
      iou: 0.55,
      ocr: 0.55,
    };
  }

  private markMatchedTrack(
    track: ActiveTrack,
    matchedBox: BoundingBox,
    velocityAlpha: number,
    smoothAlpha: number,
    associationIoU: number
  ): void {
    const dx = matchedBox.x - track.bbox.x;
    const dy = matchedBox.y - track.bbox.y;
    const motionDenominator = Math.max(1, matchedBox.width, matchedBox.height);

    track.vx = track.vx * (1 - velocityAlpha) + dx * velocityAlpha;
    track.vy = track.vy * (1 - velocityAlpha) + dy * velocityAlpha;
    const motionScore = Math.min(2, Math.hypot(dx, dy) / motionDenominator);
    track.motionScore = motionScore;

    const now = Date.now();
    track.bbox = matchedBox;

    // EMA smoothing is only for UI display, so raw crops still use the detector bbox.
    const adaptiveSmoothAlpha = this.getAdaptiveSmoothAlpha(
      motionScore,
      associationIoU,
      matchedBox.confidence,
      smoothAlpha
    );
    track.smoothBbox = {
      x: track.smoothBbox.x * (1 - adaptiveSmoothAlpha) + matchedBox.x * adaptiveSmoothAlpha,
      y: track.smoothBbox.y * (1 - adaptiveSmoothAlpha) + matchedBox.y * adaptiveSmoothAlpha,
      width: track.smoothBbox.width * (1 - adaptiveSmoothAlpha) + matchedBox.width * adaptiveSmoothAlpha,
      height: track.smoothBbox.height * (1 - adaptiveSmoothAlpha) + matchedBox.height * adaptiveSmoothAlpha,
      confidence: matchedBox.confidence,
    };

    track.lastSeenFrame = this.frameIndex;
    track.lastSeenTimestamp = now;
    track.framesSeen++;
    track.visibleThisFrame = true;
    track.missedFrames = 0;
    track.trackState = 'VISIBLE';
    if (track.pipelineState === 'DETECTED') track.pipelineState = 'TRACKING';
    track.trackConfidence = this.calculateTrackConfidence(track, matchedBox.confidence, associationIoU);
    if (track.stats) {
      track.stats.framesVisible++;
      track.stats.lastUpdatedAt = now;
    }
    if (track.framesSeen >= this.minConfirmationFrames || track.bbox.confidence >= 0.70) track.isConfirmed = true;
  }

  constructor(lostTrackTimeout?: number, maxActiveTracks?: number, minConfirmationFrames?: number) {
    if (lostTrackTimeout !== undefined) {
      this.lostTrackTimeout = lostTrackTimeout;
      this.lostTrackTimeoutMs = lostTrackTimeout * 100;
      this.completedTrackLostTimeoutMs = Math.min(800, this.lostTrackTimeoutMs);
    }
    if (maxActiveTracks !== undefined) this.maxActiveTracks = maxActiveTracks;
    if (minConfirmationFrames !== undefined) this.minConfirmationFrames = minConfirmationFrames;
  }

  public updateTracks(detectedBoxes: BoundingBox[]): ActiveTrack[] {
    this.frameIndex++;

    this.activeTracks.forEach((track) => {
      track.visibleThisFrame = false;
      track.missedFrames = Math.max(0, this.frameIndex - track.lastSeenFrame);
      track.trackState = 'LOST';
    });

    // 1. Separate detections into High Confidence and Low Confidence
    const highConfDets: { box: BoundingBox; idx: number }[] = [];
    const lowConfDets: { box: BoundingBox; idx: number }[] = [];

    detectedBoxes.forEach((box, idx) => {
      if (box.confidence >= 0.40) {
        highConfDets.push({ box, idx });
      } else {
        lowConfDets.push({ box, idx });
      }
    });

    const unassignedHigh = new Set<number>(highConfDets.map(d => d.idx));
    const unassignedLow = new Set<number>(lowConfDets.map(d => d.idx));

    // 2. Predict next position for active tracks using velocity (Kalman/Constant Velocity model)
    this.activeTracks.forEach((track) => {
      const dt = this.frameIndex - track.lastSeenFrame;
      if (this.shouldPredictTrack(track)) {
        track.predictedBbox = {
          x: track.bbox.x + track.vx * Math.min(dt, this.maxPredictionFrames),
          y: track.bbox.y + track.vy * Math.min(dt, this.maxPredictionFrames),
          width: track.bbox.width,
          height: track.bbox.height,
          confidence: track.bbox.confidence,
        };
      } else {
        track.predictedBbox = undefined;
      }
    });

    // 3. First Stage Association: Match Active Tracks with High Confidence Detections
    this.activeTracks.forEach((track) => {
      if (this.shouldSkipAssociationAfterGap(track)) return;

      const hasPlateEvidence = (track.votes && track.votes.size > 0) || Boolean(track.stabilizedPlate);
      let bestMatchScore = 0;
      let bestIdx = -1;
      let bestIoU = 0;

      highConfDets.forEach(({ box, idx }) => {
        if (!unassignedHigh.has(idx)) return;
        const targetBox = track.predictedBbox || track.bbox;
        const iouPredicted = track.predictedBbox ? calculateIoU(track.predictedBbox, box) : 0;
        const iouCurrent = calculateIoU(track.bbox, box);
        const maxIoU = Math.max(iouPredicted, iouCurrent);

        // Crucial: A track with plate evidence MUST have physical spatial overlap.
        // It must NEVER be hijacked by an unrelated detection across empty space!
        if (hasPlateEvidence && maxIoU < 0.08) return;
        if (!this.shouldPredictTrack(track) && maxIoU <= this.iouThreshold) return;
        if (!this.isScaleCompatible(targetBox, box)) return;

        const dist = calculateCentroidDistance(targetBox, box);
        const maxDist = this.getAssociationDistanceLimit(track, targetBox, box.confidence);

        let score = 0;
        if (maxIoU > this.iouThreshold) {
          score = 1.0 + maxIoU; // prioritize IoU
        } else if (maxIoU >= 0.08) {
          score = 0.6 + maxIoU; // partial overlap with prediction/current
        } else if (!hasPlateEvidence && dist < maxDist * 0.75) {
          score = (1.0 - (dist / maxDist)) * 0.5; // fallback to distance only for unverified tracks
        }

        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestIdx = idx;
          bestIoU = maxIoU;
        }
      });

      if (bestIdx !== -1) {
        const matchedBox = detectedBoxes[bestIdx];
        this.markMatchedTrack(track, matchedBox, 0.62, 0.45, bestIoU);
        unassignedHigh.delete(bestIdx);
      }
    });

    // 4. Second Stage Association: Match Unassigned Tracks with Low Confidence Detections
    this.activeTracks.forEach((track) => {
      if (track.lastSeenFrame === this.frameIndex) return; // Already updated in Stage 1
      if (this.shouldSkipAssociationAfterGap(track)) return;

      const hasPlateEvidence = (track.votes && track.votes.size > 0) || Boolean(track.stabilizedPlate);
      let bestMatchScore = 0;
      let bestIdx = -1;
      let bestIoU = 0;

      lowConfDets.forEach(({ box, idx }) => {
        if (!unassignedLow.has(idx)) return;
        const targetBox = track.predictedBbox || track.bbox;
        const iouPredicted = track.predictedBbox ? calculateIoU(track.predictedBbox, box) : 0;
        const iouCurrent = calculateIoU(track.bbox, box);
        const maxIoU = Math.max(iouPredicted, iouCurrent);

        if (hasPlateEvidence && maxIoU < 0.10) return;
        if (!this.shouldPredictTrack(track) && maxIoU <= this.iouThreshold) return;
        if (!this.isScaleCompatible(targetBox, box)) return;

        const dist = calculateCentroidDistance(targetBox, box);
        const maxDist = this.getAssociationDistanceLimit(track, targetBox, box.confidence) * 0.80;

        let score = 0;
        if (maxIoU > this.iouThreshold * 0.8) {
          score = 1.0 + maxIoU;
        } else if (maxIoU >= 0.08) {
          score = 0.5 + maxIoU;
        } else if (!hasPlateEvidence && dist < maxDist * 0.65) {
          score = (1.0 - (dist / maxDist)) * 0.4;
        }

        if (score > bestMatchScore) {
          bestMatchScore = score;
          bestIdx = idx;
          bestIoU = maxIoU;
        }
      });

      if (bestIdx !== -1) {
        const matchedBox = detectedBoxes[bestIdx];
        this.markMatchedTrack(track, matchedBox, 0.48, 0.36, bestIoU);
        unassignedLow.delete(bestIdx);
      }
    });

    // 5. Create New Tracks for Unassigned High Confidence Detections
    unassignedHigh.forEach((idx) => {
      // Enforce max active tracks limit
      if (this.activeTracks.size >= this.maxActiveTracks) return;

      const box = detectedBoxes[idx];
      if (box.width < 35 || box.height < 10) return;

      const num = this.trackCounter++;
      const now = Date.now();
      const newTrack: ActiveTrack = {
        trackId: `TRK-${num}`,
        trackNumber: num,
        bbox: { ...box },
        smoothBbox: { ...box },
        vx: 0,
        vy: 0,
        cropSamples: [],
        lastSeenFrame: this.frameIndex,
        firstSeenFrame: this.frameIndex,
        lastSeenTimestamp: now,
        firstSeenTimestamp: now,
        framesSeen: 1,
        visibleThisFrame: true,
        missedFrames: 0,
        motionScore: 0,
        trackConfidence: this.calculateInitialTrackConfidence(box.confidence),
        confidenceComponents: this.createInitialConfidenceComponents(box.confidence),
        trackState: 'VISIBLE',
        pipelineState: 'DETECTED',
        stats: {
          startedAt: now,
          lastUpdatedAt: now,
          framesVisible: 1,
          framesLost: 0,
          ocrAttempts: 0,
          ocrAccepted: 0,
          consensusAttempts: 0,
        },
        ocrState: 'DETECTED',
        ocrRunning: false,
        ocrJobQueued: false,
        votes: new Map(),
        cooldownActive: false,
        isConfirmed: box.confidence >= 0.72, // Only highly confident YOLO detections confirm on frame 1
      };
      this.activeTracks.set(newTrack.trackId, newTrack);
    });

    // 6. Remove Stale Tracks by Timestamp & Prune Non-Plate False Positives
    const now = Date.now();
    this.activeTracks.forEach((track, id) => {
      const timeLostMs = now - (track.lastSeenTimestamp || 0);
      const isPersistentFalsePositive =
        track.framesSeen >= 5 &&
        (!track.votes || track.votes.size === 0) &&
        !track.stabilizedPlate &&
        (track.bbox.confidence < 0.65 || (track.stats?.ocrAttempts ?? 0) >= 2);

      const effectiveTimeoutMs = isPersistentFalsePositive
        ? 150
        : track.isConfirmed
        ? track.cooldownActive
          ? this.completedTrackLostTimeoutMs
          : this.lostTrackTimeoutMs
        : this.unconfirmedTrackTimeoutMs;

      if (timeLostMs > effectiveTimeoutMs || (isPersistentFalsePositive && !track.visibleThisFrame)) {
        track.trackState = 'REMOVED';
        track.pipelineState = track.cooldownActive ? 'FINISHED' : track.pipelineState;
        if (track.stats) {
          track.stats.finishedAt = now;
          track.stats.finalConfidence = track.stabilizedConfidence ?? track.trackConfidence;
          track.stats.lastUpdatedAt = now;
        }
        this.activeTracks.delete(id);
      } else if (!track.visibleThisFrame) {
        track.missedFrames = Math.max(1, this.frameIndex - track.lastSeenFrame);
        track.trackState = 'LOST';
        track.predictedBbox = undefined;
        track.trackConfidence = Math.round(Math.max(0, (track.trackConfidence ?? 0) * 0.65) * 100) / 100;
        if (track.stats) {
          track.stats.framesLost++;
          track.stats.lastUpdatedAt = now;
        }
      }
    });

    return Array.from(this.activeTracks.values());
  }

  public getActiveTracks(confirmedOnly: boolean = false): ActiveTrack[] {
    const all = Array.from(this.activeTracks.values());
    if (confirmedOnly) return all.filter(t => t.isConfirmed);
    return all;
  }

  public getTrack(trackId: string): ActiveTrack | undefined {
    return this.activeTracks.get(trackId);
  }

  public setLostTrackTimeout(frames: number): void {
    this.lostTrackTimeout = frames;
    this.lostTrackTimeoutMs = Math.min(1000, Math.max(300, frames * 60));
    this.completedTrackLostTimeoutMs = Math.min(350, this.lostTrackTimeoutMs);
  }

  public configureRuntime(options: TrackerRuntimeTuning): void {
    if (typeof options.maxPredictionFrames === 'number') {
      this.maxPredictionFrames = Math.max(0, Math.min(4, Math.round(options.maxPredictionFrames)));
    }
    if (typeof options.lostTrackTimeoutMs === 'number') {
      this.lostTrackTimeoutMs = Math.max(120, Math.min(1000, Math.round(options.lostTrackTimeoutMs)));
      this.lostTrackTimeout = Math.max(1, Math.round(this.lostTrackTimeoutMs / 60));
      this.completedTrackLostTimeoutMs = Math.min(350, this.lostTrackTimeoutMs);
    }
    if (typeof options.unconfirmedTrackTimeoutMs === 'number') {
      this.unconfirmedTrackTimeoutMs = Math.max(80, Math.min(400, Math.round(options.unconfirmedTrackTimeoutMs)));
    }
  }

  public setMaxActiveTracks(maxTracks: number): void {
    if (Number.isFinite(maxTracks) && maxTracks > 0) {
      this.maxActiveTracks = Math.max(1, Math.floor(maxTracks));
    }
  }

  public clear(): void {
    this.activeTracks.clear();
    this.frameIndex = 0;
    this.trackCounter = 1;
  }
}
