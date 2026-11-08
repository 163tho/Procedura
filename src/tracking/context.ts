import { AsyncLocalStorage } from "node:async_hooks";

import type { Pricing } from "./pricing.ts";

export interface TrackingSink {
  readonly pricing: Pricing;
  addTiming(name: string, ms: number): void;
  addWait(ms: number): void;
  skipPhase(name: string, reason: string): void;
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
  startCall(details: Record<string, unknown>): {
    update(details: Record<string, unknown>): void;
    finish(details: Record<string, unknown>): void;
  };
}
type Context = { recorder: TrackingSink; stage: string; phase: string };
const storage = new AsyncLocalStorage<Context>();

export const trackingContext = () => storage.getStore();
export function inRun<T>(recorder: TrackingSink, fn: () => Promise<T>): Promise<T> {
  return storage.run({ recorder, stage: "pipeline", phase: "pipeline" }, fn);
}
export function inStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  return current ? storage.run({ ...current, stage }, fn) : fn();
}
export function inPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  return current
    ? storage.run({ ...current, phase, stage: phase }, () => current.recorder.phase(phase, fn))
    : fn();
}
export function recordRetryWait(ms: number): void {
  storage.getStore()?.recorder.addWait(ms);
}

export function skipPhase(name: string, reason: string): void {
  storage.getStore()?.recorder.skipPhase(name, reason);
}
