# SPDX-License-Identifier: AGPL-3.0-only
"""Read-only MCP HTTP client. Endpoints and credentials are supplied at runtime."""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MCP_RESPONSE_LIMIT = 2 * 1024 * 1024
MCP_TOOL_TIMEOUT_SECONDS = 20
MCP_TOTAL_TIMEOUT_SECONDS = 40
PROTOCOL_VERSION = "2025-06-18"
READ_TOOLS = frozenset({"breath", "darkroom_search"})

class MCPProtocolError(RuntimeError):
    pass

class RecallNotConfigured(RuntimeError):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def log_mcp_failure(stage, error, elapsed):
    # Never log URLs, arguments, returned memories, tokens or exception messages.
    record = {"component": "nightpulse-recall", "stage": stage,
              "error": type(error).__name__, "elapsed_ms": round(elapsed * 1000)}
    if isinstance(error, urllib.error.HTTPError):
        record["http_status"] = error.code
    print(json.dumps(record), file=sys.stderr)


def remaining_timeout(deadline, cap):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("MCP call budget exhausted")
    return min(cap, remaining)

def read_mcp_payload(response, request_id, deadline):
    """Bound response bytes and check the shared deadline between socket reads."""
    def chunks():
        total = 0
        while True:
            timeout = remaining_timeout(deadline, MCP_TOOL_TIMEOUT_SECONDS)
            raw = getattr(getattr(response, "fp", None), "raw", None)
            sock = getattr(raw, "_sock", None)
            if sock is not None:
                sock.settimeout(timeout)
            chunk = (getattr(response, "read1", None) or response.read)(65536)
            if not chunk:
                return
            total += len(chunk)
            if total > MCP_RESPONSE_LIMIT:
                raise MCPProtocolError("MCP response too large")
            yield chunk
    if "text/event-stream" not in response.headers.get("content-type", "").lower():
        payload = json.loads(b"".join(chunks()))
        if not isinstance(payload, dict) or payload.get("id") != request_id:
            raise MCPProtocolError("Mismatched MCP response")
        return check_mcp_payload(payload)
    pending = b""
    data = []
    for chunk in chunks():
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            line = line.rstrip(b"\r")
            if not line:
                if data:
                    payload = json.loads("\n".join(data))
                    data = []
                    if isinstance(payload, dict) and payload.get("id") == request_id:
                        return check_mcp_payload(payload)
            elif line.startswith(b"data:"):
                data.append(line[5:].decode("utf-8").strip())
    raise MCPProtocolError("MCP stream ended without a complete result")


def check_mcp_payload(payload):
    if "error" in payload:
        raise MCPProtocolError("MCP JSON-RPC error")
    result = payload.get("result")
    if not isinstance(result, dict) or result.get("isError"):
        raise MCPProtocolError("MCP tool returned an error or invalid result")
    return result


def mcp_call_at_url(url, tool_name, arguments, *, deadline):
    if tool_name not in READ_TOOLS:
        raise ValueError("Only recall tools are supported")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Invalid MCP endpoint")
    token = os.environ.get("NIGHTPULSE_OB_MCP_TOKEN", "")
    if token and parsed.scheme != "https" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Bearer credentials require HTTPS or loopback")
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               "MCP-Protocol-Version": PROTOCOL_VERSION}
    if token:
        headers["Authorization"] = "Bearer " + token
    # Ignore ambient proxy variables: this endpoint is explicitly configured.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(body, *, notification=False):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            response = opener.open(req, timeout=remaining_timeout(deadline, MCP_TOOL_TIMEOUT_SECONDS))
        except urllib.error.HTTPError as error:
            error.close()
            raise
        with response:
            session = response.headers.get("Mcp-Session-Id")
            if session:
                headers["Mcp-Session-Id"] = session
            if notification:
                return None
            return read_mcp_payload(response, body["id"], deadline)

    initialized = request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
        "clientInfo": {"name": "nightpulse-recall", "version": "1"}}})
    version = initialized.get("protocolVersion")
    if version not in {PROTOCOL_VERSION, "2025-03-26", "2024-11-05"}:
        raise MCPProtocolError("Unsupported negotiated protocol")
    headers["MCP-Protocol-Version"] = version
    request({"jsonrpc": "2.0", "method": "notifications/initialized"}, notification=True)
    result = request({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": tool_name, "arguments": arguments}})
    content = result.get("content")
    if not isinstance(content, list):
        raise MCPProtocolError("Missing MCP text content")
    blocks = [item["text"] for item in content
              if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)]
    if not blocks:
        raise MCPProtocolError("Missing MCP text content")
    return "\n".join(blocks)


def mcp_call(tool_name, arguments, *, deadline=None):
    deadline = deadline or time.monotonic() + MCP_TOTAL_TIMEOUT_SECONDS
    if tool_name == "darkroom_search":
        deadline = min(deadline, time.monotonic() + 10)
    primary = os.environ.get("NIGHTPULSE_OB_MCP_URL", "")
    if not primary:
        raise RecallNotConfigured("MCP endpoint not configured")
    fallback = os.environ.get("NIGHTPULSE_OB_MCP_FALLBACK_URL", "")
    try:
        return mcp_call_at_url(primary, tool_name, arguments, deadline=deadline)
    except urllib.error.HTTPError as error:
        # Authorization, redirects and schema errors must not switch destinations.
        if error.code not in {502, 503, 504} or not fallback or fallback == primary:
            raise
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        if not fallback or fallback == primary:
            raise
    return mcp_call_at_url(fallback, tool_name, arguments, deadline=deadline)
