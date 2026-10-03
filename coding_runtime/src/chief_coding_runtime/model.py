"""Model adapters share OpenRouter's tool/reasoning message format."""

from __future__ import annotations

import asyncio
import copy
import time
from typing import Any, Literal, Protocol
from uuid import uuid4

import httpx

from .protocol import Json, wire_json, wire_size


class ModelAdapter(Protocol):
    async def generate(self, messages: list[Json], tools: list[Json]) -> Json: ...


async def cancellable(awaitable: Any, stop: asyncio.Event) -> Any:
    if stop.is_set():
        if hasattr(awaitable, "close"):
            awaitable.close()
        raise asyncio.CancelledError("Coding stopped")
    request = asyncio.ensure_future(awaitable)
    stopped = asyncio.create_task(stop.wait())
    try:
        done, _ = await asyncio.wait(
            [request, stopped], return_when=asyncio.FIRST_COMPLETED
        )
        if stopped in done:
            raise asyncio.CancelledError("Coding stopped")
        return await request
    finally:
        for task in (request, stopped):
            if not task.done():
                task.cancel()
        await asyncio.gather(request, stopped, return_exceptions=True)


class GatewayError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"Worker gateway rejected request ({status})")
        self.status = status


class WorkerClient:
    """Only one job attempt's bearer; provider/GitHub credentials stay on the host."""

    def __init__(
        self,
        origin: str,
        job_id: str,
        token: str,
        stop: asyncio.Event,
        http: httpx.AsyncClient,
        *,
        retry_delay: float = 3,
        retry_window: float = 120,
    ) -> None:
        self.origin, self.job_id, self._token = origin, job_id, token
        self.stop, self.http = stop, http
        self.retry_delay, self.retry_window = retry_delay, retry_window

    async def request(self, path: str, body: Json | None = None) -> Json:
        deadline = time.monotonic() + self.retry_window
        payload = wire_json(body).encode("utf-8") if body is not None else None
        while True:
            try:
                response: httpx.Response = await cancellable(
                    self.http.request(
                        "GET" if body is None else "POST",
                        f"{self.origin}/coding/worker/{self.job_id}/{path}",
                        headers={
                            "Authorization": f"Bearer {self._token}",
                            "Content-Type": "application/json",
                        },
                        content=payload,
                        timeout=130 if path == "model" else 30,
                    ),
                    self.stop,
                )
                if response.status_code >= 400:
                    raise GatewayError(response.status_code)
                if len(response.content) > 1600000:
                    raise ValueError("Gateway response exceeds supported bound")
                value = response.json()
                if not isinstance(value, dict):
                    raise ValueError("Invalid gateway response")
                return dict(value)
            except (httpx.TransportError, GatewayError) as error:
                if (
                    self.stop.is_set()
                    or time.monotonic() >= deadline
                    or (
                        isinstance(error, GatewayError)
                        and error.status not in (429, 500, 502, 503, 504)
                    )
                ):
                    raise
                await cancellable(asyncio.sleep(self.retry_delay), self.stop)

    def adapter(self, role: Literal["leader", "coder", "reviewer"]) -> ChiefOpenRouter:
        return ChiefOpenRouter(self, role)


class ChiefOpenRouter:
    """Production adapter uses Chief's journalled OpenRouter proxy and price policy."""

    def __init__(
        self, client: WorkerClient, role: Literal["leader", "coder", "reviewer"]
    ) -> None:
        self.client, self.role = client, role

    async def generate(self, messages: list[Json], tools: list[Json]) -> Json:
        body = copy.deepcopy(
            {
                "callId": str(uuid4()),
                "role": self.role,
                "messages": messages,
                "tools": tools,
            }
        )
        if wire_size(body) > 180000:
            raise ValueError("Model wire request exceeds the gateway bound")
        result = await self.client.request("model", body)
        return validate_generation(result)


class OpenRouter:
    """Standalone adapter for separately authorised development/evaluation clients.

    The sandbox entrypoint always uses ChiefOpenRouter and never loads an API key.
    """

    def __init__(
        self,
        key: str,
        model: str,
        http: httpx.AsyncClient,
        stop: asyncio.Event,
        *,
        input_price: float = 2,
        output_price: float = 10,
        effort: str = "high",
    ) -> None:
        if input_price <= 0 or output_price <= 0:
            raise ValueError("Provider price ceilings must be positive")
        self._key, self.model, self.http, self.stop = key, model, http, stop
        self.input_price, self.output_price, self.effort = (
            input_price,
            output_price,
            effort,
        )

    async def generate(self, messages: list[Json], tools: list[Json]) -> Json:
        response: httpx.Response = await cancellable(
            self.http.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {self._key}"},
                json={
                    "model": self.model,
                    "messages": messages,
                    "tools": [{"type": "function", "function": tool} for tool in tools],
                    "reasoning": {"enabled": True, "effort": self.effort},
                    "provider": {
                        "sort": "price",
                        "max_price": {
                            "prompt": self.input_price,
                            "completion": self.output_price,
                        },
                        "require_parameters": True,
                    },
                    "max_tokens": 8000,
                    "stream": False,
                },
                timeout=120,
            ),
            self.stop,
        )
        if response.status_code >= 400:
            raise GatewayError(response.status_code)
        data = response.json()
        if not isinstance(data, dict) or data.get("error"):
            raise ValueError("Model provider returned an invalid response")
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("Model provider returned no choices")
        if not isinstance(choices[0], dict):
            raise ValueError("Model provider returned invalid choices")
        message = choices[0].get("message")
        return validate_generation(
            {
                "message": message,
                "model": data.get("model"),
                "provider": data.get("provider"),
                "usage": data.get("usage"),
            }
        )


def validate_generation(value: Json) -> Json:
    message = value.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise ValueError("Model response has no assistant message")
    if not message.get("tool_calls") and not (
        isinstance(message.get("content"), str) and message["content"].strip()
    ):
        raise ValueError("Model response is empty")
    calls = message.get("tool_calls", [])
    if not isinstance(calls, list) or len(calls) > 20:
        raise ValueError("Invalid model tool batch")
    ids: set[str] = set()
    for call in calls:
        if (
            not isinstance(call, dict)
            or call.get("type") != "function"
            or not isinstance(call.get("id"), str)
            or call["id"] in ids
            or not isinstance(call.get("function"), dict)
            or not all(
                isinstance(call["function"].get(key), str)
                for key in ("name", "arguments")
            )
        ):
            raise ValueError("Invalid or duplicate model tool call")
        ids.add(call["id"])
    return copy.deepcopy(value)
