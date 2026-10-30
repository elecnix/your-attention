export const IMAGE_TYPES: string[];
export const IMAGE_LIMIT_BYTES: number;
export const IMAGE_COUNT_LIMIT: number;
export function imageFiles(clipboard: { items?: ArrayLike<{ kind: string; type: string; getAsFile(): unknown }> } | null | undefined): { type: string; size: number; name: string }[];
export function checkImage(file: { type: string; size: number; name?: string }): string | null;
export const pastedImages: {
  list(cardId: string): { key: string; name: string; field: string; src: string }[];
  add(cardId: string, field: string, file: File): Promise<string | null>;
  remove(cardId: string, key: string): void;
  clear(cardId: string): void;
  payload(cardId: string): { src: string; name: string; field: string }[];
};
export function drawStrips(cardId: string): void;
export function clearPasted(cardId: string): void;
export function installPaste(currentCard: () => string | null): void;
