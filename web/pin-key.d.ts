import type { PinKey } from '../src/core/pin.ts';
export function pinKey(pin: string, salt: string, iterations: number): Promise<string>;
export function newPinKey(pin: string, iterations: number): Promise<PinKey>;
