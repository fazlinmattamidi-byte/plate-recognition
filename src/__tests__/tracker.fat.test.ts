import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActiveTrack, PlateTracker } from '../lib/anpr/tracker';
import { validateMalaysianPattern } from '../lib/anpr/patterns';

describe('FAT Tests: Tracker Scenarios and Plate Types', () => {
  let tracker: PlateTracker;

  beforeEach(() => {
    tracker = new PlateTracker(20, 8); // lostTrackTimeout = 20, max tracks = 8
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('FAT Scenario 1: Static one vehicle', () => {
    // Frame 1
    const t1 = tracker.updateTracks([{ x: 100, y: 100, width: 80, height: 30, confidence: 0.9 }]);
    expect(t1.length).toBe(1);
    const trackId = t1[0].trackId;

    // Frame 2-10 (Static)
    for (let i = 0; i < 9; i++) {
      const tracks = tracker.updateTracks([{ x: 100, y: 100, width: 80, height: 30, confidence: 0.9 }]);
      expect(tracks.length).toBe(1);
      expect(tracks[0].trackId).toBe(trackId);
    }
  });

  it('FAT Scenario 2: Moving one vehicle', () => {
    // Frame 1
    const t1 = tracker.updateTracks([{ x: 10, y: 10, width: 80, height: 30, confidence: 0.9 }]);
    expect(t1.length).toBe(1);
    const trackId = t1[0].trackId;

    // Moving diagonally across frames
    for (let i = 1; i < 10; i++) {
      const tracks = tracker.updateTracks([{ x: 10 + i * 5, y: 10 + i * 5, width: 80, height: 30, confidence: 0.9 }]);
      expect(tracks.length).toBe(1);
      expect(tracks[0].trackId).toBe(trackId);
      expect(tracks[0].framesSeen).toBe(i + 1);
    }
  });

  it('FAT Scenario 3: Static multiple vehicles', () => {
    // 3 static vehicles
    const boxes = [
      { x: 50, y: 50, width: 80, height: 30, confidence: 0.9 },
      { x: 200, y: 50, width: 80, height: 30, confidence: 0.9 },
      { x: 350, y: 50, width: 80, height: 30, confidence: 0.9 }
    ];

    const t1 = tracker.updateTracks(boxes);
    expect(t1.length).toBe(3);
    const trackIds = t1.map(t => t.trackId);

    // Frame 2-5 (Static)
    for (let i = 0; i < 4; i++) {
      const tracks = tracker.updateTracks(boxes);
      expect(tracks.length).toBe(3);
      expect(tracks.map(t => t.trackId).sort()).toEqual(trackIds.sort());
    }
  });

  it('FAT Scenario 4: Moving multiple vehicles', () => {
    let boxes = [
      { x: 10, y: 50, width: 80, height: 30, confidence: 0.9 },
      { x: 10, y: 150, width: 80, height: 30, confidence: 0.9 }
    ];

    const t1 = tracker.updateTracks(boxes);
    expect(t1.length).toBe(2);
    const trackIds = t1.map(t => t.trackId);

    // Vehicles moving at different speeds
    for (let i = 1; i < 10; i++) {
      boxes = [
        { x: 10 + i * 10, y: 50, width: 80, height: 30, confidence: 0.9 }, // Moves faster
        { x: 10 + i * 5, y: 150, width: 80, height: 30, confidence: 0.9 }  // Moves slower
      ];
      const tracks = tracker.updateTracks(boxes);
      expect(tracks.length).toBe(2);
      expect(tracks.map(t => t.trackId).sort()).toEqual(trackIds.sort());
    }
  });

  it('FAT Scenario 5: Moving camera live (one or more vehicles)', () => {
    // Camera panning means the relative positions of all vehicles shift simultaneously
    let boxes = [
      { x: 100, y: 100, width: 80, height: 30, confidence: 0.9 },
      { x: 300, y: 100, width: 80, height: 30, confidence: 0.9 }
    ];

    const t1 = tracker.updateTracks(boxes);
    expect(t1.length).toBe(2);
    const trackIds = t1.map(t => t.trackId);

    // Camera pans left (vehicles appear to move right)
    for (let i = 1; i < 5; i++) {
      boxes = boxes.map(box => ({ ...box, x: box.x + 20 }));
      const tracks = tracker.updateTracks(boxes);
      expect(tracks.length).toBe(2);
      expect(tracks.map(t => t.trackId).sort()).toEqual(trackIds.sort());
    }
  });

  it('FAT Scenario 6: EV Plate and Normal Plate validation', () => {
    // EV Plate
    const evPlate = validateMalaysianPattern('EV1234');
    expect(evPlate.category).toBe('EV_SPECIAL');
    expect(evPlate.isValid).toBe(true);

    // Normal Plate (Standard)
    const normalPlate = validateMalaysianPattern('BKP1234');
    expect(normalPlate.category).toBe('STANDARD');
    expect(normalPlate.isValid).toBe(true);
  });

  it('FAT Scenario 7: Multi-vehicle validation scaling (1 to 5 plates)', () => {
    // 1 plate
    const boxes = [{ x: 10, y: 10, width: 80, height: 30, confidence: 0.9 }];
    let tracks = tracker.updateTracks(boxes);
    expect(tracks.length).toBe(1);

    // 2 plates
    boxes.push({ x: 100, y: 10, width: 80, height: 30, confidence: 0.9 });
    tracks = tracker.updateTracks(boxes);
    expect(tracks.length).toBe(2);

    // 3 plates
    boxes.push({ x: 190, y: 10, width: 80, height: 30, confidence: 0.9 });
    tracks = tracker.updateTracks(boxes);
    expect(tracks.length).toBe(3);
    
    // 5 plates
    boxes.push({ x: 280, y: 10, width: 80, height: 30, confidence: 0.9 });
    boxes.push({ x: 370, y: 10, width: 80, height: 30, confidence: 0.9 });
    tracks = tracker.updateTracks(boxes);
    expect(tracks.length).toBe(5);

    // Ensure 5 tracks remain confirmed after minConfirmationFrames (2)
    tracks = tracker.updateTracks(boxes);
    expect(tracks.filter(t => t.isConfirmed).length).toBe(5);
  });

  it('FAT Scenario 8: Rain/Night conditions (intermittent frame drops)', () => {
    // Vehicle appears
    let tracks = tracker.updateTracks([{ x: 50, y: 50, width: 80, height: 30, confidence: 0.9 }]);
    expect(tracks.length).toBe(1);
    const trackId = tracks[0].trackId;
    
    // Confirms on frame 2
    tracks = tracker.updateTracks([{ x: 52, y: 50, width: 80, height: 30, confidence: 0.9 }]);
    expect(tracks[0].isConfirmed).toBe(true);
    
    // Heavy rain drop out: detector misses the vehicle for 5 frames
    for(let i = 0; i < 5; i++) {
      tracks = tracker.updateTracks([]); 
      // The track should still survive because lostTrackTimeout is 8
      const track = tracker.getTrack(trackId);
      expect(track).toBeDefined();
    }
    
    // Vehicle reappears
    tracks = tracker.updateTracks([{ x: 62, y: 50, width: 80, height: 30, confidence: 0.8 }]);
    expect(tracks.length).toBe(1);
    expect(tracks[0].trackId).toBe(trackId);
    expect(tracks[0].isConfirmed).toBe(true);
  });

  it('FAT Scenario 9: Performance Benchmark (1000 frames stress test)', () => {
    const start = performance.now();
    
    // 5 moving vehicles over 1000 frames
    for(let i = 0; i < 1000; i++) {
      const boxes = [
        { x: 10 + i%100, y: 10, width: 80, height: 30, confidence: 0.9 },
        { x: 50 + i%100, y: 60, width: 80, height: 30, confidence: 0.9 },
        { x: 90 + i%100, y: 110, width: 80, height: 30, confidence: 0.9 },
        { x: 130 + i%100, y: 160, width: 80, height: 30, confidence: 0.9 },
        { x: 170 + i%100, y: 210, width: 80, height: 30, confidence: 0.9 },
      ];
      tracker.updateTracks(boxes);
    }
    
    const duration = performance.now() - start;
    // Tracker update is O(N*M). For 5 tracks and 1000 frames, it should be highly efficient (under 50ms)
    expect(duration).toBeLessThan(100); 
  });

  it('FAT Scenario 10: active moving tracks refresh timestamp while matched', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    let tracks = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const trackId = tracks[0].trackId;
    expect(tracker.getTrack(trackId)?.lastSeenTimestamp).toBe(1000);

    vi.setSystemTime(2600);
    tracks = tracker.updateTracks([{ x: 118, y: 104, width: 90, height: 30, confidence: 0.9 }]);
    expect(tracks[0].trackId).toBe(trackId);
    expect(tracker.getTrack(trackId)?.lastSeenTimestamp).toBe(2600);

    vi.setSystemTime(4200);
    tracks = tracker.updateTracks([{ x: 135, y: 108, width: 90, height: 30, confidence: 0.8 }]);
    expect(tracks[0].trackId).toBe(trackId);
    expect(tracker.getTrack(trackId)?.lastSeenTimestamp).toBe(4200);
  });

  it('FAT Scenario 11: missed tracks stay alive but are not visible for OCR', () => {
    let tracks = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const trackId = tracks[0].trackId;
    expect(tracks[0].visibleThisFrame).toBe(true);
    expect(tracks[0].missedFrames).toBe(0);

    tracks = tracker.updateTracks([]);
    const retainedTrack = tracker.getTrack(trackId);

    expect(retainedTrack).toBeDefined();
    expect(retainedTrack?.visibleThisFrame).toBe(false);
    expect(retainedTrack?.missedFrames).toBe(1);
    expect(tracks[0].trackId).toBe(trackId);
  });

  it('FAT Scenario 12: completed stale track does not attach to the next vehicle', () => {
    const firstTracks = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const firstTrack = firstTracks[0];
    firstTrack.cooldownActive = true;

    tracker.updateTracks([]);

    const nextTracks = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const visibleTracks = nextTracks.filter((track) => track.visibleThisFrame);

    expect(visibleTracks.length).toBe(1);
    expect(visibleTracks[0].trackId).not.toBe(firstTrack.trackId);
  });

  it('FAT Scenario 13: completed lost tracks expire quickly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const firstTracks = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const firstTrack = firstTracks[0];
    firstTrack.cooldownActive = true;

    vi.setSystemTime(1850);
    tracker.updateTracks([]);

    expect(tracker.getTrack(firstTrack.trackId)).toBeUndefined();
  });

  it('FAT Scenario 14: A/B/A reacquisition starts fresh OCR consensus', () => {
    const carAFirstPass = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const carAOldTrack = carAFirstPass[0];
    carAOldTrack.votes.set('AAA1111', { count: 3, totalConfidence: 2.7 });
    carAOldTrack.stabilizedPlate = 'AAA1111';

    tracker.updateTracks([]);

    const carBPass = tracker.updateTracks([{ x: 104, y: 102, width: 91, height: 30, confidence: 0.9 }]);
    const carBTrack = carBPass.find((track) => track.trackState === 'VISIBLE');

    expect(carBTrack).toBeDefined();
    expect(carBTrack?.trackId).not.toBe(carAOldTrack.trackId);
    expect(carBTrack?.votes.size).toBe(0);

    carBTrack?.votes.set('BBB2222', { count: 3, totalConfidence: 2.7 });
    carBTrack!.stabilizedPlate = 'BBB2222';

    tracker.updateTracks([]);

    const carAReturnPass = tracker.updateTracks([{ x: 100, y: 100, width: 90, height: 30, confidence: 0.9 }]);
    const carANewTrack = carAReturnPass.find((track) => track.trackState === 'VISIBLE');

    expect(carANewTrack).toBeDefined();
    expect(carANewTrack?.trackId).not.toBe(carAOldTrack.trackId);
    expect(carANewTrack?.trackId).not.toBe(carBTrack?.trackId);
    expect(Array.from(carANewTrack?.votes.keys() ?? [])).toEqual([]);

    carANewTrack?.votes.set('AAA1111', { count: 1, totalConfidence: 0.9 });
    expect(Array.from(carANewTrack?.votes.keys() ?? [])).toEqual(['AAA1111']);
  });

  it('FAT Scenario 15: Camera moves away: track with recognized plate never jumps to a distant zero-IoU box', () => {
    // Frame 1: Plate is detected and has plate votes
    const initialTracks = tracker.updateTracks([{ x: 100, y: 100, width: 80, height: 25, confidence: 0.88 }]);
    const plateTrack = initialTracks[0];
    plateTrack.votes.set('WCU6852', { count: 3, totalConfidence: 2.7 });

    // Frame 2: Phone moves away to an unrelated button/box 200px away (0 IoU)
    const movedTracks = tracker.updateTracks([{ x: 300, y: 350, width: 75, height: 24, confidence: 0.82 }]);
    const newBoxTrack = movedTracks.find((t) => t.visibleThisFrame);

    // The plateTrack must NOT be hijacked by the distant box
    expect(newBoxTrack).toBeDefined();
    expect(newBoxTrack?.trackId).not.toBe(plateTrack.trackId);
    expect(newBoxTrack?.votes.size).toBe(0);
    expect(plateTrack.visibleThisFrame).toBe(false);
  });

  it('FAT Scenario 16: Non-plate false positive is rapidly pruned when lost', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    // False positive seen for 5 frames without plate votes and lower confidence
    let tracks: ActiveTrack[] = [];
    for (let i = 0; i < 5; i++) {
      tracks = tracker.updateTracks([{ x: 150, y: 200, width: 60, height: 20, confidence: 0.52 }]);
    }
    const fpTrack = tracks[0];
    expect(fpTrack).toBeDefined();
    expect(fpTrack.votes.size).toBe(0);

    // When phone moves away, the false positive is pruned immediately
    vi.setSystemTime(1200);
    tracker.updateTracks([]);
    expect(tracker.getTrack(fpTrack.trackId)).toBeUndefined();
  });
});
