import type { PinKey } from '../src/core/pin.ts';
export function pinKey(pin: string, salt: string, iterations: number, onProgress?: (fraction: number) => void): Promise<string>;
export function newPinKey(pin: string, iterations: number, onProgress?: (fraction: number) => void): Promise<PinKey>;
export function pinKeyWithoutWebCrypto(pin: string, salt: string, iterations: number, onProgress?: (fraction: number) => void): Promise<string>;
