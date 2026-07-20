from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


QWEN_BASE_URL = os.getenv(
    "QWEN_BASE_URL",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
).rstrip("/")
QWEN_MODEL = os.getenv("QWEN_MODEL", "qwen3.7-plus")
MAX_TOOL_ROUNDS = 5
TOTAL_AGENT_BUDGET_SECONDS = 40

EmergencyType = Literal[
    "MAJOR_TRAUMA",
    "CARDIAC_ARREST",
    "RESPIRATORY_DISTRESS",
    "STROKE",
    "SEVERE_BLEEDING",
    "OBSTETRIC_EMERGENCY",
    "UNKNOWN",
]


class Location(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracyMeters: float | None = Field(default=None, ge=0, le=100_000)


class AgentRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    report: str = Field(min_length=12, max_length=2_000)
    location: Location
    mode: Literal["live", "demo"] = "live"

    @field_validator("report")
    @classmethod
    def normalize_report(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if len(normalized) < 12:
            raise ValueError("report is too short")
        return normalized


class GetProtocolArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    emergency_type: EmergencyType


class SearchNearbyCareArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    radius_meters: int = Field(default=15_000, ge=1_000, le=50_000)


class PrepareHandoffArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    facility_id: str = Field(min_length=1, max_length=256)


class SubmitPlanArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: str = Field(min_length=1, max_length=128)
    selected_facility_id: str = Field(min_length=1, max_length=256)
    rationale: str = Field(min_length=8, max_length=600)


class ToolDispatchError(RuntimeError):
    pass


class QwenUnavailable(RuntimeError):
    pass


class AgentIncomplete(RuntimeError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def sha256_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def compact_text(value: str, limit: int = 180) -> str:
    normalized = " ".join(value.split())
    return normalized if len(normalized) <= limit else f"{normalized[: limit - 1]}…"


PROTOCOLS: dict[str, dict[str, Any]] = {
    "MAJOR_TRAUMA": {
        "title": "Serious injury may be present",
        "severity": "high",
        "hospitalType": "Trauma-capable emergency care required",
        "warning": "Do not move the person unless there is immediate danger.",
        "actions": ["Keep them still", "Press firmly on visible bleeding", "Keep people back", "Watch breathing"],
        "doNotDo": ["Do not move them unless there is danger", "Do not give food or drink", "Do not crowd around them"],
        "watchFor": ["Breathing changes", "Heavy bleeding", "Confusion or fainting"],
    },
    "CARDIAC_ARREST": {
        "title": "Breathing or cardiac emergency",
        "severity": "critical",
        "hospitalType": "Cardiac-ready emergency department required",
        "warning": "Call local emergency services now if the person is not breathing normally.",
        "actions": ["Check for normal breathing", "Start hands-only CPR if they are not breathing", "Ask someone to find an AED", "Follow emergency-service instructions"],
        "doNotDo": ["Do not leave them alone", "Do not give food or drink", "Do not delay calling emergency services"],
        "watchFor": ["Normal breathing returning", "Movement", "Emergency responders arriving"],
    },
    "RESPIRATORY_DISTRESS": {
        "title": "Breathing emergency may be present",
        "severity": "critical",
        "hospitalType": "Emergency department with airway support required",
        "warning": "Call local emergency services now if breathing is severely difficult or stops.",
        "actions": ["Help them sit in the easiest breathing position", "Loosen tight clothing", "Keep the area clear", "Watch their breathing continuously"],
        "doNotDo": ["Do not give food or drink", "Do not make them walk", "Do not leave them alone"],
        "watchFor": ["Breathing slowing or stopping", "Blue or grey lips", "Confusion or collapse"],
    },
    "STROKE": {
        "title": "Stroke warning signs may be present",
        "severity": "critical",
        "hospitalType": "Stroke-capable emergency care required",
        "warning": "Call local emergency services now and note when the symptoms began.",
        "actions": ["Note the symptom start time", "Keep them safe and supported", "Watch their breathing", "Gather essential medical information"],
        "doNotDo": ["Do not give food, drink, or medication", "Do not let them drive", "Do not wait for symptoms to improve"],
        "watchFor": ["Face drooping", "Arm weakness", "Speech changes", "Reduced consciousness"],
    },
    "SEVERE_BLEEDING": {
        "title": "Severe bleeding may be present",
        "severity": "critical",
        "hospitalType": "Emergency department with trauma support required",
        "warning": "Call local emergency services now for heavy or uncontrolled bleeding.",
        "actions": ["Press firmly on the wound with cloth", "Keep steady pressure", "Keep the person still", "Watch their breathing"],
        "doNotDo": ["Do not repeatedly lift the cloth", "Do not give food or drink", "Do not leave them alone"],
        "watchFor": ["Bleeding soaking through", "Pale or clammy skin", "Confusion or fainting"],
    },
    "OBSTETRIC_EMERGENCY": {
        "title": "Pregnancy emergency may be present",
        "severity": "critical",
        "hospitalType": "Maternity emergency care required",
        "warning": "Call local emergency services now for severe bleeding, collapse, seizure, or imminent birth.",
        "actions": ["Keep the person comfortable and private", "Note symptoms and timing", "Gather pregnancy information", "Watch breathing and alertness"],
        "doNotDo": ["Do not give food or drink", "Do not leave them alone", "Do not attempt untrained procedures"],
        "watchFor": ["Heavy bleeding", "Severe pain", "Seizure or collapse", "Birth beginning"],
    },
    "UNKNOWN": {
        "title": "Emergency details need review",
        "severity": "high",
        "hospitalType": "Emergency department required",
        "warning": "Call local emergency services now if the person is in immediate danger or getting worse.",
        "actions": ["Keep the person safe", "Watch their breathing", "Keep the area clear", "Share any new details"],
        "doNotDo": ["Do not leave them alone", "Do not give unrequested treatment", "Do not delay emergency help if they worsen"],
        "watchFor": ["Breathing changes", "Loss of consciousness", "Heavy bleeding", "Rapid worsening"],
    },
}


def detect_emergency_type(report: str) -> EmergencyType:
    text = report.lower()
    rules: list[tuple[EmergencyType, str]] = [
        ("CARDIAC_ARREST", r"\b(not breathing|no pulse|cardiac arrest|cpr|collapsed and unresponsive)\b"),
        ("RESPIRATORY_DISTRESS", r"\b(choking|cannot breathe|can't breathe|breathing difficulty|shortness of breath|airway)\b"),
        ("STROKE", r"\b(stroke|face droop|slurred speech|one-sided weakness|arm weakness)\b"),
        ("SEVERE_BLEEDING", r"\b(severe bleeding|heavy bleeding|won't stop bleeding|haemorrhage|hemorrhage)\b"),
        ("OBSTETRIC_EMERGENCY", r"\b(pregnant|pregnancy|labou?r|giving birth|obstetric)\b"),
        ("MAJOR_TRAUMA", r"\b(fell|fall|crash|collision|hit by|accident|fracture|broken|serious injury|road)\b"),
    ]
    for emergency_type, pattern in rules:
        if re.search(pattern, text):
            return emergency_type
    return "UNKNOWN"


def extracted_signals(report: str, emergency_type: EmergencyType) -> list[str]:
    signals = [f"Bystander report matched the {emergency_type.lower().replace('_', ' ')} protocol"]
    text = report.lower()
    for label, pattern in [
        ("Breathing concern reported", r"\b(breath|choking|airway)\b"),
        ("Bleeding concern reported", r"\b(bleed|blood|haemorrhage|hemorrhage)\b"),
        ("Consciousness concern reported", r"\b(unconscious|unresponsive|faint|collapsed)\b"),
        ("Impact or fall reported", r"\b(fall|fell|crash|hit|collision|accident)\b"),
    ]:
        if re.search(pattern, text):
            signals.append(label)
    return signals[:5]


def protocol_result(report: str, requested_type: EmergencyType) -> dict[str, Any]:
    detected = detect_emergency_type(report)
    selected: EmergencyType = detected if detected != "UNKNOWN" else requested_type
    base = PROTOCOLS[selected]
    situation = {
        "MAJOR_TRAUMA": "The person may have a serious injury and should stay still while help is coordinated.",
        "CARDIAC_ARREST": "The person may have a life-threatening breathing or cardiac emergency.",
        "RESPIRATORY_DISTRESS": "The person may be having severe difficulty breathing.",
        "STROKE": "The report contains possible stroke warning signs and time matters.",
        "SEVERE_BLEEDING": "The report contains signs of potentially severe bleeding.",
        "OBSTETRIC_EMERGENCY": "The report may describe a pregnancy-related emergency.",
        "UNKNOWN": "The emergency is not yet clear, so use conservative steps and seek urgent help if it worsens.",
    }[selected]
    result = {
        "title": base["title"],
        "emergencyType": selected,
        "severity": base["severity"],
        "hospitalType": base["hospitalType"],
        "signals": extracted_signals(report, selected),
        "warning": base["warning"],
        "actions": base["actions"],
        "situationSummary": situation,
        "doNow": base["actions"],
        "doNotDo": base["doNotDo"],
        "watchFor": base["watchFor"],
        "infographicBrief": f"Create a calm, non-graphic visual guide for {base['title'].lower()} using the listed immediate actions.",
        "dispatchBrief": f"{base['hospitalType']}. Bystander report: {compact_text(report, 220)}",
        "source": "qwen",
        "policyValidated": True,
        "policyOverride": selected != requested_type,
    }
    return result


def distance_km(from_lat: float, from_lng: float, to_lat: float, to_lng: float) -> float:
    earth_km = 6371
    d_lat = math.radians(to_lat - from_lat)
    d_lng = math.radians(to_lng - from_lng)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(from_lat))
        * math.cos(math.radians(to_lat))
        * math.sin(d_lng / 2) ** 2
    )
    return round(earth_km * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)), 1)


SINGAPORE_OSM_SNAPSHOT = [
    {
        "id": "osm_way_260549167",
        "name": "Mount Elizabeth Novena Hospital",
        "address": "38 Irrawaddy Road",
        "phone": "+65 69330000",
        "latitude": 1.32200135,
        "longitude": 103.8445055,
        "mapsUrl": "https://www.openstreetmap.org/way/260549167",
    },
    {
        "id": "osm_way_74715098",
        "name": "Mount Alvernia Hospital",
        "address": "820 Thomson Road",
        "latitude": 1.34220205,
        "longitude": 103.8379314,
        "mapsUrl": "https://www.openstreetmap.org/way/74715098",
    },
    {
        "id": "osm_way_41890511",
        "name": "Gleneagles Hospital",
        "address": "6 Napier Road",
        "phone": "+65 6575 7575",
        "latitude": 1.30736745,
        "longitude": 103.81982955,
        "mapsUrl": "https://www.openstreetmap.org/way/41890511",
    },
    {
        "id": "osm_node_6746490215",
        "name": "Farrer Park Hospital",
        "address": "1 Farrer Park Station Road",
        "phone": "+65 6363 1818",
        "latitude": 1.3126,
        "longitude": 103.854,
        "mapsUrl": "https://www.openstreetmap.org/node/6746490215",
    },
    {
        "id": "osm_node_9152442812",
        "name": "National University Hospital",
        "address": "Lower Kent Ridge Road",
        "latitude": 1.2941992,
        "longitude": 103.7830593,
        "mapsUrl": "https://www.openstreetmap.org/node/9152442812",
    },
    {
        "id": "osm_way_34403524",
        "name": "Changi General Hospital",
        "address": "Simei Street 3",
        "latitude": 1.3403638,
        "longitude": 103.9491054,
        "mapsUrl": "https://www.openstreetmap.org/way/34403524",
    },
    {
        "id": "osm_way_33570275",
        "name": "Sengkang General & Community Hospital",
        "address": "110 Sengkang East Way",
        "latitude": 1.3952091,
        "longitude": 103.8925269,
        "mapsUrl": "https://www.openstreetmap.org/way/33570275",
    },
]


def singapore_snapshot_facility_search(location: Location) -> list[dict[str, Any]]:
    if distance_km(location.latitude, location.longitude, 1.3521, 103.8198) > 80:
        raise ToolDispatchError("No cached Singapore facility evidence covers this location")
    facilities: list[dict[str, Any]] = []
    for listing in SINGAPORE_OSM_SNAPSHOT:
        facility = {
            **listing,
            "distanceKm": distance_km(
                location.latitude,
                location.longitude,
                listing["latitude"],
                listing["longitude"],
            ),
            "source": "openstreetmap",
            "businessStatus": None,
            "openNow": None,
        }
        score, confidence, reason = score_facility(facility)
        facilities.append(
            {
                "id": facility["id"],
                "name": facility["name"],
                "address": facility["address"],
                "phone": facility.get("phone"),
                "distanceKm": facility["distanceKm"],
                "score": score,
                "confidence": confidence,
                "rankingReason": reason,
                "mapsUrl": facility["mapsUrl"],
                "source": "openstreetmap",
                "sourceAsOf": "2026-07-20",
                "availabilityStatus": "unknown_until_confirmed",
            }
        )
    facilities.sort(key=lambda item: (-item["score"], item["distanceKm"]))
    return facilities[:5]


def score_facility(facility: dict[str, Any]) -> tuple[float, str, str]:
    name = facility["name"].lower()
    capability = 30 if re.search(r"general|university|medical cent|hospital|emergency|trauma|cardiac|maternity", name) else 15
    travel_metric = facility.get("travelTimeMinutes") or facility["distanceKm"] * 3.2
    travel_score = max(0, 30 - travel_metric)
    distance_score = max(0, 16 - facility["distanceKm"])
    phone_score = 10 if facility.get("phone") else 0
    status_score = 8 if facility.get("businessStatus") == "OPERATIONAL" or facility.get("openNow") is True else 0
    score = round(capability + travel_score + distance_score + phone_score + status_score + 6, 1)
    confidence = "high" if facility.get("phone") and status_score else "medium"
    reason = "; ".join(
        part
        for part in [
            f"{round(facility['travelTimeMinutes'])} min estimated drive" if facility.get("travelTimeMinutes") else f"{facility['distanceKm']} km away",
            "listed phone available" if facility.get("phone") else "phone not listed",
            "public listing appears operational" if status_score else "current operational status unverified",
        ]
        if part
    )
    return score, confidence, reason


async def google_facility_search(location: Location, radius_meters: int) -> list[dict[str, Any]]:
    api_key = os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_PLACES_API_KEY")
    if not api_key:
        raise ToolDispatchError("Google Maps is not configured")

    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(
            "https://places.googleapis.com/v1/places:searchNearby",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": (
                    "places.id,places.displayName,places.formattedAddress,places.location,"
                    "places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus,"
                    "places.currentOpeningHours,places.types"
                ),
            },
            json={
                "includedTypes": ["hospital"],
                "maxResultCount": 10,
                "locationRestriction": {
                    "circle": {
                        "center": {"latitude": location.latitude, "longitude": location.longitude},
                        "radius": radius_meters,
                    }
                },
            },
        )
        if not response.is_success:
            raise ToolDispatchError("Google Places search could not be completed")
        places = response.json().get("places", [])

        facilities: list[dict[str, Any]] = []
        for place in places:
            point = place.get("location") or {}
            latitude = point.get("latitude")
            longitude = point.get("longitude")
            if latitude is None or longitude is None:
                continue
            name = ((place.get("displayName") or {}).get("text") or "Nearby hospital").strip()
            address = (place.get("formattedAddress") or "Address unavailable").strip()
            searchable = f"{name} {address}".lower()
            if re.search(r"\b(eye|dental|skin|derma|fertility|ivf|cosmetic|diagnostic|imaging|clinic)\b", searchable) and not re.search(r"general|hospital|emergency|trauma", searchable):
                continue
            facilities.append(
                {
                    "id": place.get("id") or name,
                    "name": name,
                    "address": address,
                    "phone": place.get("nationalPhoneNumber"),
                    "distanceKm": distance_km(location.latitude, location.longitude, latitude, longitude),
                    "mapsUrl": place.get("googleMapsUri") or f"https://www.google.com/maps/search/?api=1&query={latitude},{longitude}",
                    "source": "google_places",
                    "businessStatus": place.get("businessStatus"),
                    "openNow": ((place.get("currentOpeningHours") or {}).get("openNow")),
                    "latitude": latitude,
                    "longitude": longitude,
                }
            )

        if facilities:
            destinations = "|".join(f"{item['latitude']},{item['longitude']}" for item in facilities)
            try:
                travel = await client.get(
                    "https://maps.googleapis.com/maps/api/distancematrix/json",
                    params={
                        "origins": f"{location.latitude},{location.longitude}",
                        "destinations": destinations,
                        "mode": "driving",
                        "key": api_key,
                    },
                )
                elements = ((travel.json().get("rows") or [{}])[0].get("elements") or []) if travel.is_success else []
                for index, element in enumerate(elements):
                    seconds = ((element.get("duration") or {}).get("value")) if element.get("status") == "OK" else None
                    if seconds and index < len(facilities):
                        facilities[index]["travelTimeMinutes"] = round(seconds / 60, 1)
            except (httpx.HTTPError, ValueError, KeyError):
                pass

    public_facilities: list[dict[str, Any]] = []
    for facility in facilities:
        score, confidence, reason = score_facility(facility)
        public_facilities.append(
            {
                "id": facility["id"],
                "name": facility["name"],
                "address": facility["address"],
                "phone": facility.get("phone"),
                "distanceKm": facility["distanceKm"],
                "travelTimeMinutes": facility.get("travelTimeMinutes"),
                "score": score,
                "confidence": confidence,
                "rankingReason": reason,
                "mapsUrl": facility["mapsUrl"],
                "source": facility.get("source", "google_places"),
                "availabilityStatus": "unknown_until_confirmed",
            }
        )
    public_facilities.sort(key=lambda item: (-item["score"], item.get("travelTimeMinutes") or 999, item["distanceKm"]))
    if not public_facilities:
        raise ToolDispatchError("No suitable emergency-care listing was found nearby")
    return public_facilities[:5]


def osm_address(tags: dict[str, Any]) -> str:
    street = " ".join(
        part for part in [tags.get("addr:housenumber"), tags.get("addr:street")] if part
    )
    locality = tags.get("addr:suburb") or tags.get("addr:city") or tags.get("addr:district")
    parts = [part for part in [street, locality] if part]
    return ", ".join(parts) or "Address unavailable in public map data"


async def openstreetmap_facility_search(location: Location, radius_meters: int) -> list[dict[str, Any]]:
    endpoint = os.getenv("OVERPASS_API_URL", "https://overpass-api.de/api/interpreter")
    query = (
        "[out:json][timeout:18];("
        f'nwr["amenity"="hospital"](around:{radius_meters},{location.latitude},{location.longitude});'
        f'nwr["healthcare"="hospital"](around:{radius_meters},{location.latitude},{location.longitude});'
        ");out center tags 50;"
    )
    try:
        async with httpx.AsyncClient(timeout=22) as client:
            response = await client.get(
                endpoint,
                params={"data": query},
                headers={
                    "User-Agent": "Pulse-Qwen-Autopilot/1.0 (https://pulse-qwen-autopilot.vercel.app)"
                },
            )
    except httpx.HTTPError as error:
        raise ToolDispatchError("OpenStreetMap facility search could not be completed") from error
    if not response.is_success:
        raise ToolDispatchError("OpenStreetMap facility search could not be completed")

    elements = response.json().get("elements", [])
    facilities: list[dict[str, Any]] = []
    seen: set[str] = set()
    for element in elements:
        tags = element.get("tags") or {}
        name = (tags.get("name:en") or tags.get("name") or "").strip()
        point = element if element.get("lat") is not None else element.get("center") or {}
        latitude = point.get("lat")
        longitude = point.get("lon")
        if not name or latitude is None or longitude is None:
            continue
        searchable = f"{name} {osm_address(tags)}".lower()
        if re.search(r"\b(eye|dental|skin|derma|fertility|ivf|cosmetic|diagnostic|imaging|proton|cancer|mental)\b", searchable) and not re.search(
            r"general|hospital|emergency|trauma|medical cent", searchable
        ):
            continue
        facility_id = f"osm_{element.get('type', 'node')}_{element.get('id')}"
        if facility_id in seen:
            continue
        seen.add(facility_id)
        facilities.append(
            {
                "id": facility_id,
                "name": name,
                "address": osm_address(tags),
                "phone": tags.get("contact:phone") or tags.get("phone"),
                "distanceKm": distance_km(
                    location.latitude, location.longitude, latitude, longitude
                ),
                "mapsUrl": f"https://www.openstreetmap.org/{element.get('type', 'node')}/{element.get('id')}",
                "source": "openstreetmap",
                "businessStatus": None,
                "openNow": None,
            }
        )

    public_facilities: list[dict[str, Any]] = []
    for facility in facilities:
        score, confidence, reason = score_facility(facility)
        public_facilities.append(
            {
                "id": facility["id"],
                "name": facility["name"],
                "address": facility["address"],
                "phone": facility.get("phone"),
                "distanceKm": facility["distanceKm"],
                "score": score,
                "confidence": confidence,
                "rankingReason": reason,
                "mapsUrl": facility["mapsUrl"],
                "source": "openstreetmap",
                "availabilityStatus": "unknown_until_confirmed",
            }
        )
    public_facilities.sort(key=lambda item: (-item["score"], item["distanceKm"]))
    if not public_facilities:
        raise ToolDispatchError("No suitable emergency-care listing was found nearby")
    return public_facilities[:5]


async def pulse_facility_proxy_search(location: Location, radius_meters: int) -> list[dict[str, Any]]:
    endpoint = os.getenv("PULSE_FACILITY_SEARCH_URL")
    if not endpoint:
        raise ToolDispatchError("Pulse facility proxy is not configured")
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            response = await client.get(
                endpoint,
                params={
                    "lat": location.latitude,
                    "lng": location.longitude,
                    "radiusMeters": radius_meters,
                },
            )
    except httpx.HTTPError as error:
        raise ToolDispatchError("Public facility proxy search could not be completed") from error
    if not response.is_success:
        raise ToolDispatchError("Public facility proxy search could not be completed")

    hospitals = response.json().get("hospitals") or []
    facilities: list[dict[str, Any]] = []
    for hospital in hospitals[:5]:
        if (
            not isinstance(hospital, dict)
            or not hospital.get("id")
            or not hospital.get("name")
            or hospital.get("source") not in {"google_places", "openstreetmap"}
        ):
            continue
        facilities.append(
            {
                "id": hospital["id"],
                "name": hospital["name"],
                "address": hospital.get("address") or "Address unavailable in public listing",
                "phone": hospital.get("phone"),
                "distanceKm": hospital.get("distanceKm"),
                "travelTimeMinutes": hospital.get("travelTimeMinutes"),
                "score": hospital.get("score"),
                "confidence": hospital.get("confidence") or "low",
                "rankingReason": hospital.get("rankingReason") or "Sourced public listing",
                "mapsUrl": hospital.get("mapsUrl"),
                "source": hospital["source"],
                "availabilityStatus": "unknown_until_confirmed",
            }
        )
    if not facilities:
        raise ToolDispatchError("No suitable emergency-care listing was found nearby")
    return facilities


async def public_facility_search(location: Location, radius_meters: int) -> list[dict[str, Any]]:
    if os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_PLACES_API_KEY"):
        try:
            return await google_facility_search(location, radius_meters)
        except ToolDispatchError:
            pass
    try:
        return singapore_snapshot_facility_search(location)
    except ToolDispatchError:
        pass
    if os.getenv("PULSE_FACILITY_SEARCH_URL"):
        try:
            return await pulse_facility_proxy_search(location, radius_meters)
        except ToolDispatchError:
            pass
    return await openstreetmap_facility_search(location, radius_meters)


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_emergency_protocol",
            "description": "Select the bounded safety protocol that best matches the reviewed bystander report. Call this first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "emergency_type": {
                        "type": "string",
                        "enum": list(PROTOCOLS.keys()),
                    }
                },
                "required": ["emergency_type"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_nearby_care",
            "description": "Search real public care listings near the supplied GPS location after selecting a protocol. Listings never prove current capacity or acceptance.",
            "parameters": {
                "type": "object",
                "properties": {"radius_meters": {"type": "integer", "minimum": 1000, "maximum": 50000}},
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_verified_handoff",
            "description": "Prepare a deterministic handoff for one facility ID returned by search_nearby_care.",
            "parameters": {
                "type": "object",
                "properties": {"facility_id": {"type": "string"}},
                "required": ["facility_id"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_coordination_plan",
            "description": "Submit the final structured recommendation. This never approves or executes a call.",
            "parameters": {
                "type": "object",
                "properties": {
                    "plan_id": {"type": "string"},
                    "selected_facility_id": {"type": "string"},
                    "rationale": {"type": "string", "minLength": 8, "maxLength": 600},
                },
                "required": ["plan_id", "selected_facility_id", "rationale"],
                "additionalProperties": False,
            },
        },
    },
]


SYSTEM_PROMPT = """You are Pulse's Qwen incident coordinator for a fictional emergency exercise.
You interpret an ambiguous bystander report and orchestrate bounded tools; deterministic code owns medical guidance, facility ranking, hashes, and approval enforcement.
You MUST call tools in this order: get_emergency_protocol, search_nearby_care, prepare_verified_handoff, submit_coordination_plan.
Use only IDs returned by tools. Never invent a hospital, phone number, capacity, availability, acceptance, ambulance dispatch, or medical treatment.
Public listing status is not clinical readiness. The final plan must say a human must approve before any message or call.
There is no approval or dispatch tool. Do not claim that you performed either action.
If details are ambiguous, choose UNKNOWN and keep the rationale concise."""


@dataclass
class QwenMessage:
    content: str
    tool_calls: list[dict[str, Any]]
    request_id: str | None
    raw_message: dict[str, Any]


class QwenClient:
    def __init__(
        self,
        api_key: str,
        model: str = QWEN_MODEL,
        base_url: str = QWEN_BASE_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        retry_delay_seconds: float = 0.4,
    ):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.transport = transport
        self.retry_delay_seconds = retry_delay_seconds

    async def complete(self, messages: list[dict[str, Any]]) -> QwenMessage:
        payload = {
            "model": self.model,
            "messages": messages,
            "tools": TOOLS,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "temperature": 0.1,
            "enable_thinking": False,
        }
        last_error = "Qwen request failed"
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
            for attempt in range(2):
                try:
                    response = await client.post(
                        f"{self.base_url}/chat/completions",
                        headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                        json=payload,
                    )
                except httpx.HTTPError as error:
                    last_error = f"Qwen network error: {error.__class__.__name__}"
                    if attempt == 0:
                        await asyncio.sleep(self.retry_delay_seconds)
                        continue
                    raise QwenUnavailable(last_error) from error
                if response.status_code == 429 or response.status_code >= 500:
                    last_error = f"Qwen temporarily unavailable ({response.status_code})"
                    if attempt == 0:
                        await asyncio.sleep(self.retry_delay_seconds)
                        continue
                    raise QwenUnavailable(last_error)
                if not response.is_success:
                    raise QwenUnavailable(f"Qwen request rejected ({response.status_code})")
                data = response.json()
                choices = data.get("choices") or []
                if not choices or not isinstance(choices[0].get("message"), dict):
                    raise QwenUnavailable("Qwen returned no assistant message")
                message = choices[0]["message"]
                request_id = (
                    response.headers.get("x-request-id")
                    or response.headers.get("x-dashscope-request-id")
                    or data.get("request_id")
                    or data.get("id")
                )
                return QwenMessage(
                    content=message.get("content") or "",
                    tool_calls=message.get("tool_calls") or [],
                    request_id=request_id,
                    raw_message={
                        "role": "assistant",
                        "content": message.get("content") or "",
                        **({"tool_calls": message.get("tool_calls")} if message.get("tool_calls") else {}),
                    },
                )
        raise QwenUnavailable(last_error)


FacilitySearch = Callable[[Location, int], Awaitable[list[dict[str, Any]]]]


@dataclass
class AgentContext:
    request: AgentRunRequest
    run_id: str
    protocol: dict[str, Any] | None = None
    facilities: list[dict[str, Any]] = field(default_factory=list)
    plans: dict[str, dict[str, Any]] = field(default_factory=dict)
    trace: list[dict[str, Any]] = field(default_factory=list)
    qwen_request_id: str | None = None


class AgentOrchestrator:
    def __init__(self, qwen: Any, facility_search: FacilitySearch = public_facility_search):
        self.qwen = qwen
        self.facility_search = facility_search

    async def dispatch_tool(self, name: str, raw_arguments: Any, context: AgentContext) -> tuple[dict[str, Any], dict[str, Any] | None]:
        allowed = [
            "get_emergency_protocol",
            "search_nearby_care",
            "prepare_verified_handoff",
            "submit_coordination_plan",
        ]
        if name not in allowed:
            raise ToolDispatchError(f"unknown tool: {name}")
        expected = allowed[len(context.trace)] if len(context.trace) < len(allowed) else None
        if name != expected:
            raise ToolDispatchError(f"tool {name} is out of order; expected {expected or 'no further tool'}")

        if name == "get_emergency_protocol":
            args = GetProtocolArgs.model_validate(raw_arguments)
            context.protocol = protocol_result(context.request.report, args.emergency_type)
            return context.protocol, None

        if name == "search_nearby_care":
            if not context.protocol:
                raise ToolDispatchError("get_emergency_protocol must run before search_nearby_care")
            args = SearchNearbyCareArgs.model_validate(raw_arguments)
            context.facilities = await self.facility_search(context.request.location, args.radius_meters)
            return {"facilities": context.facilities, "availabilityStatus": "unknown_until_confirmed"}, None

        if name == "prepare_verified_handoff":
            if not context.protocol or not context.facilities:
                raise ToolDispatchError("protocol and facility search must run before handoff preparation")
            args = PrepareHandoffArgs.model_validate(raw_arguments)
            facility = next((item for item in context.facilities if item["id"] == args.facility_id), None)
            if not facility:
                raise ToolDispatchError("facility_id was not emitted by search_nearby_care")
            core = {
                "selectedFacilityId": facility["id"],
                "selectedFacility": facility,
                "handoffBrief": context.protocol["dispatchBrief"],
                "protocolType": context.protocol["emergencyType"],
                "reportHash": hashlib.sha256(context.request.report.encode("utf-8")).hexdigest(),
            }
            plan_hash = sha256_json(core)
            plan_id = f"plan_{plan_hash[:16]}"
            plan = {"id": plan_id, **core, "planHash": plan_hash}
            context.plans[plan_id] = plan
            return plan, None

        if name == "submit_coordination_plan":
            args = SubmitPlanArgs.model_validate(raw_arguments)
            plan = context.plans.get(args.plan_id)
            if not plan:
                raise ToolDispatchError("plan_id was not emitted by prepare_verified_handoff")
            if args.selected_facility_id != plan["selectedFacilityId"]:
                raise ToolDispatchError("selected_facility_id does not match the prepared plan")
            final = {
                **plan,
                "rationale": compact_text(args.rationale, 600),
                "humanActionRequired": "Review and approve before any message or controlled call.",
            }
            return final, final

        raise ToolDispatchError(f"unknown tool: {name}")

    async def run(self, request: AgentRunRequest, fc_request_id: str | None = None) -> dict[str, Any]:
        started = time.monotonic()
        context = AgentContext(request=request, run_id=f"run_{secrets.token_hex(8)}")
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": canonical_json(
                    {
                        "reviewed_bystander_report": request.report,
                        "gps_available": True,
                        "mode": request.mode,
                    }
                ),
            },
        ]

        for round_index in range(MAX_TOOL_ROUNDS):
            if time.monotonic() - started > TOTAL_AGENT_BUDGET_SECONDS:
                raise AgentIncomplete("agent exceeded the total time budget")
            assistant = await self.qwen.complete(messages)
            context.qwen_request_id = assistant.request_id or context.qwen_request_id
            messages.append(assistant.raw_message)
            if not assistant.tool_calls:
                raise AgentIncomplete("Qwen stopped before submitting a structured coordination plan")

            for tool_call in assistant.tool_calls:
                function = tool_call.get("function") or {}
                name = function.get("name")
                arguments_text = function.get("arguments") or "{}"
                if not isinstance(name, str):
                    raise ToolDispatchError("tool name is missing")
                try:
                    arguments = json.loads(arguments_text) if isinstance(arguments_text, str) else arguments_text
                except json.JSONDecodeError as error:
                    raise ToolDispatchError(f"invalid JSON arguments for {name}") from error
                tool_started = time.monotonic()
                try:
                    result, final = await self.dispatch_tool(name, arguments, context)
                except ValidationError as error:
                    raise ToolDispatchError(f"invalid arguments for {name}: {error.errors()[0]['msg']}") from error
                result_hash = sha256_json(result)
                context.trace.append(
                    {
                        "index": len(context.trace) + 1,
                        "tool": name,
                        "arguments": arguments,
                        "resultSummary": compact_text(
                            "Selected bounded protocol" if name == "get_emergency_protocol"
                            else f"Returned {len(context.facilities)} sourced facility listings" if name == "search_nearby_care"
                            else "Prepared a facility-bound handoff" if name == "prepare_verified_handoff"
                            else "Submitted recommendation for human approval"
                        ),
                        "resultHash": result_hash,
                        "durationMs": round((time.monotonic() - tool_started) * 1000),
                    }
                )
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.get("id") or f"tool_{round_index}_{len(context.trace)}",
                        "content": canonical_json(result),
                    }
                )
                if final:
                    return {
                        "runId": context.run_id,
                        "model": self.qwen.model,
                        "qwenRequestId": context.qwen_request_id,
                        "fcRequestId": fc_request_id,
                        "latencyMs": round((time.monotonic() - started) * 1000),
                        "protocol": context.protocol,
                        "facilities": context.facilities,
                        "plan": final,
                        "toolTrace": context.trace,
                        "humanActionRequired": final["humanActionRequired"],
                        "fallbackUsed": False,
                    }

        raise AgentIncomplete(f"agent did not submit a plan within {MAX_TOOL_ROUNDS} tool rounds")


app = FastAPI(title="Pulse Qwen Autopilot", version="1.0.0")

allowed_origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "").split(",") if origin.strip()]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )


def backend_authorized(authorization: str | None) -> bool:
    expected = os.getenv("PULSE_AGENT_BACKEND_TOKEN")
    if not expected or not authorization or not authorization.startswith("Bearer "):
        return False
    return secrets.compare_digest(authorization[7:], expected)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "pulse-qwen-agent",
        "qwenConfigured": bool(os.getenv("DASHSCOPE_API_KEY")),
        "googleConfigured": bool(os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_PLACES_API_KEY")),
        "facilitySource": "google_places"
        if os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_PLACES_API_KEY")
        else "openstreetmap_snapshot",
        "model": QWEN_MODEL,
    }


@app.get("/deployment")
async def deployment(request: Request) -> dict[str, Any]:
    return {
        "provider": "Alibaba Cloud Function Compute",
        "region": os.getenv("PULSE_DEPLOYMENT_REGION", "ap-southeast-1"),
        "functionName": os.getenv("PULSE_FUNCTION_NAME", "pulse-qwen-agent"),
        "gitSha": os.getenv("PULSE_GIT_SHA", "local"),
        "model": QWEN_MODEL,
        "qwenBaseHostname": "dashscope-intl.aliyuncs.com",
        "fcRequestId": request.headers.get("x-fc-request-id"),
    }


@app.post("/agent/run")
async def run_agent(
    body: AgentRunRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    if not backend_authorized(authorization):
        raise HTTPException(status_code=401, detail="Unauthorized")
    api_key = os.getenv("DASHSCOPE_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Qwen Cloud is not configured")
    orchestrator = AgentOrchestrator(QwenClient(api_key))
    try:
        return await asyncio.wait_for(
            orchestrator.run(body, request.headers.get("x-fc-request-id")),
            timeout=TOTAL_AGENT_BUDGET_SECONDS,
        )
    except asyncio.TimeoutError as error:
        raise HTTPException(status_code=503, detail="agent exceeded the total time budget") from error
    except (QwenUnavailable, AgentIncomplete) as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ToolDispatchError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
