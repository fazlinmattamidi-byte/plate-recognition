import { describe, it, expect } from 'vitest';
import {
  normalizePlate,
  generateCandidatePlates,
  isPossibleMatch,
  isRepeatedCharacterOmission,
  formatDisplayPlate,
  correctMalaysianTypographyOcr,
} from '../lib/anpr/normaliser';
import { validateMalaysianPattern } from '../lib/anpr/patterns';
import { evaluateDatabaseMatch } from '../lib/anpr/matchingEngine';
import { PlateQRepository } from '../lib/db/repository';
import { parseAndValidateVehiclesCsv } from '../lib/utils/csv';
import { evaluateConsensus, promoteCorrectedOcrVote } from '../lib/anpr/consensus';
import { ActiveTrack } from '../lib/anpr/tracker';
import { VALIDATION_MANIFEST } from '../lib/anpr/validationManifest';
import {
  createAdaptiveScannerConfig,
  ENVIRONMENT_CLASSES,
  EnvironmentProfile,
  isEnvironmentProfileActionable,
  PLATE_QUALITY_CLASSES,
} from '../lib/anpr/adaptiveConfig';
import {
  correctMalaysianPlateOcr,
  rankSpecialSeriesPrefixCandidates,
  resetRuntimeSpecialSeriesPrefixes,
  setRuntimeSpecialSeriesPrefixes,
} from '../lib/anpr/specialSeries';

describe('PlateQ Universal ANPR Pipeline & Pattern Engine Tests', () => {

  it('normalises plate strings correctly preserving suffixes and long words', () => {
    expect(normalizePlate('  jSd-8888  ')).toBe('JSD8888');
    expect(normalizePlate('kv 1234 e')).toBe('KV1234E');
    expect(normalizePlate('w 1234 a')).toBe('W1234A');
    expect(normalizePlate('ev-1234')).toBe('EV1234');
    expect(normalizePlate('putrajaya 1234')).toBe('PUTRAJAYA1234');
  });

  it('formats display plates with clear spacing', () => {
    expect(formatDisplayPlate('JSD8888')).toBe('JSD 8888');
    expect(formatDisplayPlate('EV1234')).toBe('EV 1234');
    expect(formatDisplayPlate('KV1234E')).toBe('KV 1234 E');
    expect(formatDisplayPlate('W1234A')).toBe('W 1234 A');
    expect(formatDisplayPlate('MALAYSIA200')).toBe('MALAYSIA 200');
    expect(formatDisplayPlate('PUTRAJAYA1')).toBe('PUTRAJAYA 1');
    expect(formatDisplayPlate('WXY77B8')).toBe('WXY 77 B8');
  });

  it('validates all 13 Malaysian plate pattern categories correctly', () => {
    expect(validateMalaysianPattern('EV1234').category).toBe('EV_SPECIAL');
    expect(validateMalaysianPattern('EVA12345').category).toBe('EV_SPECIAL');
    expect(validateMalaysianPattern('KV1234E').category).toBe('LANGKAWI');
    expect(validateMalaysianPattern('W1234A').category).toBe('LETTER_NUMBER_SUFFIX');
    expect(validateMalaysianPattern('SAB1234').category).toBe('SABAH');
    expect(validateMalaysianPattern('QAB1234').category).toBe('SARAWAK');
    expect(validateMalaysianPattern('QAA1234').category).toBe('SARAWAK');
    expect(validateMalaysianPattern('PUTRAJAYA1234').category).toBe('PUTRAJAYA');
    expect(validateMalaysianPattern('PUTRAJAYA1').category).toBe('PUTRAJAYA');
    expect(validateMalaysianPattern('1122DP').category).toBe('DIPLOMATIC');
    expect(validateMalaysianPattern('Z1234').category).toBe('GOVERNMENT');
    expect(validateMalaysianPattern('PATRIOT123').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('MALAYSIA200').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('MALAYSIA1').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('MALAYSIA2020').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('MADANI888').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('GOLD2025').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('PERODUA1').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('PROTON1').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('LOTUS1').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('VIP88').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('FF99').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('QV999').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('VEP1234').category).toBe('INSTITUTIONAL');
    expect(validateMalaysianPattern('JSD8888').category).toBe('STANDARD');
    expect(validateMalaysianPattern('ABC123').category).toBe('STANDARD');
    expect(validateMalaysianPattern('VNA453').category).toBe('STANDARD');
    expect(validateMalaysianPattern('WWW1').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('WWW888').category).toBe('SPECIAL_SERIES');
    expect(validateMalaysianPattern('B20').category).toBe('STANDARD');
    expect(validateMalaysianPattern('A1').category).toBe('STANDARD');
    expect(validateMalaysianPattern('B1').category).toBe('STANDARD');
    expect(validateMalaysianPattern('C1').category).toBe('STANDARD');
    expect(validateMalaysianPattern('JQ1234').category).toBe('STANDARD');
  });

  it('rejects common non-plate English word false positives (SH4RE, S4VE, etc.)', () => {
    expect(validateMalaysianPattern('SH4RE').isValid).toBe(false);
    expect(validateMalaysianPattern('S4VE').isValid).toBe(false);
    expect(validateMalaysianPattern('C0DE').isValid).toBe(false);
    expect(validateMalaysianPattern('D4TE').isValid).toBe(false);
    expect(validateMalaysianPattern('L1NE').isValid).toBe(false);
    expect(validateMalaysianPattern('P4GE').isValid).toBe(false);

    // Valid single-letter suffix series must remain valid
    expect(validateMalaysianPattern('W1234A').isValid).toBe(true);
    expect(validateMalaysianPattern('V123A').isValid).toBe(true);
    expect(validateMalaysianPattern('KV1234E').isValid).toBe(true);
  });

  it('generates character confusion candidates for OCR ambiguity', () => {
    const candidates = generateCandidatePlates('WXY77B8');
    expect(candidates).toContain('WXY7788');
    expect(generateCandidatePlates('G0LD88')).toContain('GOLD88');
    expect(generateCandidatePlates('SRM3028')).toContain('SAM3028');
  });

  it('corrects special series OCR using Malaysian context', () => {
    expect(correctMalaysianPlateOcr('MALAYS1A200').normalized).toBe('MALAYSIA200');
    expect(correctMalaysianPlateOcr('MALAYSA200', { ocrConfidence: 0.96 }).normalized).toBe('MALAYSIA200');
    expect(correctMalaysianPlateOcr('MALRYSIA2020', { ocrConfidence: 0.93 }).normalized).toBe('MALAYSIA2020');
    expect(correctMalaysianPlateOcr('MADA N1888').normalized).toBe('MADANI888');
    expect(correctMalaysianPlateOcr('PUTRAJAYA I').normalized).toBe('PUTRAJAYA1');
    expect(correctMalaysianPlateOcr('PUTRAJYA88', { ocrConfidence: 0.94 }).normalized).toBe('PUTRAJAYA88');
    expect(correctMalaysianPlateOcr('WWWI').normalized).toBe('WWW1');
    expect(correctMalaysianPlateOcr('G0LD88').normalized).toBe('GOLD88');
    expect(correctMalaysianPlateOcr('JSD8888', { ocrConfidence: 0.99 }).normalized).toBe('JSD8888');
  });

  it('corrects conservative Malaysian typography confusions without broad R/A rewrites', () => {
    expect(correctMalaysianTypographyOcr('SRM3028', { ocrConfidence: 0.97 }).normalized).toBe('SAM3028');
    expect(correctMalaysianTypographyOcr('JRD8888', { ocrConfidence: 0.97 }).normalized).toBe('JRD8888');
    expect(isPossibleMatch('SRM3028', 'SAM3028')).toBe(true);
  });

  it('ranks registered special prefixes by probability evidence', () => {
    const [topMalaysia] = rankSpecialSeriesPrefixCandidates('MALAYSA200', { ocrConfidence: 0.96 });
    expect(topMalaysia.plate).toBe('MALAYSIA200');
    expect(topMalaysia.editDistance).toBe(1);
    expect(topMalaysia.score).toBeGreaterThan(0.8);

    const [topPutrajaya] = rankSpecialSeriesPrefixCandidates('PUTRAJYA88', { ocrConfidence: 0.94 });
    expect(topPutrajaya.plate).toBe('PUTRAJAYA88');
    expect(topPutrajaya.prefixProbability).toBeGreaterThan(0.75);
  });

  it('accepts future special series from runtime configuration', () => {
    setRuntimeSpecialSeriesPrefixes(['RX']);
    expect(validateMalaysianPattern('RX1').category).toBe('SPECIAL_SERIES');
    expect(formatDisplayPlate('RX1')).toBe('RX 1');
    resetRuntimeSpecialSeriesPrefixes();
  });

  it('uses runtime special prefixes in probability correction', () => {
    setRuntimeSpecialSeriesPrefixes(['RXPRIME']);
    expect(correctMalaysianPlateOcr('RXPR1ME88', { ocrConfidence: 0.95 }).normalized).toBe('RXPRIME88');
    resetRuntimeSpecialSeriesPrefixes();
  });

  it('detects possible matches correctly (edit distance & confusion)', () => {
    expect(isPossibleMatch('WXY77B8', 'WXY7788')).toBe(true);
    expect(isPossibleMatch('JSD8888', 'ABC9999')).toBe(false);
    expect(isRepeatedCharacterOmission('AN7569', 'ANN7569')).toBe(true);
    expect(isRepeatedCharacterOmission('AB7569', 'ANN7569')).toBe(false);
  });

  it('evaluates database matching using ranking engine', () => {
    const allVehicles = PlateQRepository.listVehicles();

    // Exact Match
    const exactRes = evaluateDatabaseMatch('JSD8888', 0.95, allVehicles);
    expect(exactRes.matchType).toBe('EXACT');
    expect(exactRes.matchedVehicle?.customerName).toBe('Siti');

    const repeatedCharRes = evaluateDatabaseMatch('AN7569', 0.95, allVehicles);
    expect(repeatedCharRes.matchType).toBe('EXACT');
    expect(repeatedCharRes.normalizedPlate).toBe('ANN7569');

    const movingRepeatedCharRes = evaluateDatabaseMatch('AN7569', 0.62, allVehicles, [], 0.58);
    expect(movingRepeatedCharRes.matchType).toBe('EXACT');
    expect(movingRepeatedCharRes.normalizedPlate).toBe('ANN7569');

    // Possible Match
    const possRes = evaluateDatabaseMatch('WXY77B8', 0.85, allVehicles);
    expect(possRes.matchType).toBe('POSSIBLE');
    expect(possRes.possibleMatches.length).toBeGreaterThan(0);

    // No Case Match
    const noRes = evaluateDatabaseMatch('ABC9999', 0.90, allVehicles);
    expect(noRes.matchType).toBe('NONE');

    // Insufficient Confidence
    const lowRes = evaluateDatabaseMatch('JSD8888', 0.40, allVehicles, [], 0.65);
    expect(lowRes.matchType).toBe('INSUFFICIENT_CONFIDENCE');
  });

  it('evaluates multi-frame consensus voting per track', () => {
    const mockTrack: ActiveTrack = {
      trackId: 'trk-1',
      trackNumber: 1,
      bbox: { x: 10, y: 10, width: 100, height: 30, confidence: 0.9 },
      cropSamples: [],
      lastSeenFrame: 5,
      firstSeenFrame: 1,
      framesSeen: 5,
      ocrState: 'CONSENSUS_BUILDING',
      ocrRunning: false,
      ocrJobQueued: false,
      cooldownActive: false,
      votes: new Map([
        ['VAB1234', { count: 3, totalConfidence: 2.7 }],
        ['VAB123A', { count: 1, totalConfidence: 0.7 }],
      ]),
    };

    const consensus = evaluateConsensus(mockTrack, 3, 0.65);
    expect(consensus.isStabilized).toBe(true);
    expect(consensus.normalizedPlate).toBe('VAB1234');
    expect(consensus.displayPlate).toBe('VAB 1234');
  });

  it('promotes database-corrected repeated-character OCR votes back onto the track', () => {
    const mockTrack: ActiveTrack = {
      trackId: 'trk-motion-1',
      trackNumber: 1,
      bbox: { x: 10, y: 10, width: 100, height: 30, confidence: 0.9 },
      cropSamples: [],
      lastSeenFrame: 5,
      firstSeenFrame: 1,
      framesSeen: 5,
      ocrState: 'CONSENSUS_BUILDING',
      ocrRunning: false,
      ocrJobQueued: false,
      cooldownActive: false,
      votes: new Map([
        ['AN7569', { count: 2, totalConfidence: 1.3 }],
      ]),
    };

    promoteCorrectedOcrVote(mockTrack, 'AN7569', 'ANN7569', 0.62, 0.8);

    expect(mockTrack.votes.has('AN7569')).toBe(false);
    expect(mockTrack.votes.get('ANN7569')?.count).toBe(2);
    expect(mockTrack.stabilizedPlate).toBe('ANN7569');
    expect(mockTrack.stabilizedConfidence).toBe(0.62);
  });

  it('parses CSV data and validates entries correctly', () => {
    const sampleCsv = `plateNumber,customerName,vehicleMake,vehicleModel,vehicleColor,financeCompany,outstandingAmount,caseReference,status,notes
TEST1234,Farid,Proton,S70,Silver,Maybank,25000.00,MBB999,ACTIVE,New test case`;

    const existingPlates = new Set<string>(['ANN7569']);
    const valRes = parseAndValidateVehiclesCsv(sampleCsv, existingPlates);

    expect(valRes.validRows.length).toBe(1);
    expect(valRes.validRows[0].plateNumber).toBe('TEST1234');
    expect(valRes.invalidRows.length).toBe(0);
  });

  it('runs validation dataset manifest benchmark and reports accuracy by category', () => {
    PlateQRepository.resetDemoData();
    const allVehicles = PlateQRepository.listVehicles();

    let totalCases = 0;
    let correctMatches = 0;
    const categoryStats: Record<string, { total: number; correct: number }> = {};

    VALIDATION_MANIFEST.forEach(tc => {
      totalCases++;
      const cat = tc.expectedCategory;
      if (!categoryStats[cat]) categoryStats[cat] = { total: 0, correct: 0 };
      categoryStats[cat].total++;

      const res = evaluateDatabaseMatch(tc.groundTruthPlate, 0.90, allVehicles);
      const isCorrect =
        (tc.expectedMatchStatus === 'EXACT' && res.matchType === 'EXACT') ||
        (tc.expectedMatchStatus === 'POSSIBLE' && res.matchType === 'POSSIBLE') ||
        (tc.expectedMatchStatus === 'NONE' && res.matchType === 'NONE') ||
        (tc.expectedMatchStatus === 'CLOSED' && res.matchType === 'NONE');

      if (isCorrect) {
        correctMatches++;
        categoryStats[cat].correct++;
      }
    });

    const overallAccuracy = (correctMatches / totalCases) * 100;
    expect(overallAccuracy).toBeGreaterThanOrEqual(90);
  });

  it('adapts scanner configuration for night, rain, and highway environments', () => {
    const profile = (label: EnvironmentProfile['label']): EnvironmentProfile => ({
      label,
      confidence: 0.95,
      source: 'HEURISTIC',
      sampledAt: Date.now(),
    });

    const night = createAdaptiveScannerConfig(profile('NIGHT'));
    expect(night.processing.preprocessingVariants).toContain('CLAHE');
    expect(night.ocr.consensusVotes).toBeGreaterThanOrEqual(4);
    expect(night.buffer.maxSize).toBeGreaterThan(6);

    const rain = createAdaptiveScannerConfig(profile('RAIN'));
    expect(rain.ocr.firstReadMinQuality).toBeGreaterThan(night.ocr.firstReadMinQuality);
    expect(rain.track.lifetimeMultiplier).toBeGreaterThan(1);

    const highway = createAdaptiveScannerConfig(profile('HIGHWAY'));
    expect(highway.detector.targetIntervalMs).toBeLessThan(night.detector.targetIntervalMs);
    expect(highway.ocr.maxCandidateCrops).toBeLessThan(night.ocr.maxCandidateCrops);
    expect(highway.track.prioritizeHighestConfidence).toBe(true);
  });

  it('uses the BDD100K environment classifier class set', () => {
    expect(ENVIRONMENT_CLASSES).toEqual([
      'BACKLIGHT',
      'DAY',
      'FOG',
      'GLARE',
      'GOOD_CONDITION',
      'HEAVY_RAIN',
      'HIGHWAY',
      'LOW_LIGHT',
      'NIGHT',
      'PARKING',
      'RAIN',
      'TRAFFIC',
      'TUNNEL',
    ]);
  });

  it('gates environment adaptation by classifier confidence', () => {
    const classifierProfile = (confidence: number): EnvironmentProfile => ({
      label: 'RAIN',
      confidence,
      source: 'YOLOV8_CLASSIFIER',
      sampledAt: Date.now(),
    });

    const heuristicProfile = (confidence: number): EnvironmentProfile => ({
      label: 'NIGHT',
      confidence,
      source: 'HEURISTIC',
      sampledAt: Date.now(),
    });

    expect(isEnvironmentProfileActionable(classifierProfile(0.69))).toBe(false);
    expect(isEnvironmentProfileActionable(classifierProfile(0.70))).toBe(true);
    expect(isEnvironmentProfileActionable(heuristicProfile(0.57))).toBe(false);
    expect(isEnvironmentProfileActionable(heuristicProfile(0.58))).toBe(true);
  });

  it('uses the plate-quality classifier class set', () => {
    expect(PLATE_QUALITY_CLASSES).toEqual([
      'GOOD',
      'STANDARD_RECTANGLE',
      'SQUARE_PLATE',
      'TWO_LINE_PLATE',
      'EV_WHITE_PLATE',
      'SLIGHT_ROTATION',
      'PERSPECTIVE_DISTORTION',
      'MOTION_BLUR',
      'OUT_OF_FOCUS',
      'TOO_SMALL',
      'LOW_CONTRAST',
      'OVEREXPOSED',
      'UNDEREXPOSED',
      'GLARE_REFLECTION',
      'OCCLUDED',
      'BAD_ANGLE',
    ]);
  });
});
