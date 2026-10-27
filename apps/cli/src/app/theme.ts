/** @module theme Terminal palette: energy types, rarity tiers, and UI accents. */

/** Truecolor hex per energy type; Ink downsamples on limited terminals. */
export const TYPE_COLORS: Record<string, string> = {
  Colorless: "#C6C6A7",
  Darkness: "#7B6B9E",
  Dragon: "#C9A227",
  Fairy: "#F4A6C6",
  Fighting: "#D0703C",
  Fire: "#F5593D",
  Grass: "#5BBF4A",
  Lightning: "#F7D02C",
  Metal: "#A8B4C0",
  Psychic: "#B65FCF",
  Water: "#3D9BF5",
};

export const ACCENT = "#F7C948";
export const ACCENT_2 = "#FF6B9A";
export const INFO = "#7DD3FC";
export const MUTED = "#7A8394";
export const OK = "#4ADE80";
export const BAD = "#F87171";
export const BORDER = "#3B4252";

/** Gradient stops for the wordmark. */
export const GRADIENT = ["#FF6B9A", "#FF9F6B", "#F7C948", "#7DD3FC", "#A78BFA"];

/** Color for a card's leading type, or muted for Trainers and Energy. */
export function typeColor(types: readonly string[]): string {
  return TYPE_COLORS[types[0] ?? ""] ?? MUTED;
}

/** Higher rarity tiers shimmer toward the accent palette. */
export function rarityColor(rarity: string | null): string {
  if (!rarity) return MUTED;
  if (/hyper|secret|rainbow|special illustration|gold|mega hyper/i.test(rarity))
    return ACCENT_2;
  if (
    /illustration|ultra|double|ex|gx|v|shiny|radiant|ace|amazing/i.test(rarity)
  )
    return ACCENT;
  if (/holo|rare/i.test(rarity)) return INFO;
  return MUTED;
}
