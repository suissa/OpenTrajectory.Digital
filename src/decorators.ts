import type { TrackOptions, TrajectoryOptions } from "./model.js";
import { TrajectoryContext, trajectoryRuntime } from "./trajectory.js";

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Stage3Context = { kind?: string; name?: string | symbol };

export function Trajectory(options: TrajectoryOptions | string = {}): ClassDecorator {
  const normalized = typeof options === "string" ? { name: options } : options;
  return (target) => { Object.defineProperty(target, "__openTrajectory", { configurable: false, enumerable: false, writable: false, value: normalized.name ?? target.name }); };
}

/** Supports both TypeScript legacy decorators and the current Stage 3 decorator transform. */
export function Track(options: TrackOptions | string = {}): (...args: unknown[]) => unknown {
  const normalized = typeof options === "string" ? { name: options } : options;
  return (...args: unknown[]) => {
    const valueOrTarget = args[0]; const contextOrKey = args[1]; const property = args[2] as PropertyDescriptor | undefined;
    if (typeof valueOrTarget === "function" && isStage3(contextOrKey)) return wrap(valueOrTarget as Method, normalized, String(contextOrKey.name));
    const original = property?.value as Method | undefined;
    if (typeof original !== "function" || !property) throw new TypeError("@Track can decorate only methods");
    property.value = wrap(original, normalized, String(contextOrKey));
    return property;
  };
}

function isStage3(value: unknown): value is Stage3Context {
  return typeof value === "object" && value !== null && "kind" in value;
}

function wrap(original: Method, options: TrackOptions, fallbackName: string): Method {
  return function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const trackName = options.name ?? fallbackName; const existing = TrajectoryContext.current();
    if (existing) return existing.track({ ...options, name: trackName }, () => original.apply(this, args));
    const constructor = (this as { constructor?: { __openTrajectory?: string; name?: string } }).constructor;
    const trajectoryName = constructor?.__openTrajectory ?? constructor?.name ?? "decorated.trajectory";
    return trajectoryRuntime.trajectory(trajectoryName, () => TrajectoryContext.current()!.track({ ...options, name: trackName }, () => original.apply(this, args)));
  };
}

export const Expand = TrajectoryContext.expand;
export const CausalLink = TrajectoryContext.relate;