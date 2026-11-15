import { getJson, type Schemas } from "../api/client";

/** GET /api/photos?ids=… in URL-sized chunks (a restored staging area can hold
 *  thousands of ids). Ids that no longer exist are simply absent. Port of
 *  common.js fetchPhotosByIds, shared by the Geocode and Time Sync restores. */
export async function fetchPhotosByIds(ids: number[], chunk = 400): Promise<Schemas["SearchPhoto"][]> {
  const out: Schemas["SearchPhoto"][] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    out.push(...await getJson<Schemas["SearchPhoto"][]>(`/api/photos?ids=${ids.slice(i, i + chunk).join(",")}`));
  }
  return out;
}
