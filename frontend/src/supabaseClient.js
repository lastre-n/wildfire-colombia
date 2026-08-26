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
 * Fetch every cluster's evolution polygons up through (and including) a given date.
 * This reproduces "how the fire situation looked as of that day" — later days'
 * polygons for the same clusters are excluded, so day_index-based coloring still
 * shows the fire's build-up correctly relative to the selected point in time.
 */
export async function fetchPolygonsUpTo(dateStr) {
  const { data, error } = await supabase
    .from("fire_polygons_geojson")
    .select("*")
    .lte("acq_date", dateStr)
    .order("cluster_id", { ascending: true })
    .order("day_index", { ascending: true })
    .limit(3000);
  if (error) throw error;

  const byCluster = new Map();
  for (const row of data) {
    if (!byCluster.has(row.cluster_id)) byCluster.set(row.cluster_id, []);
    byCluster.get(row.cluster_id).push(row);
  }
  return byCluster;
}

/** Fetch the 24h projection(s) computed on a specific date. */
export async function fetchProjectionsForDate(dateStr) {
  const { data, error } = await supabase
    .from("fire_projections_geojson")
    .select("*")
    .eq("base_date", dateStr)
    .limit(500);
  if (error) throw error;
  return data;
}
