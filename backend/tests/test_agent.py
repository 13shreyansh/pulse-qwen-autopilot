from __future__ import annotations

import json

import httpx
import pytest

from backend.app import (
    AgentIncomplete,
    AgentOrchestrator,
    AgentRunRequest,
    Location,
    QwenMessage,
    QwenClient,
    QwenUnavailable,
    score_facility,
    singapore_snapshot_facility_search,
    ToolDispatchError,
)


FACILITIES = [
    {
        "id": "facility-1",
        "name": "City Trauma Centre",
        "address": "Main Road",
        "phone": "+15551234567",
        "distanceKm": 2.4,
        "travelTimeMinutes": 8,
        "score": 88,
        "confidence": "high",
        "rankingReason": "8 min estimated drive; listed phone available; public listing appears operational",
        "mapsUrl": "https://maps.example/facility-1",
        "source": "google_places",
        "availabilityStatus": "unknown_until_confirmed",
    }
]


class ScriptedQwen:
    model = "qwen3.7-plus"

    def __init__(self, calls: list[tuple[str, dict]]):
        self.calls = list(calls)
        self.index = 0

    async def complete(self, messages):
        name, arguments = self.calls[self.index]
        self.index += 1
        tool_call = {
            "id": f"call-{self.index}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }
        return QwenMessage(
            content="",
            tool_calls=[tool_call],
            request_id=f"qwen-{self.index}",
            raw_message={"role": "assistant", "content": "", "tool_calls": [tool_call]},
        )


async def fake_search(location: Location, radius_meters: int):
    assert location.latitude == 1.3521
    assert radius_meters == 15000
    return FACILITIES


def request():
    return AgentRunRequest(
        report="A person fell near the road, is breathing, and may have a broken leg.",
        location={"latitude": 1.3521, "longitude": 103.8198},
        mode="demo",
    )


@pytest.mark.asyncio
async def test_valid_grounded_tool_sequence_returns_human_gated_plan():
    qwen = ScriptedQwen(
        [
            ("get_emergency_protocol", {"emergency_type": "MAJOR_TRAUMA"}),
            ("search_nearby_care", {"radius_meters": 15000}),
            ("prepare_verified_handoff", {"facility_id": "facility-1"}),
            (
                "submit_coordination_plan",
                {
                    "plan_id": "__dynamic__",
                    "selected_facility_id": "facility-1",
                    "rationale": "Nearest sourced emergency-care listing with a public phone number.",
                },
            ),
        ]
    )

    original_complete = qwen.complete

    async def complete_with_plan(messages):
        if qwen.index == 3:
            tool_result = json.loads(messages[-1]["content"])
            qwen.calls[3][1]["plan_id"] = tool_result["id"]
        return await original_complete(messages)

    qwen.complete = complete_with_plan
    result = await AgentOrchestrator(qwen, fake_search).run(request(), "fc-test")

    assert result["model"] == "qwen3.7-plus"
    assert result["fcRequestId"] == "fc-test"
    assert result["fallbackUsed"] is False
    assert result["plan"]["selectedFacilityId"] == "facility-1"
    assert "approve" in result["humanActionRequired"].lower()
    assert [entry["tool"] for entry in result["toolTrace"]] == [
        "get_emergency_protocol",
        "search_nearby_care",
        "prepare_verified_handoff",
        "submit_coordination_plan",
    ]


@pytest.mark.asyncio
async def test_rejects_facility_not_emitted_by_search():
    qwen = ScriptedQwen(
        [
            ("get_emergency_protocol", {"emergency_type": "MAJOR_TRAUMA"}),
            ("search_nearby_care", {}),
            ("prepare_verified_handoff", {"facility_id": "invented-facility"}),
        ]
    )
    with pytest.raises(ToolDispatchError, match="not emitted"):
        await AgentOrchestrator(qwen, fake_search).run(request())


@pytest.mark.asyncio
async def test_rejects_unknown_tool():
    qwen = ScriptedQwen([("approve_plan", {})])
    with pytest.raises(ToolDispatchError, match="unknown tool"):
        await AgentOrchestrator(qwen, fake_search).run(request())


@pytest.mark.asyncio
async def test_stops_after_five_tool_rounds_without_submission():
    class NonCompletingOrchestrator(AgentOrchestrator):
        async def dispatch_tool(self, name, raw_arguments, context):
            return {"round": len(context.trace) + 1}, None

    qwen = ScriptedQwen(
        [("get_emergency_protocol", {"emergency_type": "MAJOR_TRAUMA"})] * 5
    )
    with pytest.raises(AgentIncomplete, match="within 5"):
        await NonCompletingOrchestrator(qwen, fake_search).run(request())


@pytest.mark.asyncio
async def test_rejects_malformed_tool_arguments():
    qwen = ScriptedQwen(
        [("get_emergency_protocol", {"emergency_type": "NOT_A_PROTOCOL"})]
    )
    with pytest.raises(ToolDispatchError, match="invalid arguments"):
        await AgentOrchestrator(qwen, fake_search).run(request())


@pytest.mark.asyncio
async def test_rejects_tools_called_out_of_order():
    qwen = ScriptedQwen([("search_nearby_care", {"radius_meters": 15000})])
    with pytest.raises(ToolDispatchError, match="out of order"):
        await AgentOrchestrator(qwen, fake_search).run(request())


@pytest.mark.asyncio
async def test_qwen_client_retries_one_transient_failure():
    attempts = 0

    def handler(request: httpx.Request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, json={"error": "rate limited"})
        return httpx.Response(
            200,
            headers={"x-request-id": "qwen-retry-success"},
            json={"choices": [{"message": {"role": "assistant", "content": "done"}}]},
        )

    client = QwenClient(
        "server-side-test-key",
        base_url="https://qwen.invalid/v1",
        transport=httpx.MockTransport(handler),
        retry_delay_seconds=0,
    )
    result = await client.complete([{"role": "user", "content": "test"}])
    assert attempts == 2
    assert result.request_id == "qwen-retry-success"


@pytest.mark.asyncio
async def test_qwen_client_fails_after_exactly_one_retry():
    attempts = 0

    def handler(request: httpx.Request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(503, json={"error": "unavailable"})

    client = QwenClient(
        "server-side-test-key",
        base_url="https://qwen.invalid/v1",
        transport=httpx.MockTransport(handler),
        retry_delay_seconds=0,
    )
    with pytest.raises(QwenUnavailable, match="temporarily unavailable"):
        await client.complete([{"role": "user", "content": "test"}])
    assert attempts == 2


def test_listing_without_phone_remains_unverified():
    score, confidence, reason = score_facility(
        {
            "id": "facility-without-phone",
            "name": "Public General Hospital",
            "address": "Example Road",
            "distanceKm": 3.2,
            "businessStatus": None,
            "openNow": None,
        }
    )
    assert score > 0
    assert confidence == "medium"
    assert "phone not listed" in reason
    assert "unverified" in reason


def test_singapore_snapshot_uses_real_dated_osm_ids_without_availability_claims():
    facilities = singapore_snapshot_facility_search(
        Location(latitude=1.3521, longitude=103.8198, accuracyMeters=18)
    )

    assert len(facilities) == 5
    assert all(item["id"].startswith("osm_") for item in facilities)
    assert all(item["source"] == "openstreetmap" for item in facilities)
    assert all(item["sourceAsOf"] == "2026-07-20" for item in facilities)
    assert all(item["availabilityStatus"] == "unknown_until_confirmed" for item in facilities)
