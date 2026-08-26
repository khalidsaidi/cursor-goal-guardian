import crypto from "node:crypto";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function nowIso(clock: Clock = systemClock): string {
  return clock.now().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}
