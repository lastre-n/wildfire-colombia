import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey);

/** Build the last N calendar days (including today) as ISO date strings, oldest first. */
export function getLastNDates(n = 7) {
  const dates = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10)); // YYYY-MM-DD
  }
  return dates;
}

/**
 * Fetch every polygon row in the last N days as a flat list (not grouped) — the
 * frontend fetches this once and filters client-side per the user's day toggles,
 * so switching which days are visible is instant with no extra network round-trip.
 */
export async function fetchPolygonsInRange(startDateStr) {
  const { data, error } = await supabase
    .from("fire_polygons_geojson")
    .select("*")
    .gte("acq_date", startDateStr)
    .order("cluster_id", { ascending: true })
    .order("day_index", { ascending: true })
    .limit(3000);
  if (error) throw error;
  return data;
}

/** Fetch every 24h projection computed on any day within the last N days. */
export async function fetchProjectionsInRange(startDateStr) {
  const { data, error } = await supabase
    .from("fire_projections_geojson")
    .select("*")
    .gte("base_date", startDateStr)
    .limit(500);
  if (error) throw error;
  return data;
}
