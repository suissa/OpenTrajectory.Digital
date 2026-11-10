export interface TrajectoryLimits {
  /** Maximum UTF-8 size of each attributes object. Undefined means unlimited. */
  maxAttributeBytes?: number;
  /** Maximum number of Expansions recorded by an individual Track. */
  maxExpansionsPerTrack?: number;
  /** Maximum Track depth; root Tracks have depth 0. */
  maxTrackDepth?: number;
}

export type TrajectoryLimitCode =
  | "MAX_ATTRIBUTE_BYTES"
  | "MAX_EXPANSIONS_PER_TRACK"
  | "MAX_TRACK_DEPTH";

export class TrajectoryLimitError extends Error {
  constructor(
    readonly code: TrajectoryLimitCode,
    message: string,
    readonly limit: number,
    readonly actual: number
  ) {
    super(message);
    this.name = "TrajectoryLimitError";
  }
}

export function validateTrajectoryLimits(limits: TrajectoryLimits = {}): void {
  for (const [name, value] of Object.entries(limits)) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new RangeError(`${name} must be a non-negative integer.`);
    }
  }
}

export function assertAttributeSize(
  attributes: Record<string, unknown>,
  limits: TrajectoryLimits
): void {
  const limit = limits.maxAttributeBytes;
  if (limit === undefined) return;
  const actual = new TextEncoder().encode(JSON.stringify(attributes)).length;
  if (actual > limit) {
    throw new TrajectoryLimitError(
      "MAX_ATTRIBUTE_BYTES",
      `Attributes use ${actual} bytes; configured maximum is ${limit} bytes.`,
      limit,
      actual
    );
  }
}

export function assertExpansionCount(current: number, limits: TrajectoryLimits): void {
  const limit = limits.maxExpansionsPerTrack;
  if (limit !== undefined && current >= limit) {
    throw new TrajectoryLimitError(
      "MAX_EXPANSIONS_PER_TRACK",
      `Track expansion limit ${limit} reached.`,
      limit,
      current + 1
    );
  }
}

export function assertTrackDepth(depth: number, limits: TrajectoryLimits): void {
  const limit = limits.maxTrackDepth;
  if (limit !== undefined && depth > limit) {
    throw new TrajectoryLimitError(
      "MAX_TRACK_DEPTH",
      `Track depth ${depth} exceeds configured maximum ${limit}.`,
      limit,
      depth
    );
  }
}
