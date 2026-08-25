import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anonKey);

/** Fetch every day's evolution polygon for a given fire cluster, oldest first. */
export async function fetchPolygonsForCluster(clusterId) {
  const { data, error } = await supabase
    .from("fire_polygons_geojson")
    .select("*")
    .eq("cluster_id", clusterId)
    .order("day_index", { ascending: true });
  if (error) throw error;
  return data;
}

/** Fetch the most recent day's polygon for every currently-active cluster. */
export async function fetchLatestPolygons() {
  const { data, error } = await supabase
    .from("fire_polygons_geojson")
    .select("*")
    .order("acq_date", { ascending: false })
    .limit(500);
  if (error) throw error;

  // Keep only each cluster's most recent row plus its full history for coloring.
  const byCluster = new Map();
  for (const row of data) {
    if (!byCluster.has(row.cluster_id)) byCluster.set(row.cluster_id, []);
    byCluster.get(row.cluster_id).push(row);
  }
  return byCluster;
}

/** Fetch the latest 24h projection polygon per cluster. */
export async function fetchLatestProjections() {
  const { data, error } = await supabase
    .from("fire_projections_geojson")
    .select("*")
    .order("base_date", { ascending: false })
    .limit(200);
  if (error) throw error;

  const latestByCluster = new Map();
  for (const row of data) {
    if (!latestByCluster.has(row.cluster_id)) latestByCluster.set(row.cluster_id, row);
  }
  return Array.from(latestByCluster.values());
}
