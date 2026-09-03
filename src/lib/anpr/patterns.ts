import { PlateCategory, PlateLayout } from '../db/types';
import {
  getSpecialSeriesPrefixPatternSource,
  isConfiguredSpecialSeriesCandidate,
  isFutureSpecialSeriesCandidate,
  DEFAULT_SPECIAL_SERIES_PREFIXES,
} from './specialSeries';

export interface PlatePatternDefinition {
  id: string;
  category: PlateCategory;
  description: string;
  prefixRules?: string[];
  regex: RegExp;
  minLen: number;
  maxLen: number;
  hasTrailingSuffix?: boolean;
  expectedLayout?: PlateLayout;
  priority: number; // Higher number = higher priority matching
  isStrict: boolean;
}

const LETTERS = '[A-Z]';
const DIGITS = '[0-9]';
const SHORT_NUMBER = `${DIGITS}{1,5}`;

/**
 * Recognized Sabah state registration prefixes
 */
export const SABAH_PREFIXES = ['SA', 'SB', 'SD', 'SK', 'SS', 'ST', 'SU', 'SW', 'S'];

/**
 * Recognized Sarawak state registration prefixes
 */
export const SARAWAK_PREFIXES = ['QA', 'QB', 'QC', 'QD', 'QK', 'QL', 'QP', 'QR', 'QS', 'QT', 'Q'];

/**
 * Recognized special/commemorative registration series
 */
export const SPECIAL_SERIES_PREFIXES = [...DEFAULT_SPECIAL_SERIES_PREFIXES];

const SPECIAL_SERIES_REGEX = new RegExp(`^(${getSpecialSeriesPrefixPatternSource()})${SHORT_NUMBER}${LETTERS}?$`);

/**
 * Configurable Malaysian Plate Pattern Registry.
 * Guiding candidate ranking without forcing rigid single regex locks.
 */
export const MALAYSIAN_PATTERNS: PlatePatternDefinition[] = [
  // 1. EV Special Registration Series (EV1 - EV99999, then EVA/EVB-style running prefixes)
  {
    id: 'EV_SPECIAL',
    category: 'EV_SPECIAL',
    description: 'Electric Vehicle EV Special Series (e.g. EV1234, EVA1234)',
    regex: /^EV[A-Z]{0,2}[0-9]{1,5}[A-Z]?$/,
    minLen: 3,
    maxLen: 9,
    priority: 100,
    isStrict: true,
  },

  // 2. Langkawi Series (KV1234E / KV1234)
  {
    id: 'LANGKAWI_SUFFIX',
    category: 'LANGKAWI',
    description: 'Langkawi Series with Alphabetic Suffix (e.g. KV1234E)',
    regex: /^KV[0-9]{1,5}[A-Z]$/,
    minLen: 4,
    maxLen: 8,
    hasTrailingSuffix: true,
    priority: 95,
    isStrict: true,
  },
  {
    id: 'LANGKAWI_STANDARD',
    category: 'LANGKAWI',
    description: 'Langkawi Standard Series (e.g. KV1234)',
    regex: /^KV[0-9]{1,5}$/,
    minLen: 3,
    maxLen: 7,
    priority: 90,
    isStrict: true,
  },

  // 3. Letter-Number-Letter Sequences (W1A, W1234A, B123A)
  {
    id: 'LETTER_NUMBER_SUFFIX',
    category: 'LETTER_NUMBER_SUFFIX',
    description: 'KL/Peninsular Letter-Number-Letter Series (e.g. W1234A, V123A)',
    regex: /^[A-Z]{1,3}[0-9]{1,5}[A-Z]$/,
    minLen: 3,
    maxLen: 9,
    hasTrailingSuffix: true,
    priority: 85,
    isStrict: true,
  },

  // 4. Sabah Regional Families (SAB1234, SA1234A, S123A, SD1234)
  {
    id: 'SABAH_SUFFIX',
    category: 'SABAH',
    description: 'Sabah Series with Suffix (e.g. SA1234A, SD1234K)',
    regex: /^(SA|SB|SD|SK|SS|ST|SU|SW|S)[A-Z]{0,2}[0-9]{1,5}[A-Z]$/,
    minLen: 3,
    maxLen: 9,
    hasTrailingSuffix: true,
    priority: 88,
    isStrict: true,
  },
  {
    id: 'SABAH_STANDARD',
    category: 'SABAH',
    description: 'Sabah Standard Series (e.g. SAB1234, SA1234, S1234)',
    regex: /^(SA|SB|SD|SK|SS|ST|SU|SW|S)[A-Z]{0,2}[0-9]{1,5}$/,
    minLen: 2,
    maxLen: 9,
    priority: 85,
    isStrict: true,
  },

  // 5. Sarawak Regional Families (QAA1234, QA1234, Q1234)
  {
    id: 'SARAWAK_SUFFIX',
    category: 'SARAWAK',
    description: 'Sarawak Series with Suffix (e.g. QAA1234A, QA1234A)',
    regex: /^(QA|QB|QC|QD|QK|QL|QP|QR|QS|QT|Q)[A-Z]{0,2}[0-9]{1,5}[A-Z]$/,
    minLen: 3,
    maxLen: 9,
    hasTrailingSuffix: true,
    priority: 88,
    isStrict: true,
  },
  {
    id: 'SARAWAK_STANDARD',
    category: 'SARAWAK',
    description: 'Sarawak Standard Series (e.g. QAA1234, QK1234, Q1234)',
    regex: /^(QA|QB|QC|QD|QK|QL|QP|QR|QS|QT|Q)[A-Z]{0,2}[0-9]{1,5}$/,
    minLen: 2,
    maxLen: 8,
    priority: 85,
    isStrict: true,
  },

  // 6. Putrajaya & Long Word Series (PUTRAJAYA1234)
  {
    id: 'PUTRAJAYA',
    category: 'PUTRAJAYA',
    description: 'Putrajaya Series (e.g. PUTRAJAYA1, PUTRAJAYA1234)',
    regex: /^PUTRAJAYA[0-9]{1,5}$/,
    minLen: 10,
    maxLen: 14,
    priority: 85,
    isStrict: true,
  },

  // 7. Diplomatic & International Series (1122DP, DP1234, CC1234, DC1234)
  {
    id: 'DIPLOMATIC',
    category: 'DIPLOMATIC',
    description: 'Diplomatic / Consular Series (e.g. 1122DP, DP1234, CC1234)',
    regex: /^([0-9]{1,6}(DP|DC|CC|UN)|(DP|DC|CC|UN)[0-9]{1,5})$/,
    minLen: 3,
    maxLen: 8,
    priority: 90,
    isStrict: true,
  },

  // 8. Government / Armed Forces / Police Series
  {
    id: 'GOVERNMENT',
    category: 'GOVERNMENT',
    description: 'Government & Enforcement Series (e.g. Z1234, JKR1234, POLIS1234)',
    regex: /^(Z|JKR|POLIS|TDM|TLDM|TUDM|APMM|PRISON|KASTAM)[0-9]{1,5}[A-Z]?$/,
    minLen: 2,
    maxLen: 11,
    priority: 82,
    isStrict: true,
  },

  // 9. Institutional / permit-like prefixes encountered on Malaysian roads
  {
    id: 'INSTITUTIONAL_PREFIX',
    category: 'INSTITUTIONAL',
    description: 'Institutional or permit-style prefix series (e.g. VEP1234)',
    regex: /^(VEP|JPJ|MOT|SPAD|LPT|PLUS|PRASARANA)[0-9]{1,5}[A-Z]?$/,
    minLen: 4,
    maxLen: 11,
    priority: 83,
    isStrict: false,
  },

  // 10. Approved Special / Institutional Series (PATRIOT123, UTM1234, MADANI1)
  {
    id: 'SPECIAL_SERIES',
    category: 'SPECIAL_SERIES',
    description: 'Configurable special, premium & commemorative series (e.g. MADANI123, GOLD1, FF99)',
    regex: SPECIAL_SERIES_REGEX,
    minLen: 3,
    maxLen: 15,
    priority: 80,
    isStrict: false,
  },

  // 11. Future JPJ special releases with longer word-like prefixes
  {
    id: 'FUTURE_SPECIAL_SERIES',
    category: 'SPECIAL_SERIES',
    description: 'Future configurable JPJ special series fallback (4-12 letters + 1-5 digits)',
    regex: /^[A-Z]{4,12}[0-9]{1,5}[A-Z]?$/,
    minLen: 5,
    maxLen: 17,
    priority: 62,
    isStrict: false,
  },

  // 12. Standard Peninsular Letter-Number Sequences (A1, A1234, ABC1234, VAB1234)
  {
    id: 'STANDARD_PENINSULAR',
    category: 'STANDARD',
    description: 'Standard Peninsular Series (1-3 letters + 1-5 digits)',
    regex: /^[A-Z]{1,3}[0-9]{1,5}$/,
    minLen: 2,
    maxLen: 8,
    priority: 70,
    isStrict: false,
  },

  // 13. Generic Valid Malaysian Candidate Fallback
  {
    id: 'GENERIC_MALAYSIAN',
    category: 'UNKNOWN_VALID_CANDIDATE',
    description: 'Generic valid alphanumeric sequence (2-15 chars, letter + digit)',
    regex: /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{2,15}$/,
    minLen: 2,
    maxLen: 15,
    priority: 10,
    isStrict: false,
  },
];

export interface PatternValidationResult {
  isValid: boolean;
  pattern?: PlatePatternDefinition;
  category: PlateCategory;
  score: number; // 0.0 to 1.0 confidence boost score
  hasTrailingSuffix: boolean;
}

/**
 * Validates a normalized plate string against the Malaysian Pattern Registry.
 * Returns pattern match, category, and ranking score.
 */
export function validateMalaysianPattern(normalizedPlate: string): PatternValidationResult {
  if (!normalizedPlate || normalizedPlate.length < 2) {
    return {
      isValid: false,
      category: 'UNKNOWN_VALID_CANDIDATE',
      score: 0,
      hasTrailingSuffix: false,
    };
  }

  if (isConfiguredSpecialSeriesCandidate(normalizedPlate) && !/^PUTRAJAYA[0-9]/.test(normalizedPlate)) {
    const pattern = MALAYSIAN_PATTERNS.find((item) => item.id === 'SPECIAL_SERIES');
    if (pattern) {
      return {
        isValid: true,
        pattern,
        category: pattern.category,
        score: Math.min(1.0, pattern.priority / 100),
        hasTrailingSuffix: /[A-Z]$/.test(normalizedPlate) && /[0-9]/.test(normalizedPlate),
      };
    }
  }

  for (const pattern of MALAYSIAN_PATTERNS) {
    if (pattern.id === 'SPECIAL_SERIES' && isConfiguredSpecialSeriesCandidate(normalizedPlate)) {
      return {
        isValid: true,
        pattern,
        category: pattern.category,
        score: Math.min(1.0, pattern.priority / 100),
        hasTrailingSuffix: /[A-Z]$/.test(normalizedPlate) && /[0-9]/.test(normalizedPlate),
      };
    }

    if (pattern.id === 'FUTURE_SPECIAL_SERIES' && isFutureSpecialSeriesCandidate(normalizedPlate)) {
      return {
        isValid: true,
        pattern,
        category: pattern.category,
        score: Math.min(1.0, pattern.priority / 100),
        hasTrailingSuffix: /[A-Z]$/.test(normalizedPlate) && /[0-9]/.test(normalizedPlate),
      };
    }

    if (pattern.regex.test(normalizedPlate)) {
      // Calculate score based on priority and strictness
      const isRecognizedPattern = pattern.id !== 'GENERIC_MALAYSIAN';
      const baseScore = Math.min(1.0, pattern.priority / 100);
      return {
        isValid: isRecognizedPattern,
        pattern,
        category: pattern.category,
        score: baseScore,
        hasTrailingSuffix: !!pattern.hasTrailingSuffix,
      };
    }
  }

  return {
    isValid: false,
    category: 'UNKNOWN_VALID_CANDIDATE',
    score: 0.1,
    hasTrailingSuffix: /[A-Z]$/.test(normalizedPlate) && /[0-9]/.test(normalizedPlate),
  };
}
