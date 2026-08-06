/**
 * cn — tiny className combiner (no clsx dependency). Filters falsy values and
 * joins with spaces. Keeps component markup readable without pulling in a lib.
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
