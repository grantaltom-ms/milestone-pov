export interface PropertyManager {
  manager_name: string;
  manager_email: string;
  manager_phone: string;
  co_manager_email: string | null;
  co_manager_phone: string | null;
}

/**
 * Looks up the manager for a property by name (case-insensitive, partial match).
 * Uses the Supabase REST API with the service role key.
 */
export async function lookupManager(
  propertyName: string
): Promise<PropertyManager | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.warn("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — skipping manager lookup");
    return null;
  }

  // Try exact match first, then fuzzy via RPC
  const exactRes = await fetch(
    `${url}/rest/v1/property_managers?property_name=ilike.${encodeURIComponent(propertyName)}&limit=1`,
    { headers: { Authorization: `Bearer ${key}`, apikey: key } }
  );

  const exactData = await exactRes.json() as PropertyManager[];
  if (exactData.length > 0) return exactData[0];

  // Fallback: partial match
  const fuzzyRes = await fetch(
    `${url}/rest/v1/property_managers?property_name=ilike.${encodeURIComponent(`%${propertyName}%`)}&limit=1`,
    { headers: { Authorization: `Bearer ${key}`, apikey: key } }
  );

  const fuzzyData = await fuzzyRes.json() as PropertyManager[];
  return fuzzyData.length > 0 ? fuzzyData[0] : null;
}
