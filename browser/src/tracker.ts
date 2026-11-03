// SPDX-License-Identifier: Apache-2.0
// The tracker: carries a card across consecutive analyzed frames.
//
// Each analyzed frame's detections (the boxes whose look reaches tau, after suppression) are
// matched to the tracks of the previous frames by overlap. A track gives a card a stable id,
// survives a short gap in detection, and reads its identity from several looks instead of one:
// the embeddings of its most recent detections are averaged, the mean is brought back to unit
// length, and that pooled embedding is matched against the bank with both tau and the margin
// (EmbeddingRecognizer.matchPooled). A single odd frame therefore does not rename a card, and
// a track torn between two identities names nothing.
//
// The track layer is not what a tooltip shows: the hover layer answers from the current frame
// alone (hover-layer.ts). Tracks are for steady outlines.

import { type AABB, iou, type Rect } from "./boxes.js";

/** One detection handed to the tracker. */
export interface Detection {
  aabb: AABB;
  rect: Rect;
  /** The best bank row's card id for this frame's look. */
  cardId: string | null;
  /** The look's unit-length embedding. */
  embedding: Float32Array;
  /** The card's outline when rotated outlines are on (`ScoredProposal.outline`); carried along,
   *  never used to match. */
  outline?: Rect;
}

/** One live track after an update. */
export interface TrackCard {
  instanceId: string;
  detection: Detection;
  /** The pooled identity, or null: not yet old enough, or no identity is clear. */
  identity: string | null;
}

/** A detection joins a track when they overlap by more than this. */
export const TRACK_IOU = 0.4;
/** A track survives this many analyzed frames without a matching detection. */
export const MAX_MISSES = 2;
/** How many of a track's most recent embeddings are pooled. */
export const EMBED_POOL_WINDOW = 5;
/** A track's identity is given only once it has been matched on this many frames: identities
 *  seen on a single frame are the main source of flicker. */
export const MIN_IDENTITY_FRAMES = 2;

/** Prefix of track ids. Hover-layer ids use another, so the two never collide. */
export const TRACK_ID_PREFIX = "track_";

interface Track {
  instanceId: string;
  detection: Detection;
  embeddings: Float32Array[];
  misses: number;
  /** Frames on which this track was matched. */
  age: number;
}

/**
 * The mean of unit-length embeddings, brought back to unit length (each embedding counts the
 * same). Returns null when the mean has no direction, for example two exactly opposed vectors,
 * so that a caller never matches an undefined direction.
 */
export function poolEmbeddings(vectors: readonly Float32Array[]): Float32Array | null {
  const dim = vectors[0]!.length;
  const sum = new Float32Array(dim);
  for (const v of vectors) {
    for (let k = 0; k < dim; k++) sum[k] = sum[k]! + v[k]!;
  }
  let normSq = 0;
  for (let k = 0; k < dim; k++) normSq += sum[k]! * sum[k]!;
  const norm = Math.sqrt(normSq);
  if (!(norm > 0)) return null;
  for (let k = 0; k < dim; k++) sum[k] = sum[k]! / norm;
  return sum;
}

export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;

  /**
   * `identityResolver` is called with a track's pooled embedding on every frame the track is
   * live and returns the card id to show, or null to name nothing.
   */
  constructor(private readonly identityResolver: (pooled: Float32Array) => string | null) {}

  /** Forget every track: the picture is no longer continuous with the last one (a seek, a new
   *  image). Ids keep counting, so a track made after a reset never reuses an id, and every
   *  pooled identity is earned again from nothing. */
  reset(): void {
    this.tracks = [];
  }

  private identityOf(track: Track): string | null {
    if (track.embeddings.length === 0) return null;
    const pooled = poolEmbeddings(track.embeddings);
    return pooled ? this.identityResolver(pooled) : null;
  }

  /**
   * Advance by one analyzed frame. Each existing track, oldest first, takes the unmatched
   * detection it overlaps most, if that overlap is above `TRACK_IOU`; tracks left unmatched for
   * more than `MAX_MISSES` frames are dropped; detections left over start new tracks. Returns
   * the tracks matched on this frame.
   */
  update(detections: readonly Detection[]): TrackCard[] {
    const unmatched = new Set(detections.map((_, i) => i));

    for (const track of this.tracks) {
      let bestIndex = -1;
      let bestIou = TRACK_IOU;
      for (const i of unmatched) {
        const v = iou(track.detection.aabb, detections[i]!.aabb);
        if (v > bestIou) {
          bestIou = v;
          bestIndex = i;
        }
      }
      if (bestIndex >= 0) {
        const det = detections[bestIndex]!;
        track.detection = det;
        track.misses = 0;
        track.age += 1;
        track.embeddings.push(det.embedding);
        if (track.embeddings.length > EMBED_POOL_WINDOW) track.embeddings.shift();
        unmatched.delete(bestIndex);
      } else {
        track.misses += 1;
      }
    }

    this.tracks = this.tracks.filter((t) => t.misses <= MAX_MISSES);

    for (const i of unmatched) {
      const det = detections[i]!;
      this.tracks.push({
        instanceId: `${TRACK_ID_PREFIX}${String(this.nextId++).padStart(4, "0")}`,
        detection: det,
        embeddings: [det.embedding],
        misses: 0,
        age: 1,
      });
    }

    return this.tracks
      .filter((t) => t.misses === 0)
      .map((t) => ({
        instanceId: t.instanceId,
        detection: t.detection,
        identity: t.age >= MIN_IDENTITY_FRAMES ? this.identityOf(t) : null,
      }));
  }
}
