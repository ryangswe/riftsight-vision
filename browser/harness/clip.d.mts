// SPDX-License-Identifier: Apache-2.0
export interface ClipPlace {
  x: number;
  y: number;
  from?: number;
  until?: number;
  back?: number;
}
export interface ClipProduct {
  cardWidth: number;
  cardAspect: number;
  clip: { width: number; height: number; fps: number; seconds: number };
  places: Record<string, ClipPlace>;
}
export function cardBox(product: ClipProduct, slot: string): { x: number; y: number; w: number; h: number };
export function enableOf(place: ClipPlace): string;
export function clipArgs(product: ClipProduct, files: Record<string, string>, out: string): string[];
export function renderClip(product: ClipProduct, files: Record<string, string>, dir: string): string;
