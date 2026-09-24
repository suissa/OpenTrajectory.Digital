import type { Attributes, TrajectorySnapshot, TrackSnapshot, Expansion } from "./model.js";
export interface TrajectoryExporter {
  onTrajectoryStarted?(trajectory: TrajectorySnapshot): void;
  onTrackStarted?(track: TrackSnapshot): void;
  onExpansion?(track: TrackSnapshot, expansion: Expansion): void;
  onTrackEnded?(track: TrackSnapshot): void;
  onTrajectoryEnded?(trajectory: TrajectorySnapshot): void;
}
export class ConsoleTrajectoryExporter implements TrajectoryExporter {
  onTrajectoryStarted(trajectory: TrajectorySnapshot): void {
    console.log("◉ TRAJECTORY " + trajectory.name + " [" + trajectory.id + "]" + (trajectory.correlationId ? " correlation=" + trajectory.correlationId : ""));
  }
  onTrackStarted(track: TrackSnapshot): void { console.log(this.prefix(track.depth) + "▶ " + track.name + this.attributes(track.attributes)); }
  onExpansion(track: TrackSnapshot, expansion: Expansion): void { console.log(this.prefix(track.depth + 1) + "↳ " + expansion.label + " +" + expansion.offsetMs + "ms" + this.attributes(expansion.attributes)); }
  onTrackEnded(track: TrackSnapshot): void {
    const icon = track.status === "ok" ? "✓" : "✕";
    console.log(this.prefix(track.depth) + icon + " " + track.name + " " + track.durationMs + "ms" + (track.error ? " — " + track.error.message : ""));
  }
  onTrajectoryEnded(trajectory: TrajectorySnapshot): void { console.log("■ REPORT " + trajectory.name + ": " + trajectory.status + ", " + trajectory.tracks.length + " tracks, " + trajectory.relations.length + " causal links, " + trajectory.durationMs + "ms"); }
  private prefix(depth: number): string { return "  ".repeat(depth); }
  private attributes(attributes: Attributes): string { const entries = Object.entries(attributes); return entries.length ? " " + JSON.stringify(attributes) : ""; }
}