import type { TrackOptions, TrajectoryOptions } from "./model.js";
import { TrajectoryContext, trajectoryRuntime } from "./trajectory.js";
export function Trajectory(options: TrajectoryOptions | string = {}): ClassDecorator {
  const normalized = typeof options === "string" ? { name: options } : options;
  return (target) => { Object.defineProperty(target, "__openTrajectory", { configurable: false, enumerable: false, writable: false, value: normalized.name ?? target.name }); };
}
export function Track(options: TrackOptions | string = {}): MethodDecorator {
  const normalized = typeof options === "string" ? { name: options } : options;
  return (_target, propertyKey, descriptor) => {
    const property = descriptor as PropertyDescriptor;
    const original = property.value as (...args: unknown[]) => unknown;
    if (typeof original !== "function") throw new TypeError("@Track can decorate only methods");
    property.value = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const trackName = normalized.name ?? String(propertyKey); const existing = TrajectoryContext.current();
      if (existing) return existing.track({ ...normalized, name: trackName }, () => original.apply(this, args));
      const constructor = (this as { constructor?: { __openTrajectory?: string; name?: string } }).constructor;
      const trajectoryName = constructor?.__openTrajectory ?? constructor?.name ?? "decorated.trajectory";
      return trajectoryRuntime.trajectory(trajectoryName, () => TrajectoryContext.current()!.track({ ...normalized, name: trackName }, () => original.apply(this, args)));
    };
    return property;
  };
}
export const Expand = TrajectoryContext.expand;
export const CausalLink = TrajectoryContext.relate;