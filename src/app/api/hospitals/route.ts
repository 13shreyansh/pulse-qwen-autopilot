import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  currentOpeningHours?: { openNow?: boolean };
  types?: string[];
};
type GoogleGeocodeResult = {
  formatted_address?: string;
  address_components?: Array<{
    long_name?: string;
    short_name?: string;
    types?: string[];
  }>;
};
type OpenStreetMapElement = {
  type?: "node" | "way" | "relation";
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string | undefined>;
};
type HospitalResult = {
  id: string;
  name: string;
  address: string;
  phone?: string;
  distanceKm: number;
  travelTimeMinutes?: number;
  score: number;
  confidence: "high" | "medium" | "low";
  rankingReason: string;
  mapsUrl: string;
  source: "google_places" | "openstreetmap";
  sourceAsOf?: string;
};
type RankedHospital = HospitalResult & {
  latitude: number;
  longitude: number;
  businessStatus?: string;
  openNow?: boolean;
  types?: string[];
};

function distanceKm(fromLat: number, fromLng: number, toLat: number, toLng: number) {
  const earthKm = 6371;
  const dLat = ((toLat - fromLat) * Math.PI) / 180;
  const dLng = ((toLng - fromLng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((fromLat * Math.PI) / 180) *
      Math.cos((toLat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return Math.round(earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

function mapsUrl(latitude: number, longitude: number, name?: string) {
  const query = encodeURIComponent(name ? `${name} ${latitude},${longitude}` : `${latitude},${longitude}`);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

const SINGAPORE_OSM_SNAPSHOT = [
  { id: "osm_way_260549167", name: "Mount Elizabeth Novena Hospital", address: "38 Irrawaddy Road", phone: "+65 69330000", latitude: 1.32200135, longitude: 103.8445055, mapsUrl: "https://www.openstreetmap.org/way/260549167" },
  { id: "osm_way_74715098", name: "Mount Alvernia Hospital", address: "820 Thomson Road", latitude: 1.34220205, longitude: 103.8379314, mapsUrl: "https://www.openstreetmap.org/way/74715098" },
  { id: "osm_way_41890511", name: "Gleneagles Hospital", address: "6 Napier Road", phone: "+65 6575 7575", latitude: 1.30736745, longitude: 103.81982955, mapsUrl: "https://www.openstreetmap.org/way/41890511" },
  { id: "osm_node_6746490215", name: "Farrer Park Hospital", address: "1 Farrer Park Station Road", phone: "+65 6363 1818", latitude: 1.3126, longitude: 103.854, mapsUrl: "https://www.openstreetmap.org/node/6746490215" },
  { id: "osm_node_9152442812", name: "National University Hospital", address: "Lower Kent Ridge Road", latitude: 1.2941992, longitude: 103.7830593, mapsUrl: "https://www.openstreetmap.org/node/9152442812" },
  { id: "osm_way_34403524", name: "Changi General Hospital", address: "Simei Street 3", latitude: 1.3403638, longitude: 103.9491054, mapsUrl: "https://www.openstreetmap.org/way/34403524" },
  { id: "osm_way_33570275", name: "Sengkang General & Community Hospital", address: "110 Sengkang East Way", latitude: 1.3952091, longitude: 103.8925269, mapsUrl: "https://www.openstreetmap.org/way/33570275" },
] as const;

function singaporeSnapshotHospitals(latitude: number, longitude: number, radiusMeters: number) {
  if (distanceKm(latitude, longitude, 1.3521, 103.8198) > 80) return [];
  return SINGAPORE_OSM_SNAPSHOT
    .map<RankedHospital>((listing) => {
      const hospital: RankedHospital = {
        ...listing,
        distanceKm: distanceKm(latitude, longitude, listing.latitude, listing.longitude),
        source: "openstreetmap",
        sourceAsOf: "2026-07-20",
        types: ["hospital"],
        score: 0,
        confidence: "low",
        rankingReason: "",
      };
      return { ...hospital, ...scoreHospital(hospital) };
    })
    .filter((hospital) => hospital.distanceKm * 1000 <= radiusMeters)
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
    .slice(0, 5)
    .map(finalizeHospital);
}

function openStreetMapAddress(tags: Record<string, string | undefined>) {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const locality = tags["addr:suburb"] || tags["addr:city"] || tags["addr:district"];
  return [street, locality].filter(Boolean).join(", ") || "Address unavailable in public map data";
}

function isEmergencyCareCandidate(name: string, address: string, types?: string[]) {
  const text = `${name} ${address}`.toLowerCase();
  const isHospital = types?.includes("hospital") || /\bhospital\b/.test(text);
  const isGeneralCare = /general|multi[\s-]?special|medical college|memorial|emergency|trauma|critical care/.test(text);
  const specialtyOnly = /\b(eye|nethralaya|dental|skin|derma|fertility|ivf|cosmetic|diagnostic|scan|imaging|clinic)\b/.test(text);

  if (!isHospital) return false;
  if (specialtyOnly && !isGeneralCare) return false;
  return true;
}

function parseCoordinate(value: string | null, min: number, max: number) {
  if (!value) return null;
  const coordinate = Number(value);
  if (!Number.isFinite(coordinate) || coordinate < min || coordinate > max) {
    return null;
  }
  return coordinate;
}

function parseRadius(value: string | null) {
  if (!value) return 15000;
  const radius = Number(value);
  if (!Number.isFinite(radius)) return 15000;
  return Math.min(Math.max(Math.round(radius), 1000), 50000);
}

function isUsefulPlacePart(value?: string) {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (/^\d{5,6}$/.test(normalized)) return false;
  if (/^(india|karnataka|bengaluru|bangalore|bengaluru urban)$/i.test(normalized)) return false;
  if (/^\w{4}\+\w{2,}/i.test(normalized)) return false;
  return true;
}

function shortAddressLabel(formattedAddress?: string) {
  const parts = formattedAddress
    ?.split(",")
    .map((part) => part.trim().replace(/\b\d{5,6}\b/g, "").trim())
    .filter(isUsefulPlacePart);

  if (!parts?.length) return null;
  return parts.slice(0, 2).join(", ");
}

function componentLabel(result: GoogleGeocodeResult) {
  const preferredTypes = [
    "premise",
    "point_of_interest",
    "establishment",
    "neighborhood",
    "sublocality_level_2",
    "sublocality_level_1",
    "route",
  ];
  const components = result.address_components || [];
  const names = preferredTypes
    .map((type) => components.find((component) => component.types?.includes(type))?.long_name)
    .filter(isUsefulPlacePart);

  if (names.length === 0) return null;
  return Array.from(new Set(names)).slice(0, 2).join(", ");
}

async function resolveIncidentLabel(latitude: number, longitude: number, apiKey: string) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("latlng", `${latitude},${longitude}`);
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return "Map location";
    const data = (await response.json()) as { results?: GoogleGeocodeResult[] };
    const result = data.results?.[0];
    return componentLabel(result || {}) || shortAddressLabel(result?.formatted_address) || "Map location";
  } catch {
    return "Map location";
  }
}

function scoreHospital(input: {
  name: string;
  distanceKm: number;
  phone?: string;
  travelTimeMinutes?: number;
  source: HospitalResult["source"];
  businessStatus?: string;
  openNow?: boolean;
  types?: string[];
}): Pick<HospitalResult, "score" | "confidence" | "rankingReason"> {
  const normalizedName = input.name.toLowerCase();
  const types = input.types || [];
  const capability =
    /general|university|medical centre|medical center|hospital|emergency|trauma|women|children|cardiac|heart|maternity/.test(normalizedName) ||
    types.includes("hospital")
      ? 30
      : 15;
  const travelMetric = input.travelTimeMinutes ?? input.distanceKm * 3.2;
  const travelScore = Math.max(0, 30 - travelMetric);
  const distanceScore = Math.max(0, 16 - input.distanceKm);
  const phoneScore = input.phone ? 10 : 0;
  const statusScore =
    input.businessStatus === "OPERATIONAL" || input.openNow === true
      ? 8
      : input.businessStatus || input.openNow === false
        ? -6
        : 0;
  const sourceScore = 6;
  const score = Math.round((capability + travelScore + distanceScore + phoneScore + statusScore + sourceScore) * 10) / 10;
  const confidence =
    input.source === "google_places" && input.phone && (input.businessStatus === "OPERATIONAL" || input.openNow === true)
      ? "high"
      : input.source === "google_places"
        ? "medium"
        : "low";
  const rankingParts = [
    input.travelTimeMinutes != null ? `${Math.round(input.travelTimeMinutes)} min estimated drive` : `${input.distanceKm} km away`,
    input.phone ? "listed phone available" : "phone unavailable",
    input.businessStatus === "OPERATIONAL" || input.openNow === true ? "appears operational" : null,
  ].filter(Boolean);

  return {
    score,
    confidence,
    rankingReason: rankingParts.join("; "),
  };
}

async function enrichTravelTimes(
  originLatitude: number,
  originLongitude: number,
  hospitals: RankedHospital[],
  apiKey: string,
) {
  if (hospitals.length === 0) return hospitals;

  const destinations = hospitals
    .map((hospital) => `${hospital.latitude},${hospital.longitude}`)
    .join("|");
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", `${originLatitude},${originLongitude}`);
  url.searchParams.set("destinations", destinations);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return hospitals;
    const data = (await response.json()) as {
      rows?: Array<{ elements?: Array<{ status?: string; duration?: { value?: number } }> }>;
    };
    const elements = data.rows?.[0]?.elements || [];

    return hospitals.map((hospital, index) => {
      const durationSeconds = elements[index]?.status === "OK" ? elements[index]?.duration?.value : undefined;
      return {
        ...hospital,
        travelTimeMinutes: durationSeconds ? Math.round((durationSeconds / 60) * 10) / 10 : hospital.travelTimeMinutes,
      };
    });
  } catch {
    return hospitals;
  }
}

async function searchOpenStreetMapHospitals(
  latitude: number,
  longitude: number,
  radiusMeters: number,
) {
  const endpoint = process.env.OVERPASS_API_URL || "https://overpass-api.de/api/interpreter";
  const query =
    `[out:json][timeout:18];(` +
    `nwr["amenity"="hospital"](around:${radiusMeters},${latitude},${longitude});` +
    `nwr["healthcare"="hospital"](around:${radiusMeters},${latitude},${longitude});` +
    `);out center tags 50;`;
  const url = new URL(endpoint);
  url.searchParams.set("data", query);
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Pulse-Qwen-Autopilot/1.0 (https://pulse-qwen-autopilot.vercel.app)",
    },
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(22_000),
  });
  if (!response.ok) throw new Error("OpenStreetMap facility search failed");
  const data = (await response.json()) as { elements?: OpenStreetMapElement[] };
  const seen = new Set<string>();
  return (data.elements || [])
    .map<RankedHospital | null>((element) => {
      const tags = element.tags || {};
      const hospitalLatitude = element.lat ?? element.center?.lat;
      const hospitalLongitude = element.lon ?? element.center?.lon;
      const name = (tags["name:en"] || tags.name || "").trim();
      if (!name || hospitalLatitude == null || hospitalLongitude == null || element.id == null) return null;
      const address = openStreetMapAddress(tags);
      const specialtyOnly = /\b(eye|dental|skin|derma|fertility|ivf|cosmetic|diagnostic|imaging|proton|cancer|mental)\b/i.test(
        `${name} ${address}`,
      );
      const generalCare = /general|hospital|emergency|trauma|medical cent/i.test(`${name} ${address}`);
      if (specialtyOnly && !generalCare) return null;
      const elementType = element.type || "node";
      const id = `osm_${elementType}_${element.id}`;
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        name,
        address,
        phone: tags["contact:phone"] || tags.phone,
        distanceKm: distanceKm(latitude, longitude, hospitalLatitude, hospitalLongitude),
        mapsUrl: `https://www.openstreetmap.org/${elementType}/${element.id}`,
        source: "openstreetmap" as const,
        latitude: hospitalLatitude,
        longitude: hospitalLongitude,
        types: ["hospital"],
        score: 0,
        confidence: "low" as const,
        rankingReason: "",
      };
    })
    .filter((hospital): hospital is RankedHospital => Boolean(hospital))
    .filter((hospital) => !/lobby|drop off|car park|zone/i.test(hospital.name))
    .filter((hospital) => isEmergencyCareCandidate(hospital.name, hospital.address, hospital.types))
    .map((hospital) => ({ ...hospital, ...scoreHospital(hospital) }))
    .sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm)
    .slice(0, 5)
    .map(finalizeHospital);
}

function finalizeHospital(hospital: HospitalResult & {
  latitude?: number;
  longitude?: number;
  businessStatus?: string;
  openNow?: boolean;
  types?: string[];
}) {
  const publicHospital = { ...hospital };
  delete publicHospital.latitude;
  delete publicHospital.longitude;
  delete publicHospital.businessStatus;
  delete publicHospital.openNow;
  delete publicHospital.types;
  return publicHospital;
}

function unavailableResponse(latitude: number, longitude: number, reason: string) {
  return NextResponse.json(
    {
      error: "Hospital search is unavailable",
      warning: reason,
      incidentLocation: {
        label: "Current GPS location",
        latitude,
        longitude,
        source: "gps",
      },
      hospitals: [],
      source: "unavailable",
    },
    { status: 503 },
  );
}

async function openStreetMapResponse(latitude: number, longitude: number, radiusMeters: number) {
  const snapshotHospitals = singaporeSnapshotHospitals(latitude, longitude, radiusMeters);
  if (snapshotHospitals.length > 0) {
    return NextResponse.json({
      incidentLocation: {
        label: "Current GPS location",
        latitude,
        longitude,
        source: "gps",
      },
      hospitals: snapshotHospitals,
      source: "openstreetmap",
      sourceAsOf: "2026-07-20",
    });
  }
  try {
    const hospitals = await searchOpenStreetMapHospitals(latitude, longitude, radiusMeters);
    if (hospitals.length === 0) {
      return unavailableResponse(latitude, longitude, "OpenStreetMap returned no suitable hospital listings.");
    }
    return NextResponse.json({
      incidentLocation: {
        label: "Current GPS location",
        latitude,
        longitude,
        source: "gps",
      },
      hospitals,
      source: "openstreetmap",
    });
  } catch {
    return unavailableResponse(latitude, longitude, "Public hospital search could not be completed.");
  }
}

export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, { name: "hospital-search", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const latitude = parseCoordinate(request.nextUrl.searchParams.get("lat"), -90, 90);
  const longitude = parseCoordinate(request.nextUrl.searchParams.get("lng"), -180, 180);
  const radiusMeters = parseRadius(request.nextUrl.searchParams.get("radiusMeters"));

  if (latitude == null || longitude == null) {
    return NextResponse.json(
      { error: "lat and lng query params are required" },
      { status: 400 },
    );
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;

  if (!apiKey) {
    return openStreetMapResponse(latitude, longitude, radiusMeters);
  }

  try {
    const incidentLabel = await resolveIncidentLabel(latitude, longitude, apiKey);
    const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus,places.currentOpeningHours,places.types",
      },
      body: JSON.stringify({
        includedTypes: ["hospital"],
        maxResultCount: 10,
        locationRestriction: {
          circle: {
            center: {
              latitude,
              longitude,
            },
            radius: radiusMeters,
          },
        },
      }),
    });

    if (!response.ok) {
      return openStreetMapResponse(latitude, longitude, radiusMeters);
    }

    const data = (await response.json()) as { places?: GooglePlace[] };
    const baseHospitals = (data.places || [])
      .map<RankedHospital | null>((place) => {
        const hospitalLatitude = place.location?.latitude;
        const hospitalLongitude = place.location?.longitude;
        if (hospitalLatitude == null || hospitalLongitude == null) return null;

        const hospital: RankedHospital = {
          id: place.id || place.displayName?.text || "hospital",
          name: place.displayName?.text || "Nearby hospital",
          address: place.formattedAddress || "Address unavailable",
          distanceKm: distanceKm(latitude, longitude, hospitalLatitude, hospitalLongitude),
          mapsUrl: place.googleMapsUri || mapsUrl(hospitalLatitude, hospitalLongitude, place.displayName?.text),
          source: "google_places" as const,
          latitude: hospitalLatitude,
          longitude: hospitalLongitude,
          businessStatus: place.businessStatus,
          openNow: place.currentOpeningHours?.openNow,
          types: place.types,
          score: 0,
          confidence: "medium" as const,
          rankingReason: "",
        };
        if (place.nationalPhoneNumber) {
          hospital.phone = place.nationalPhoneNumber;
        }
        return hospital;
      })
      .filter((hospital): hospital is RankedHospital => Boolean(hospital))
      .filter((hospital) => !/lobby|drop off|car park|zone/i.test(hospital.name))
      .filter((hospital) => isEmergencyCareCandidate(hospital.name, hospital.address, hospital.types))
      .slice(0, 10);

    const hospitalsWithTravel = await enrichTravelTimes(latitude, longitude, baseHospitals, apiKey);
    const hospitals = hospitalsWithTravel
      .map((hospital) => ({
        ...hospital,
        ...scoreHospital(hospital),
      }))
      .sort((a, b) => b.score - a.score || (a.travelTimeMinutes ?? 999) - (b.travelTimeMinutes ?? 999) || a.distanceKm - b.distanceKm)
      .slice(0, 5)
      .map(finalizeHospital);

    if (hospitals.length === 0) {
      return openStreetMapResponse(latitude, longitude, radiusMeters);
    }

    return NextResponse.json({
      incidentLocation: {
        label: incidentLabel,
        latitude,
        longitude,
        source: "gps",
      },
      hospitals,
      source: "google_places",
    });
  } catch {
    return openStreetMapResponse(latitude, longitude, radiusMeters);
  }
}
