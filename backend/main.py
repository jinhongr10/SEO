import json
import os
import re
import base64
import mimetypes
from html import unescape, escape
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
import httpx
import sqlite3
import subprocess
from typing import List, Optional
from pydantic import BaseModel
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load environment variables from project-root .env files, regardless of launch cwd.
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(PROJECT_ROOT / ".env.local", override=True)

app = FastAPI()
running_tasks = {}

# --- USER CONFIGURATION: HARDCODE CREDENTIALS HERE ---
# Fill in your WordPress credentials here.
# These will be passed to the media scanner/optimizer CLI.
WP_URL_HARDCODED = ""  # Fill in your WordPress site URL
WP_USER_HARDCODED = ""  # Fill in your WordPress username
WP_APP_PASS_HARDCODED = ""  # Fill in your WordPress application password
# -----------------------------------------------------

def _resolve_data_path(env_key: str, default_relative_path: str) -> Path:
    raw = os.getenv(env_key, default_relative_path).strip()
    path = Path(raw)
    return path if path.is_absolute() else PROJECT_ROOT / path


DB_PATH = _resolve_data_path("DB_PATH", "data/media_state.db")
SETTINGS_FILE = _resolve_data_path("SETTINGS_FILE", "data/settings.json")
KEYWORDS_FILE = _resolve_data_path("KEYWORDS_FILE", "data/keywords.json")
PRODUCT_TEMPLATE_FILE = _resolve_data_path(
    "PRODUCT_TEMPLATE_FILE",
    "data/product_template.txt",
)

DEFAULT_PRODUCT_TEMPLATE = """Use this fixed output structure for WooCommerce product SEO.

Writing goals:
- Keep claims consistent with existing product short description and full description.
- Avoid unsupported technical claims.
- Tone: clear B2B commercial style.
- If product-specific image references are provided, use them as primary evidence.
- If long-tail keywords are provided, use them naturally without keyword stuffing.

Field rules:
1) short_description
- 1-2 short paragraphs in HTML.
- Focus on core value, usage scenarios, and key buying points.

2) description
- HTML only.
- Must follow DOCX-like visual layout:
  - 3 sections in flex image + text style
  - section-1: Product Overview / Design Concept / Materials & Craftsmanship / Functionality & User Experience
  - section-2: Installation Options / Applications / Technical Specifications
  - section-3: About the Manufacturer / Contact Us
- Prefer adding 2-4 relevant long-tail search phrases naturally.

3) acf_seo_extra_info
- HTML snippet, 1 short paragraph + bullet points.
- Must summarize search-friendly product highlights.

4) aioseo_title
- Max 60 chars.
- Include product type + one strong intent keyword.

5) aioseo_description
- Max 160 chars.
- Clear benefit statement + usage intent.
"""

DOCX_RENDER_VERSION = "DOCX_STYLE_TEMPLATE_V5"

PROXY_ENV_KEYS = (
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
)


def _get_proxy_url() -> str:
    for key in PROXY_ENV_KEYS:
        value = os.getenv(key, "").strip()
        if value:
            return value
    return ""


def _should_retry_without_proxy(exc: Exception) -> bool:
    if not _get_proxy_url():
        return False

    seen: set[int] = set()
    pending: list[BaseException | None] = [exc]
    while pending:
        current = pending.pop()
        if current is None:
            continue
        current_id = id(current)
        if current_id in seen:
            continue
        seen.add(current_id)

        message = str(current).lower()
        if "connection refused" in message or "econnrefused" in message:
            return True

        pending.append(current.__cause__)
        pending.append(current.__context__)

    return False


def _http_request_with_proxy_fallback(
    method: str,
    url: str,
    *,
    timeout: float,
    follow_redirects: bool = True,
    **kwargs: Any,
) -> httpx.Response:
    try:
        with httpx.Client(timeout=timeout, follow_redirects=follow_redirects) as client:
            return client.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        if not _should_retry_without_proxy(exc):
            raise
        print(f"[httpx] Proxy {_get_proxy_url()} refused connection for {url}; retrying direct.")

    with httpx.Client(timeout=timeout, follow_redirects=follow_redirects, trust_env=False) as client:
        return client.request(method, url, **kwargs)


async def _http_async_request_with_proxy_fallback(
    method: str,
    url: str,
    *,
    timeout: float,
    follow_redirects: bool = True,
    **kwargs: Any,
) -> httpx.Response:
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=follow_redirects) as client:
            return await client.request(method, url, **kwargs)
    except httpx.HTTPError as exc:
        if not _should_retry_without_proxy(exc):
            raise
        print(f"[httpx] Proxy {_get_proxy_url()} refused connection for {url}; retrying direct.")

    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=follow_redirects,
        trust_env=False,
    ) as client:
        return await client.request(method, url, **kwargs)


class SettingsPayload(BaseModel):
    googleApiKey: str = ""
    wpUrl: str = ""
    wpUser: str = ""
    wpAppPass: str = ""
    sftpHost: str = ""
    sftpPort: int = 22
    sftpUser: str = ""
    sftpPass: str = ""
    remoteWpRoot: str = ""
    useProxy: bool = True
    backendUrl: str = "/api"


def _parse_origins() -> list[str]:
    value = os.getenv("CORS_ORIGINS", "*").strip()
    if value == "*":
        return ["*"]
    return [o.strip() for o in value.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _read_settings() -> dict[str, Any]:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_settings(data: dict[str, Any]) -> dict[str, Any]:
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return data


def _pick_value(form_value: str, stored_value: str, env_key: str) -> str:
    return (form_value or stored_value or os.getenv(env_key, "")).strip()


def _normalize_wp_app_pass(value: str) -> str:
    # WordPress application passwords are often displayed as grouped chunks.
    # Normalize by stripping spaces so both formats work.
    return "".join((value or "").split())


def _resolve_cli_wp_credentials() -> dict[str, str]:
    stored = _read_settings()
    wp_url = (
        str(stored.get("wpUrl", "")).strip()
        or os.getenv("WP_URL", "").strip()
        or WP_URL_HARDCODED.strip()
    )
    wp_user = (
        str(stored.get("wpUser", "")).strip()
        or os.getenv("WP_USER", "").strip()
        or WP_USER_HARDCODED.strip()
    )
    wp_app_pass = _normalize_wp_app_pass(
        str(stored.get("wpAppPass", "")).strip()
        or os.getenv("WP_APP_PASS", "").strip()
        or os.getenv("WP_APP_PASSWORD", "").strip()
        or WP_APP_PASS_HARDCODED.strip()
    )
    return {"wp_url": wp_url, "wp_user": wp_user, "wp_app_pass": wp_app_pass}


def _resolve_wc_credentials() -> dict[str, str]:
    stored = _read_settings()
    wc_key = (
        str(stored.get("wcConsumerKey", "")).strip()
        or os.getenv("WC_CONSUMER_KEY", "").strip()
    )
    wc_secret = (
        str(stored.get("wcConsumerSecret", "")).strip()
        or os.getenv("WC_CONSUMER_SECRET", "").strip()
    )
    return {"wc_key": wc_key, "wc_secret": wc_secret}


def _merge_wc_meta_updates_with_existing(
    metadata: dict[str, Any], existing_product: dict[str, Any]
) -> dict[str, Any]:
    """Rewrite meta updates to use existing meta IDs when possible.

    WooCommerce may append duplicate meta rows when updating by key only.
    Mapping to existing IDs ensures in-place updates so ACF/AIOSEO reads the latest value.
    """
    incoming_meta = metadata.get("meta_data")
    if not isinstance(incoming_meta, list):
        return metadata

    existing_meta = existing_product.get("meta_data")
    if not isinstance(existing_meta, list):
        return metadata

    existing_ids_by_key: dict[str, list[int]] = {}
    for row in existing_meta:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key") or "").strip()
        meta_id = row.get("id")
        if key and isinstance(meta_id, int):
            existing_ids_by_key.setdefault(key, []).append(meta_id)

    merged_meta: list[dict[str, Any]] = []
    for row in incoming_meta:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key") or "").strip()
        if not key:
            continue
        value = row.get("value", "")
        existing_ids = existing_ids_by_key.get(key, [])
        if existing_ids:
            for meta_id in existing_ids:
                merged_meta.append({"id": meta_id, "key": key, "value": value})
        else:
            merged_meta.append({"key": key, "value": value})

    payload = dict(metadata)
    payload["meta_data"] = merged_meta
    return payload


def _pick_product_meta(product_payload: dict[str, Any], keys: list[str]) -> dict[str, str]:
    out = {k: "" for k in keys}
    rows = product_payload.get("meta_data")
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key") or "").strip()
        if key in out:
            out[key] = str(row.get("value") or "")
    return out


PRODUCT_SYNC_FIELDS = {
    "short_description",
    "description",
    "acf_seo_extra_info",
    "aioseo_title",
    "aioseo_description",
}
DEFAULT_PRODUCT_SYNC_FIELDS = ["acf_seo_extra_info", "aioseo_title", "aioseo_description"]


def _normalize_product_sync_fields(fields: list[str] | None) -> list[str]:
    if not fields:
        return list(DEFAULT_PRODUCT_SYNC_FIELDS)
    normalized: list[str] = []
    for raw in fields:
        key = str(raw or "").strip()
        if not key:
            continue
        if key not in PRODUCT_SYNC_FIELDS:
            raise HTTPException(status_code=400, detail=f"Invalid sync field: {key}")
        if key not in normalized:
            normalized.append(key)
    return normalized or list(DEFAULT_PRODUCT_SYNC_FIELDS)


def _get_wc_meta_values(existing_product: dict[str, Any], key: str) -> list[str]:
    rows = existing_product.get("meta_data")
    if not isinstance(rows, list):
        return []
    out: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_key = str(row.get("key") or "").strip()
        if row_key == key:
            out.append(str(row.get("value") or ""))
    return out


def _meta_key_needs_update(existing_product: dict[str, Any], key: str, desired: str) -> bool:
    values = _get_wc_meta_values(existing_product, key)
    if not values:
        return desired != ""
    return any(v != desired for v in values)


def _build_selected_product_sync_payload(
    item: dict[str, Any],
    existing_product: dict[str, Any],
    fields: list[str],
    only_changed: bool = True,
) -> tuple[dict[str, Any], list[str]]:
    payload: dict[str, Any] = {}
    meta_data: list[dict[str, str]] = []
    synced_fields: list[str] = []

    if "short_description" in fields:
        desired = str(item.get("short_description") or "")
        changed = True
        if only_changed:
            changed = str(existing_product.get("short_description") or "") != desired
        if changed:
            payload["short_description"] = desired
            synced_fields.append("short_description")

    if "description" in fields:
        desired = str(item.get("description") or "")
        changed = True
        if only_changed:
            changed = str(existing_product.get("description") or "") != desired
        if changed:
            payload["description"] = desired
            synced_fields.append("description")

    if "acf_seo_extra_info" in fields:
        desired = str(item.get("acf_seo_extra_info") or "")
        acf_changed = True
        if only_changed:
            acf_changed = (
                _meta_key_needs_update(existing_product, "short_description", desired)
                or _meta_key_needs_update(existing_product, "product_extra_info——seo", desired)
            )
        if acf_changed:
            meta_data.extend(
                [
                    {"key": "short_description", "value": desired},
                    {"key": "product_extra_info——seo", "value": desired},
                ]
            )
            synced_fields.append("acf_seo_extra_info")

    # NOTE: aioseo_title and aioseo_description are handled separately via
    # the LensCraft AIOSEO Sync plugin endpoint (wp_aioseo_posts table),
    # not via WC meta_data. See _sync_aioseo_fields_to_wp().
    if "aioseo_title" in fields:
        synced_fields.append("aioseo_title")
    if "aioseo_description" in fields:
        synced_fields.append("aioseo_description")

    if meta_data:
        payload["meta_data"] = meta_data

    return payload, synced_fields


def _sync_aioseo_fields_to_wp(
    product_id: int,
    item: dict[str, Any],
    fields: list[str],
) -> dict[str, Any] | None:
    """Sync AIOSEO title/description via LensCraft AIOSEO Sync plugin REST endpoint."""
    aioseo_title = str(item.get("aioseo_title") or "").strip() if "aioseo_title" in fields else None
    aioseo_desc = str(item.get("aioseo_description") or "").strip() if "aioseo_description" in fields else None

    if aioseo_title is None and aioseo_desc is None:
        return None

    creds = _resolve_cli_wp_credentials()
    wp_url = creds.get("wp_url", "").strip()
    wp_user = creds.get("wp_user", "").strip()
    wp_app_pass = creds.get("wp_app_pass", "").strip()

    if not wp_url or not wp_user or not wp_app_pass:
        raise HTTPException(
            status_code=400,
            detail="AIOSEO sync requires WP Application Password (wp_user + wp_app_pass).",
        )

    endpoint = f"{wp_url.rstrip('/')}/wp-json/lenscraft/v1/aioseo/{product_id}"
    body: dict[str, str] = {}
    if aioseo_title is not None:
        body["title"] = aioseo_title
    if aioseo_desc is not None:
        body["description"] = aioseo_desc

    try:
        resp = _http_request_with_proxy_fallback(
            "POST",
            endpoint,
            timeout=60,
            auth=(wp_user, wp_app_pass),
            json=body,
        )
        if resp.status_code >= 400:
            detail = f"AIOSEO sync endpoint returned HTTP {resp.status_code}"
            try:
                err = resp.json()
                detail = err.get("message") or err.get("detail") or detail
            except Exception:
                detail = resp.text or detail
            raise HTTPException(status_code=502, detail=detail)
        return resp.json()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AIOSEO sync failed: {e}")


def _sync_selected_product_fields_to_wp(
    product_id: int,
    item: dict[str, Any],
    fields: list[str],
    only_changed: bool = True,
) -> dict[str, Any]:
    creds = _resolve_cli_wp_credentials()
    wp_url = creds.get("wp_url", "").strip()
    if not wp_url:
        raise HTTPException(status_code=400, detail="Missing WordPress URL in settings")

    wc = _resolve_wc_credentials()
    params: dict[str, str] = {}
    auth: tuple[str, str] | None = None

    if wc["wc_key"] and wc["wc_secret"]:
        params["consumer_key"] = wc["wc_key"]
        params["consumer_secret"] = wc["wc_secret"]
    else:
        wp_user = creds.get("wp_user", "").strip()
        wp_app_pass = creds.get("wp_app_pass", "").strip()
        if not wp_user or not wp_app_pass:
            raise HTTPException(
                status_code=400,
                detail="Missing WC key/secret and WP user/app password. Please configure credentials first.",
            )
        auth = (wp_user, wp_app_pass)

    endpoint = f"{wp_url.rstrip('/')}/wp-json/wc/v3/products/{product_id}"
    try:
        get_resp = _http_request_with_proxy_fallback(
            "GET",
            endpoint,
            timeout=60,
            params=params,
            auth=auth,
        )
        if get_resp.status_code >= 400:
            detail = f"WooCommerce API returned HTTP {get_resp.status_code}"
            try:
                payload = get_resp.json()
                detail = payload.get("message") or payload.get("detail") or detail
            except Exception:
                detail = get_resp.text or detail
            raise HTTPException(status_code=502, detail=detail)
        current = get_resp.json()
        if not isinstance(current, dict):
            raise HTTPException(status_code=502, detail="Invalid WooCommerce product response")

        payload, synced_fields = _build_selected_product_sync_payload(
            item=item,
            existing_product=current,
            fields=fields,
            only_changed=only_changed,
        )

        # Sync AIOSEO fields via custom plugin endpoint (wp_aioseo_posts table)
        aioseo_fields = [f for f in fields if f in ("aioseo_title", "aioseo_description")]
        aioseo_ok = False
        if aioseo_fields:
            try:
                _sync_aioseo_fields_to_wp(product_id, item, aioseo_fields)
                aioseo_ok = True
            except Exception as aioseo_err:
                print(f"[WARN] AIOSEO sync failed for product {product_id}: {aioseo_err}")

        if not payload and not aioseo_ok:
            return {
                "ok": True,
                "skipped": True,
                "synced_fields": [],
                "remote": current,
            }

        data = current
        if payload:
            payload = _merge_wc_meta_updates_with_existing(payload, current)
            put_resp = _http_request_with_proxy_fallback(
                "PUT",
                endpoint,
                timeout=60,
                params=params,
                auth=auth,
                json=payload,
            )
            if put_resp.status_code >= 400:
                detail = f"WooCommerce API returned HTTP {put_resp.status_code}"
                try:
                    payload_err = put_resp.json()
                    detail = payload_err.get("message") or payload_err.get("detail") or detail
                except Exception:
                    detail = put_resp.text or detail
                raise HTTPException(status_code=502, detail=detail)

            data = put_resp.json()
            if not isinstance(data, dict):
                data = {"ok": True}

        return {"ok": True, "skipped": False, "synced_fields": synced_fields, "remote": data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach WooCommerce API: {e}")


def _sync_product_metadata_to_wp(product_id: int, metadata: dict[str, Any]) -> dict[str, Any]:
    creds = _resolve_cli_wp_credentials()
    wp_url = creds.get("wp_url", "").strip()
    if not wp_url:
        raise HTTPException(status_code=400, detail="Missing WordPress URL in settings")

    wc = _resolve_wc_credentials()
    params: dict[str, str] = {}
    auth: tuple[str, str] | None = None

    if wc["wc_key"] and wc["wc_secret"]:
        params["consumer_key"] = wc["wc_key"]
        params["consumer_secret"] = wc["wc_secret"]
    else:
        wp_user = creds.get("wp_user", "").strip()
        wp_app_pass = creds.get("wp_app_pass", "").strip()
        if not wp_user or not wp_app_pass:
            raise HTTPException(
                status_code=400,
                detail="Missing WC key/secret and WP user/app password. Please configure credentials first.",
            )
        auth = (wp_user, wp_app_pass)

    endpoint = f"{wp_url.rstrip('/')}/wp-json/wc/v3/products/{product_id}"
    try:
        payload = dict(metadata)
        try:
            get_resp = _http_request_with_proxy_fallback(
                "GET",
                endpoint,
                timeout=60,
                params=params,
                auth=auth,
            )
            if get_resp.status_code < 400:
                current = get_resp.json()
                if isinstance(current, dict):
                    payload = _merge_wc_meta_updates_with_existing(payload, current)
        except Exception:
            # Fallback to raw payload if prefetch fails.
            pass

        resp = _http_request_with_proxy_fallback(
            "PUT",
            endpoint,
            timeout=60,
            params=params,
            auth=auth,
            json=payload,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach WooCommerce API: {e}")

    if resp.status_code >= 400:
        detail = f"WooCommerce API returned HTTP {resp.status_code}"
        try:
            payload = resp.json()
            detail = payload.get("message") or payload.get("detail") or detail
        except Exception:
            detail = resp.text or detail
        raise HTTPException(status_code=502, detail=detail)

    try:
        data = resp.json()
        return data if isinstance(data, dict) else {"ok": True}
    except Exception:
        return {"ok": True}


def _assert_wp_rest_access(creds: dict[str, str]) -> None:
    wp_url = creds.get("wp_url", "").strip()
    wp_user = creds.get("wp_user", "").strip()
    wp_app_pass = creds.get("wp_app_pass", "").strip()
    if not wp_url or not wp_user or not wp_app_pass:
        raise HTTPException(
            status_code=400,
            detail="Missing WordPress credentials. Please set wpUrl/wpUser/wpAppPass in settings first.",
        )

    endpoint = f"{wp_url.rstrip('/')}/wp-json/wp/v2/media"
    try:
        resp = _http_request_with_proxy_fallback(
            "GET",
            endpoint,
            timeout=20,
            params={"per_page": 1, "page": 1, "media_type": "image"},
            auth=(wp_user, wp_app_pass),
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach WordPress REST API: {e}")

    if resp.status_code < 400:
        return

    if resp.headers.get("cf-mitigated"):
        raise HTTPException(
            status_code=502,
            detail=(
                "Cloudflare challenge is blocking WordPress REST API access. "
                "Please bypass /wp-json/wp/v2/* for your source IP or use a DNS-only origin domain."
            ),
        )

    detail = f"WordPress REST API returned HTTP {resp.status_code}"
    try:
        payload = resp.json()
        detail = payload.get("message") or payload.get("detail") or detail
    except Exception:
        pass
    raise HTTPException(status_code=502, detail=detail)


def _response_detail(resp: httpx.Response, fallback: str) -> str:
    try:
        payload = resp.json()
        if isinstance(payload, dict):
            for key in ("message", "detail", "code"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            if payload:
                return json.dumps(payload, ensure_ascii=False)
    except Exception:
        pass

    text = (resp.text or "").strip()
    return text or fallback


def _is_cloudflare_challenge_response(resp: httpx.Response) -> bool:
    if str(resp.headers.get("cf-mitigated", "")).lower() == "challenge":
        return True
    if resp.status_code not in (403, 503):
        return False
    body = (resp.text or "").lower()
    return (
        "just a moment" in body
        or "enable javascript and cookies to continue" in body
        or "/cdn-cgi/challenge-platform/" in body
        or "_cf_chl_opt" in body
    )


def _has_sftp_fallback(task_env: dict[str, str]) -> bool:
    return bool(
        task_env.get("SFTP_HOST", "").strip()
        and task_env.get("SFTP_USER", "").strip()
        and task_env.get("REMOTE_WP_ROOT", "").strip()
        and (
            task_env.get("SFTP_PASSWORD", "").strip()
            or task_env.get("SFTP_PRIVATE_KEY_PATH", "").strip()
        )
    )


def _probe_rest_replace_status(creds: dict[str, str]) -> dict[str, Any]:
    try:
        _assert_wp_rest_access(creds)
    except HTTPException as exc:
        return {
            "available": False,
            "code": "wp_rest_unavailable",
            "detail": str(exc.detail),
            "httpStatus": exc.status_code,
        }

    wp_url = creds.get("wp_url", "").strip()
    wp_user = creds.get("wp_user", "").strip()
    wp_app_pass = creds.get("wp_app_pass", "").strip()
    endpoint = f"{wp_url.rstrip('/')}/wp-json/lenscraft/v1/media/1/replace"

    try:
        resp = _http_request_with_proxy_fallback(
            "POST",
            endpoint,
            timeout=20,
            auth=(wp_user, wp_app_pass),
            files={},
        )
    except Exception as exc:
        return {
            "available": False,
            "code": "request_failed",
            "detail": f"Cannot reach LensCraft Direct Sync endpoint: {exc}",
            "httpStatus": 502,
        }

    if resp.status_code < 300 or resp.status_code == 400:
        return {
            "available": True,
            "code": "available",
            "detail": "LensCraft Direct Sync REST endpoint is reachable.",
            "httpStatus": resp.status_code,
        }

    if _is_cloudflare_challenge_response(resp):
        return {
            "available": False,
            "code": "cloudflare_challenge",
            "detail": (
                "Cloudflare challenge is blocking LensCraft Direct Sync REST replacement. "
                "Bypass /wp-json/lenscraft/v1/media/* for your source IP or use SFTP replacement."
            ),
            "httpStatus": resp.status_code,
        }

    if resp.status_code == 404:
        return {
            "available": False,
            "code": "route_missing",
            "detail": (
                "LensCraft Direct Sync REST endpoint was not found (HTTP 404). "
                "Install/activate the LensCraft SEO Direct Sync plugin or switch to SFTP replacement."
            ),
            "httpStatus": 404,
        }

    if resp.status_code == 401:
        return {
            "available": False,
            "code": "unauthorized",
            "detail": (
                "LensCraft Direct Sync REST request was rejected with HTTP 401. "
                "Recheck the WordPress username and application password."
            ),
            "httpStatus": 401,
        }

    if resp.status_code == 403:
        detail = _response_detail(resp, "")
        generic_messages = {
            "",
            "rest_forbidden",
            "sorry, you are not allowed to do that.",
        }
        if detail.lower() in generic_messages:
            detail = (
                "LensCraft Direct Sync REST request was rejected with HTTP 403. "
                "The current WordPress user likely lacks upload permission or the route is blocked upstream."
            )
        else:
            detail = f"LensCraft Direct Sync REST request was rejected with HTTP 403: {detail}"
        return {
            "available": False,
            "code": "forbidden",
            "detail": detail,
            "httpStatus": 403,
        }

    return {
        "available": False,
        "code": f"http_{resp.status_code}",
        "detail": _response_detail(
            resp,
            f"LensCraft Direct Sync REST endpoint returned HTTP {resp.status_code}.",
        ),
        "httpStatus": resp.status_code,
    }


@app.get("/media/rest-replace-status")
def media_rest_replace_status():
    creds = _resolve_cli_wp_credentials()
    task_env = _build_task_env()
    probe = _probe_rest_replace_status(creds)
    sftp_configured = _has_sftp_fallback(task_env)
    return {
        **probe,
        "sftpConfigured": sftp_configured,
        "canFallbackToSftp": (not probe["available"]) and sftp_configured,
    }


@app.get("/settings")
def get_settings():
    stored = _read_settings()
    merged = {
        "googleApiKey": _pick_value(str(stored.get("googleApiKey", "")), "", "GEMINI_API_KEY"),
        "wpUrl": _pick_value(str(stored.get("wpUrl", "")), "", "WP_URL"),
        "wpUser": _pick_value(str(stored.get("wpUser", "")), "", "WP_USER"),
        "wpAppPass": _pick_value(str(stored.get("wpAppPass", "")), "", "WP_APP_PASS"),
        "sftpHost": _pick_value(str(stored.get("sftpHost", "")), "", "SFTP_HOST"),
        "sftpPort": int(stored.get("sftpPort", os.getenv("SFTP_PORT", 22))),
        "sftpUser": _pick_value(str(stored.get("sftpUser", "")), "", "SFTP_USER"),
        "sftpPass": _pick_value(str(stored.get("sftpPass", "")), "", "SFTP_PASSWORD"),
        "remoteWpRoot": _pick_value(str(stored.get("remoteWpRoot", "")), "", "REMOTE_WP_ROOT"),
        "useProxy": stored.get("useProxy", True),
        "backendUrl": (str(stored.get("backendUrl", "/api")) or "/api").strip() or "/api",
    }
    payload = SettingsPayload(**merged).model_dump()
    return payload


@app.put("/settings")
def save_settings(payload: SettingsPayload):
    data = payload.model_dump()
    data["backendUrl"] = (data.get("backendUrl") or "/api").strip() or "/api"
    saved = _write_settings(data)
    return {"ok": True, "settings": saved}


@app.post("/wp/upload")
async def wp_upload(
    file: UploadFile = File(...),
    seoData: str = Form(""),
    wpUrl: str = Form(""),
    wpUser: str = Form(""),
    wpAppPass: str = Form(""),
):
    stored = _read_settings()
    wp_url = _pick_value(wpUrl, str(stored.get("wpUrl", "")), "WP_URL")
    wp_user = _pick_value(wpUser, str(stored.get("wpUser", "")), "WP_USER")
    wp_app_pass = _normalize_wp_app_pass(_pick_value(
        wpAppPass, str(stored.get("wpAppPass", "")), "WP_APP_PASS"
    ))

    if not wp_url or not wp_user or not wp_app_pass:
        raise HTTPException(
            status_code=400,
            detail="Missing WP_URL/WP_USER/WP_APP_PASS (set env vars or send in form)",
        )

    base_url = wp_url.rstrip("/")
    endpoint = f"{base_url}/wp-json/wp/v2/media"

    try:
        seo = json.loads(seoData) if seoData else {}
    except json.JSONDecodeError:
        seo = {}

    filename = seo.get("filename") or file.filename or "image.webp"
    title = seo.get("title") or ""
    caption = seo.get("caption") or ""
    alt_text = seo.get("alt") or seo.get("alt_text") or ""
    description = seo.get("description") or ""

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Empty file")

    files = {
        "file": (
            filename,
            file_bytes,
            file.content_type or "application/octet-stream",
        )
    }

    upload_res = await _http_async_request_with_proxy_fallback(
        "POST",
        endpoint,
        timeout=60,
        files=files,
        auth=(wp_user, wp_app_pass),
    )

    if upload_res.status_code >= 400:
        try:
            err = upload_res.json()
        except Exception:
            err = upload_res.text
        raise HTTPException(status_code=upload_res.status_code, detail=err)

    upload_data = upload_res.json()
    media_id = upload_data.get("id")

    meta_payload = {}
    if title:
        meta_payload["title"] = title
    if caption:
        meta_payload["caption"] = caption
    if alt_text:
        meta_payload["alt_text"] = alt_text
    if description:
        meta_payload["description"] = description

    if media_id and meta_payload:
        update_res = await _http_async_request_with_proxy_fallback(
            "POST",
            f"{endpoint}/{media_id}",
            timeout=60,
            json=meta_payload,
            auth=(wp_user, wp_app_pass),
        )
        if update_res.status_code >= 400:
            upload_data["meta_update_error"] = update_res.text

    return upload_data

class MediaRunPayload(BaseModel):
    dryRun: bool = False
    force: bool = False
    skipScan: bool = False
    quality: int = 80
    useRestReplace: bool = False
    metadataOnly: bool = False
    ids: list[int] = []

class MediaScanPayload(BaseModel):
    limit: int = 0

def get_db_connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_generation_history_table() -> None:
    if not DB_PATH.exists():
        return
    try:
        with get_db_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS generation_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL,
                    field TEXT NOT NULL,
                    value TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
            """)
            conn.commit()
    except Exception:
        pass


def _save_generation_history(product_id: int, field: str, value: str) -> None:
    try:
        _ensure_generation_history_table()
        with get_db_connection() as conn:
            conn.execute(
                "INSERT INTO generation_history (product_id, field, value) VALUES (?, ?, ?)",
                (product_id, field, value),
            )
            conn.commit()
    except Exception:
        pass


def _ensure_product_category_columns() -> None:
    if not DB_PATH.exists():
        return
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN category_slugs TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN category_names TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN aioseo_title_raw TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN aioseo_description_raw TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN raw_meta_scanned INTEGER NOT NULL DEFAULT 0")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN image_urls TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN short_ref_images TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN full_ref_images TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN description_alt_texts TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            try:
                c.execute("ALTER TABLE product_items ADD COLUMN catalog_text TEXT NOT NULL DEFAULT ''")
            except Exception:
                pass
            conn.commit()
    except Exception:
        pass


def _split_category_tokens(raw: str) -> list[str]:
    text = str(raw or "").strip()
    if not text:
        return []
    if text.startswith("|") and text.endswith("|"):
        return [p.strip() for p in text.strip("|").split("|") if p.strip()]
    if "|" in text:
        return [p.strip() for p in text.split("|") if p.strip()]
    return [p.strip() for p in text.split(",") if p.strip()]


PRODUCT_ISSUE_FLAG_KEYS = (
    "full_description_empty",
    "short_description_empty",
    "acf_seo_extra_info_empty",
    "aioseo_title_missing_custom",
    "aioseo_description_missing_custom",
    "aioseo_title_uses_template_tag",
    "aioseo_description_uses_template_tag",
    "aioseo_title_is_default_or_empty",
    "aioseo_description_is_default_or_empty",
    "needs_attention",
    "generated_not_synced",
)

PRODUCT_TEMPLATE_TOKEN_RE = re.compile(
    r"(#[a-z_][a-z0-9_-]*|%[a-z_][a-z0-9_-]*%|\{\{[^{}]+\}\}|\[[a-z_][a-z0-9_:-]*\])",
    re.IGNORECASE,
)


def _normalize_text(value: Any) -> str:
    return str(value or "").strip()


def _strip_html_for_issue_check(value: Any) -> str:
    text = unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _contains_template_tag_token(value: str) -> bool:
    text = _normalize_text(value)
    if not text:
        return False
    return PRODUCT_TEMPLATE_TOKEN_RE.search(text) is not None


def _extract_raw_aioseo_value(item: dict[str, Any], raw_key: str, fallback_key: str) -> tuple[str, bool]:
    # When raw columns are available, we can reliably detect "default tag / not written".
    raw_ready = int(item.get("raw_meta_scanned") or 0) == 1
    if raw_ready and raw_key in item:
        return _normalize_text(item.get(raw_key)), True
    # Backward compatibility for older DB schema: fallback to effective value.
    return _normalize_text(item.get(fallback_key)), False


def _build_product_issue_flags(item: dict[str, Any]) -> dict[str, bool]:
    full_description_empty = _strip_html_for_issue_check(item.get("description")) == ""
    short_description_empty = _strip_html_for_issue_check(item.get("short_description")) == ""
    acf_seo_extra_info_empty = _strip_html_for_issue_check(item.get("acf_seo_extra_info")) == ""

    title_raw, has_title_raw = _extract_raw_aioseo_value(item, "aioseo_title_raw", "aioseo_title")
    desc_raw, has_desc_raw = _extract_raw_aioseo_value(item, "aioseo_description_raw", "aioseo_description")

    aioseo_title_missing_custom = title_raw == "" if has_title_raw else _normalize_text(item.get("aioseo_title")) == ""
    aioseo_description_missing_custom = desc_raw == "" if has_desc_raw else _normalize_text(item.get("aioseo_description")) == ""
    aioseo_title_uses_template_tag = _contains_template_tag_token(title_raw)
    aioseo_description_uses_template_tag = _contains_template_tag_token(desc_raw)

    aioseo_title_is_default_or_empty = aioseo_title_missing_custom or aioseo_title_uses_template_tag
    aioseo_description_is_default_or_empty = (
        aioseo_description_missing_custom or aioseo_description_uses_template_tag
    )

    needs_attention = any(
        [
            full_description_empty,
            short_description_empty,
            acf_seo_extra_info_empty,
            aioseo_title_is_default_or_empty,
            aioseo_description_is_default_or_empty,
        ]
    )

    generated_not_synced = _normalize_text(item.get("status")) == "generated"

    return {
        "full_description_empty": full_description_empty,
        "short_description_empty": short_description_empty,
        "acf_seo_extra_info_empty": acf_seo_extra_info_empty,
        "aioseo_title_missing_custom": aioseo_title_missing_custom,
        "aioseo_description_missing_custom": aioseo_description_missing_custom,
        "aioseo_title_uses_template_tag": aioseo_title_uses_template_tag,
        "aioseo_description_uses_template_tag": aioseo_description_uses_template_tag,
        "aioseo_title_is_default_or_empty": aioseo_title_is_default_or_empty,
        "aioseo_description_is_default_or_empty": aioseo_description_is_default_or_empty,
        "needs_attention": needs_attention,
        "generated_not_synced": generated_not_synced,
    }


def _annotate_product_issue_fields(item: dict[str, Any]) -> dict[str, Any]:
    out = dict(item)
    flags = _build_product_issue_flags(out)
    primary_group_order = [
        "full_description_empty",
        "short_description_empty",
        "acf_seo_extra_info_empty",
        "aioseo_title_is_default_or_empty",
        "aioseo_description_is_default_or_empty",
        "aioseo_title_uses_template_tag",
        "aioseo_description_uses_template_tag",
    ]
    out["issue_flags"] = flags
    out["issue_groups"] = [k for k in primary_group_order if flags.get(k)]
    return out


def _normalize_issue_filters(raw: str) -> list[str]:
    tokens: list[str] = []
    for part in str(raw or "").split(","):
        key = part.strip()
        if key and key not in tokens:
            tokens.append(key)
    if not tokens:
        return []
    invalid = [k for k in tokens if k not in PRODUCT_ISSUE_FLAG_KEYS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid issue filter: {', '.join(invalid)}")
    return tokens

def start_task(task_type: str, args: list[str], extra_env: dict = None):
    if "process" in running_tasks and running_tasks["process"].poll() is None:
        running_tasks["process"].terminate()
        try:
            running_tasks["process"].wait(timeout=3)
        except subprocess.TimeoutExpired:
            running_tasks["process"].kill()
    
    envs = os.environ.copy()
    if extra_env:
        envs.update(extra_env)
        
    proc = subprocess.Popen(
        args, 
        stdout=subprocess.PIPE, 
        stderr=subprocess.STDOUT, 
        env=envs,
        cwd=str(PROJECT_ROOT),
    )
    running_tasks["process"] = proc
    running_tasks["operation"] = task_type
    running_tasks["error"] = None


@app.get("/media/report")
def media_report():
    report = {
        "totals": {"totalMedia": 0, "totalProcessed": 0, "totalOptimized": 0, "bytesSaved": 0, "failures": 0},
        "status": {"isRunning": False, "operation": None, "lastError": None},
        "failures": [],
        "byStatus": []
    }
    
    is_running = False
    if "process" in running_tasks:
        if running_tasks["process"].poll() is None:
            is_running = True
        else:
            if running_tasks["process"].returncode != 0:
                running_tasks["error"] = f"Task exited with code {running_tasks['process'].returncode}"

    report["status"]["isRunning"] = is_running
    report["status"]["operation"] = running_tasks.get("operation")
    report["status"]["lastError"] = running_tasks.get("error")

    if not DB_PATH.exists():
        return report

    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM media_items")
            row = c.fetchone()
            report["totals"]["totalMedia"] = row[0] if row else 0

            c.execute("SELECT COUNT(*) FROM media_items WHERE bytes_optimized IS NOT NULL")
            row = c.fetchone()
            report["totals"]["totalProcessed"] = row[0] if row else 0

            c.execute("SELECT COUNT(*) FROM media_items WHERE status IN ('optimized', 'updated')")
            row = c.fetchone()
            report["totals"]["totalOptimized"] = row[0] if row else 0

            c.execute("SELECT SUM(bytes_original - bytes_optimized) FROM media_items WHERE bytes_optimized IS NOT NULL AND status IN ('optimized', 'updated', 'dry_run')")
            row = c.fetchone()
            report["totals"]["bytesSaved"] = row[0] or 0

            c.execute("SELECT COUNT(*) FROM media_items WHERE status = 'error'")
            row = c.fetchone()
            report["totals"]["failures"] = row[0] if row else 0

            c.execute("SELECT id, filename, error_reason, updated_at FROM media_items WHERE status = 'error' ORDER BY updated_at DESC LIMIT 5")
            report["failures"] = [dict(row) for row in c.fetchall()]

            c.execute("SELECT status, COUNT(*) as total FROM media_items GROUP BY status")
            report["byStatus"] = [dict(row) for row in c.fetchall()]
    except Exception as e:
        report["status"]["lastError"] = str(e)

    return report

@app.get("/media/list")
def media_list(page: int = 1, limit: int = 10, sort: str = "id_desc"):
    if not DB_PATH.exists():
        return {"items": [], "total": 0}

    offset = (page - 1) * limit
    order_clause = "m.id DESC"
    if sort == "id_asc": order_clause = "m.id ASC"
    elif sort == "size_desc": order_clause = "m.bytes_original DESC"

    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute("SELECT COUNT(*) FROM media_items")
            total = c.fetchone()[0]

            query = f"""
                SELECT m.*, s.id as gen_seo_id, s.title as gen_title, s.alt_text as gen_alt_text,
                       s.caption as gen_caption, s.description as gen_description,
                       s.category_detected as gen_category, s.review_status as gen_review_status,
                       s.generator as gen_generator
                FROM media_items m
                LEFT JOIN (
                    SELECT * FROM generated_seo s1
                    WHERE id = (SELECT MAX(id) FROM generated_seo s2 WHERE s2.media_id = s1.media_id)
                ) s ON m.id = s.media_id
                ORDER BY {order_clause} LIMIT ? OFFSET ?
            """
            c.execute(query, (limit, offset))
            items = [dict(row) for row in c.fetchall()]
            return {"items": items, "total": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/media/seo-review")
def media_seo_review(review_status: str = "pending", limit: int = 100, media_ids: str = ""):
    if not DB_PATH.exists():
        return {"items": [], "total": 0}

    # Parse optional media_ids filter (comma-separated)
    filter_media_ids: list[int] = []
    if media_ids:
        filter_media_ids = [int(x) for x in media_ids.split(",") if x.strip().isdigit()]

    try:
        with get_db_connection() as conn:
            c = conn.cursor()

            # Build optional media_id filter clause
            media_filter_clause = ""
            media_filter_params: list = []
            if filter_media_ids:
                placeholders = ",".join(["?"] * len(filter_media_ids))
                media_filter_clause = f" AND media_id IN ({placeholders})"
                media_filter_params = list(filter_media_ids)

            count_query = f"""
                SELECT COUNT(*) FROM (
                    SELECT * FROM generated_seo s1
                    WHERE id = (SELECT MAX(id) FROM generated_seo s2 WHERE s2.media_id = s1.media_id)
                    {media_filter_clause}
                ) WHERE review_status = ?
            """
            c.execute(count_query, media_filter_params + [review_status])
            total = c.fetchone()[0]

            query = f"""
                SELECT s.id, s.media_id, s.title, s.alt_text, s.caption, s.description,
                       s.category_detected, s.generator, s.review_status,
                       m.filename, m.source_url, 
                       m.title as orig_title, m.alt_text as orig_alt_text,
                       m.caption as orig_caption, m.description as orig_description
                FROM (
                    SELECT * FROM generated_seo s1
                    WHERE id = (SELECT MAX(id) FROM generated_seo s2 WHERE s2.media_id = s1.media_id)
                    {media_filter_clause}
                ) s
                JOIN media_items m ON s.media_id = m.id
                WHERE s.review_status = ?
                ORDER BY s.media_id DESC
                LIMIT ?
            """
            c.execute(query, media_filter_params + [review_status, limit])
            items = [dict(row) for row in c.fetchall()]
            return {"items": items, "total": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _build_task_env() -> dict[str, str]:
    stored = _read_settings()
    wp_url = _pick_value(str(stored.get("wpUrl", "")), "", "WP_URL") or WP_URL_HARDCODED
    wp_user = _pick_value(str(stored.get("wpUser", "")), "", "WP_USER") or WP_USER_HARDCODED
    wp_app_pass = _normalize_wp_app_pass(
        _pick_value(str(stored.get("wpAppPass", "")), "", "WP_APP_PASS") or WP_APP_PASS_HARDCODED
    )
    google_api_key = _pick_value(str(stored.get("googleApiKey", "")), "", "GEMINI_API_KEY")
    sftp_host = _pick_value(str(stored.get("sftpHost", "")), "", "SFTP_HOST")
    sftp_port = str(stored.get("sftpPort", os.getenv("SFTP_PORT", "22")))
    sftp_user = _pick_value(str(stored.get("sftpUser", "")), "", "SFTP_USER")
    sftp_pass = _pick_value(str(stored.get("sftpPass", "")), "", "SFTP_PASSWORD")
    remote_wp_root = _pick_value(str(stored.get("remoteWpRoot", "")), "", "REMOTE_WP_ROOT")

    env = {}
    if wp_url: env["WP_BASE_URL"] = wp_url.strip()
    if wp_user: env["WP_USER"] = wp_user.strip()
    if wp_app_pass: env["WP_APP_PASSWORD"] = wp_app_pass.strip()
    if google_api_key:
        env["GEMINI_API_KEY"] = google_api_key.strip()
        env["LLM_PROVIDER"] = "gemini"
    if sftp_host: env["SFTP_HOST"] = sftp_host.strip()
    if sftp_port: env["SFTP_PORT"] = sftp_port.strip()
    if sftp_user: env["SFTP_USER"] = sftp_user.strip()
    if sftp_pass: env["SFTP_PASSWORD"] = sftp_pass.strip()
    if remote_wp_root: env["REMOTE_WP_ROOT"] = remote_wp_root.strip()
    # Pass keyword file to CLI if it exists
    if KEYWORDS_FILE.exists():
        env["KEYWORDS_JSON_PATH"] = str(KEYWORDS_FILE.resolve())
    return env

@app.post("/media/scan")
def media_scan(payload: MediaScanPayload):
    args = ["node", "--import", "tsx", "src/cli.ts", "scan"]
    creds = _resolve_cli_wp_credentials()
    _assert_wp_rest_access(creds)
    
    if payload.limit > 0:
        args.extend(["--limit", str(payload.limit)])
    start_task("scan", args, _build_task_env())
    return {"ok": True}

@app.post("/media/run")
def media_run(payload: MediaRunPayload):
    creds = _resolve_cli_wp_credentials()
    _assert_wp_rest_access(creds)
    task_env = _build_task_env()

    if payload.useRestReplace and not payload.dryRun and not payload.metadataOnly:
        probe = _probe_rest_replace_status(creds)
        if not probe["available"] and not _has_sftp_fallback(task_env):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{probe['detail']} No SFTP fallback is configured, so this run would fail. "
                    "Disable 免SFTP模式 or fill in the SFTP settings first."
                ),
            )
    
    args = ["node", "--import", "tsx", "src/cli.ts", "run"]
    if payload.ids:
        args.extend(["--ids", ",".join(map(str, payload.ids))])
    
    args.extend(["--dry-run", "true" if payload.dryRun else "false"])
    
    if payload.force:
        args.append("--force")
    # Always skip scan when IDs are specified — only process selected items
    if payload.skipScan or payload.ids:
        args.append("--skip-scan")
    if payload.metadataOnly:
        args.append("--metadata-only")
    if payload.useRestReplace:
        args.append("--use-rest-replace")
    if payload.quality:
        args.extend(["--quality", str(payload.quality)])
    
    start_task("run", args, task_env)
    return {"ok": True}

@app.post("/media/stop")
def media_stop():
    if "process" in running_tasks and running_tasks["process"].poll() is None:
        running_tasks["process"].terminate()
        return {"ok": True}
    return {"ok": False, "detail": "No task running"}

@app.put("/media/seo-review/{seo_id}")
def update_seo_review(seo_id: int, payload: dict):
    if not DB_PATH.exists():
        raise HTTPException(status_code=400, detail="Database not found")
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            updates = []
            values = []
            for k in ["title", "alt_text", "caption", "description", "review_status"]:
                if k in payload:
                    updates.append(f"{k}=?")
                    values.append(payload[k])
            if not updates:
                return {"ok": True}
            
            values.append(seo_id)
            c.execute(f"UPDATE generated_seo SET {','.join(updates)} WHERE id=?", values)
            conn.commit()
            return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/media/seo-review/batch")
def batch_update_seo_review(payload: dict):
    ids = payload.get("ids", [])
    review_status = payload.get("review_status")
    if not ids or not review_status or not DB_PATH.exists():
        return {"ok": False}
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            placeholders = ",".join(["?"] * len(ids))
            c.execute(f"UPDATE generated_seo SET review_status=? WHERE id IN ({placeholders})", [review_status] + ids)
            conn.commit()
            return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _query_seo_rows(ids: list[int], by_media_id: bool = False) -> list[dict]:
    """Fetch generated_seo rows.

    When *by_media_id* is False (default), *ids* are ``generated_seo.id`` values.
    When *by_media_id* is True, *ids* are ``media_items.id`` values and we return
    the **latest** generated_seo row per media_id.
    """
    with get_db_connection() as conn:
        c = conn.cursor()
        placeholders = ",".join(["?"] * len(ids))
        if by_media_id:
            # Pick the latest generated_seo row for each media_id
            c.execute(
                f"""SELECT id, media_id, title, alt_text, caption, description
                    FROM generated_seo s1
                    WHERE media_id IN ({placeholders})
                      AND id = (SELECT MAX(id) FROM generated_seo s2
                                WHERE s2.media_id = s1.media_id)""",
                ids,
            )
        else:
            c.execute(
                f"""SELECT id, media_id, title, alt_text, caption, description
                    FROM generated_seo WHERE id IN ({placeholders})""",
                ids,
            )
        return [dict(row) for row in c.fetchall()]


def _push_seo_to_wordpress(seo_rows: list[dict], wp_url: str, wp_user: str, wp_app_pass: str) -> dict:
    """Push a list of generated_seo rows to WordPress via REST API.

    Returns ``{"applied": int, "skipped": int, "errors": [...]}``
    """
    applied = 0
    skipped = 0
    errors: list[dict] = []

    for seo in seo_rows:
        media_id = seo["media_id"]
        meta_payload: dict[str, str] = {}
        if seo.get("title"):
            meta_payload["title"] = seo["title"]
        if seo.get("alt_text"):
            meta_payload["alt_text"] = seo["alt_text"]
        if seo.get("caption"):
            meta_payload["caption"] = seo["caption"]
        if seo.get("description"):
            meta_payload["description"] = seo["description"]

        if not meta_payload:
            skipped += 1
            continue

        endpoint = f"{wp_url}/wp-json/wp/v2/media/{media_id}"
        try:
            resp = _http_request_with_proxy_fallback(
                "POST",
                endpoint,
                timeout=30,
                json=meta_payload,
                auth=(wp_user, wp_app_pass),
            )
            if resp.status_code < 400:
                applied += 1
                # Mark as applied in the database
                with get_db_connection() as conn2:
                    conn2.execute(
                        "UPDATE generated_seo SET review_status='applied' WHERE id=?",
                        (seo["id"],),
                    )
                    conn2.execute(
                        "UPDATE media_items SET status='updated', error_reason=NULL, updated_at=datetime('now') WHERE id=?",
                        (media_id,),
                    )
                    conn2.commit()
            else:
                err_detail = resp.text[:200]
                errors.append(
                    {"media_id": media_id, "status": resp.status_code, "detail": err_detail}
                )
                with get_db_connection() as conn2:
                    conn2.execute(
                        "UPDATE media_items SET status='error', error_reason=?, updated_at=datetime('now') WHERE id=?",
                        (f"[HTTP {resp.status_code}] {err_detail}", media_id),
                    )
                    conn2.commit()
        except Exception as req_err:
            err_msg = str(req_err)[:300]
            errors.append({"media_id": media_id, "detail": err_msg})
            try:
                with get_db_connection() as conn2:
                    conn2.execute(
                        "UPDATE media_items SET status='error', error_reason=?, updated_at=datetime('now') WHERE id=?",
                        (err_msg, media_id),
                    )
                    conn2.commit()
            except Exception:
                pass

    result: dict = {"applied": applied, "skipped": skipped}
    if errors:
        result["errors"] = errors
    return result


@app.post("/media/apply-seo")
def apply_seo(payload: dict):
    """Apply SEO data from the database directly to WordPress via REST API.

    Accepts either:
      - ``ids``: list of ``generated_seo.id`` values (from review panel approve flow)
      - ``media_ids``: list of ``media_items.id`` values (from "仅更新 SEO" button);
        the latest generated_seo row per media_id will be used.

    If both are provided, ``ids`` takes precedence.
    """
    ids: list[int] = payload.get("ids", [])
    media_ids: list[int] = payload.get("media_ids", [])

    if not ids and not media_ids:
        return {"ok": False, "detail": "No ids or media_ids provided"}
    if not DB_PATH.exists():
        return {"ok": False, "detail": "Database not found"}

    creds = _resolve_cli_wp_credentials()
    _assert_wp_rest_access(creds)

    wp_url = creds["wp_url"].rstrip("/")
    wp_user = creds["wp_user"]
    wp_app_pass = creds["wp_app_pass"]

    try:
        if ids:
            seo_rows = _query_seo_rows(ids, by_media_id=False)
        else:
            seo_rows = _query_seo_rows(media_ids, by_media_id=True)

        if not seo_rows:
            return {"applied": 0, "detail": "No generated SEO data found for the given IDs"}

        return _push_seo_to_wordpress(seo_rows, wp_url, wp_user, wp_app_pass)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/media/proxy-image")
def proxy_image(url: str):
    try:
        req = _http_request_with_proxy_fallback(
            "GET",
            url,
            timeout=30,
        )
        if str(req.headers.get("cf-mitigated", "")).lower() == "challenge":
            raise HTTPException(
                status_code=502,
                detail="Cloudflare challenge blocked the original image URL",
            )
        if req.status_code != 200:
            raise HTTPException(status_code=req.status_code, detail="Failed to fetch image")
        return Response(content=req.content, media_type=req.headers.get("content-type", "image/jpeg"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Keyword spreadsheet management — with AI categorization
# ---------------------------------------------------------------------------

# Product categories must match src/keywords.ts DEFAULT_CATEGORIES
PRODUCT_CATEGORIES = [
    {"slug": "soap-dispenser", "displayName": "Soap Dispenser"},
    {"slug": "paper-towel-dispenser", "displayName": "Paper Towel Dispenser"},
    {"slug": "hand-dryer", "displayName": "Hand Dryer"},
    {"slug": "air-freshener", "displayName": "Air Freshener Dispenser"},
    {"slug": "toilet-seat-cover", "displayName": "Toilet Seat Cover Dispenser"},
    {"slug": "waste-receptacle", "displayName": "Waste Receptacle"},
    {"slug": "restroom-equipment", "displayName": "Commercial Restroom Equipment"},
]

def _get_gemini_api_key() -> str:
    stored = _read_settings()
    return _pick_value(str(stored.get("googleApiKey", "")), "", "GEMINI_API_KEY")


def _categorize_keywords_with_ai(keywords: list[dict], api_key: str) -> list[dict]:
    """Use Gemini to categorize keywords by product category and B2B intent."""
    import google.generativeai as genai
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel("gemini-2.0-flash")

    cat_list = "\n".join([f"- {c['slug']}: {c['displayName']}" for c in PRODUCT_CATEGORIES])

    categorized = []
    batch_size = 50
    for i in range(0, len(keywords), batch_size):
        batch = keywords[i:i + batch_size]
        kw_lines = "\n".join([
            f"{idx+1}. \"{kw['keyword']}\" (volume: {kw.get('volume', '?')}, intent: {kw.get('intent', '?')})"
            for idx, kw in enumerate(batch)
        ])

        prompt = f"""You are a B2B product SEO expert for commercial restroom/washroom equipment.

Analyze each keyword below and categorize it.

Product categories:
{cat_list}
- other: Not related to any above category

For each keyword, return a JSON array with objects containing:
- "index": the keyword number (1-based)
- "category": the matching product category slug (or "other")
- "b2bScore": 0-100 score indicating B2B commercial intent (100 = clearly B2B/wholesale/manufacturer/supplier, 0 = purely informational/consumer)
- "suggestedPhrase": a short SEO-optimized phrase incorporating this keyword for B2B product pages (max 60 chars)

Keywords:
{kw_lines}

Return ONLY valid JSON array, no markdown."""

        try:
            response = model.generate_content(prompt)
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
            if text.startswith("json"):
                text = text[4:].strip()

            results = json.loads(text)
            for r in results:
                idx = r.get("index", 0) - 1
                if 0 <= idx < len(batch):
                    enriched = {**batch[idx]}
                    enriched["category"] = r.get("category", "other")
                    enriched["b2bScore"] = r.get("b2bScore", 0)
                    enriched["suggestedPhrase"] = r.get("suggestedPhrase", "")
                    categorized.append(enriched)
        except Exception as e:
            for kw in batch:
                categorized.append({**kw, "category": "other", "b2bScore": 0, "suggestedPhrase": ""})
            print(f"AI categorization failed for batch: {e}")

    categorized_keywords = {kw["keyword"] for kw in categorized}
    for kw in keywords:
        if kw["keyword"] not in categorized_keywords:
            categorized.append({**kw, "category": "other", "b2bScore": 0, "suggestedPhrase": ""})

    return categorized


@app.post("/media/keywords")
def upload_keywords(payload: dict):
    """Save and AI-categorize keyword data from frontend."""
    keywords = payload.get("keywords", [])
    if not keywords:
        raise HTTPException(status_code=400, detail="No keywords provided")

    api_key = _get_gemini_api_key()
    KEYWORDS_FILE.parent.mkdir(parents=True, exist_ok=True)

    if api_key:
        try:
            categorized = _categorize_keywords_with_ai(keywords, api_key)
            cat_counts: dict[str, int] = {}
            b2b_count = 0
            for kw in categorized:
                cat = kw.get("category", "other")
                cat_counts[cat] = cat_counts.get(cat, 0) + 1
                if kw.get("b2bScore", 0) >= 50:
                    b2b_count += 1

            KEYWORDS_FILE.write_text(
                json.dumps(categorized, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return {
                "ok": True,
                "count": len(categorized),
                "categorized": True,
                "b2bCount": b2b_count,
                "categorySummary": cat_counts,
            }
        except Exception as e:
            KEYWORDS_FILE.write_text(
                json.dumps(keywords, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return {"ok": True, "count": len(keywords), "categorized": False, "error": str(e)}
    else:
        KEYWORDS_FILE.write_text(
            json.dumps(keywords, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return {"ok": True, "count": len(keywords), "categorized": False}


@app.get("/media/keywords")
def get_keywords():
    """Read saved keyword data."""
    if not KEYWORDS_FILE.exists():
        return {"keywords": [], "count": 0, "categorized": False}
    try:
        data = json.loads(KEYWORDS_FILE.read_text(encoding="utf-8"))
        is_categorized = len(data) > 0 and "category" in data[0]
        b2b_count = sum(1 for kw in data if kw.get("b2bScore", 0) >= 50) if is_categorized else 0
        cat_counts: dict[str, int] = {}
        if is_categorized:
            for kw in data:
                cat = kw.get("category", "other")
                cat_counts[cat] = cat_counts.get(cat, 0) + 1
        return {
            "keywords": data,
            "count": len(data),
            "categorized": is_categorized,
            "b2bCount": b2b_count,
            "categorySummary": cat_counts,
        }
    except Exception:
        return {"keywords": [], "count": 0, "categorized": False}


@app.delete("/media/keywords")
def delete_keywords():
    """Clear saved keyword data."""
    if KEYWORDS_FILE.exists():
        KEYWORDS_FILE.unlink()
    return {"ok": True}


# ===== WooCommerce Product SEO Endpoints =====

def _build_product_task_env() -> dict[str, str]:
    """Build environment variables for product CLI tasks, including WC keys."""
    env = _build_task_env()
    stored = _read_settings()
    # Prefer saved settings when present, otherwise fall back to environment.
    wc_key = (
        str(stored.get("wcConsumerKey", "")).strip()
        or os.getenv("WC_CONSUMER_KEY", "").strip()
    )
    wc_secret = (
        str(stored.get("wcConsumerSecret", "")).strip()
        or os.getenv("WC_CONSUMER_SECRET", "").strip()
    )
    if wc_key:
        env["WC_CONSUMER_KEY"] = wc_key
    if wc_secret:
        env["WC_CONSUMER_SECRET"] = wc_secret
    return env


@app.get("/product-scan")
def product_scan():
    """Scan WooCommerce products via Node CLI."""
    args = ["node", "--import", "tsx", "src/cli.ts", "product-scan"]
    start_task("product-scan", args, _build_product_task_env())
    return {"ok": True, "message": "Product scan started"}


@app.get("/products/categories")
def product_categories():
    """List available WooCommerce product categories from scanned products."""
    if not DB_PATH.exists():
        return {"items": []}

    _ensure_product_category_columns()
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute(
                """
                SELECT category_slugs, category_names
                FROM product_items
                WHERE category_slugs != '' OR category_names != ''
                """
            )
            rows = c.fetchall()
    except Exception:
        return {"items": []}

    counts: dict[str, int] = {}
    names_by_slug: dict[str, str] = {}
    for row in rows:
        slugs = [s.lower() for s in _split_category_tokens(row["category_slugs"])]
        names = _split_category_tokens(row["category_names"])
        seen: set[str] = set()
        for index, slug in enumerate(slugs):
            if not slug or slug in seen:
                continue
            seen.add(slug)
            counts[slug] = counts.get(slug, 0) + 1
            if slug not in names_by_slug:
                names_by_slug[slug] = names[index] if index < len(names) else slug.replace("-", " ")

    items = [
        {"slug": slug, "name": names_by_slug.get(slug, slug), "count": counts[slug]}
        for slug in counts.keys()
    ]
    items.sort(key=lambda x: str(x.get("name") or x.get("slug") or "").lower())
    return {"items": items}


@app.get("/products")
def product_list(
    page: int = 1,
    limit: int = 20,
    q: str = "",
    category: str = "",
    issue: str = "",
):
    """List all scanned products from the database with pagination."""
    if not DB_PATH.exists():
        return {"items": [], "total": 0, "issue_summary": {}}
    try:
        _ensure_product_category_columns()
        page = max(1, page)
        limit = max(1, min(200, limit))
        offset = (page - 1) * limit
        keyword = q.strip()
        category_slug = category.strip().lower()
        issue_filters = _normalize_issue_filters(issue)
        with get_db_connection() as conn:
            c = conn.cursor()
            where_parts: list[str] = []
            where_args: list[Any] = []

            if keyword:
                where_parts.append("name LIKE ?")
                where_args.append(f"%{keyword}%")
            if category_slug:
                where_parts.append("category_slugs LIKE ?")
                where_args.append(f"%|{category_slug}|%")

            where_sql = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""

            c.execute(
                f"SELECT * FROM product_items{where_sql} ORDER BY id ASC",
                tuple(where_args),
            )
            all_items = [_annotate_product_issue_fields(dict(row)) for row in c.fetchall()]

            if issue_filters:
                all_items = [
                    item
                    for item in all_items
                    if any(bool(item.get("issue_flags", {}).get(flag)) for flag in issue_filters)
                ]

            total = len(all_items)
            items = all_items[offset: offset + limit]
            issue_summary = {
                key: sum(1 for item in all_items if bool(item.get("issue_flags", {}).get(key)))
                for key in PRODUCT_ISSUE_FLAG_KEYS
            }

            return {
                "items": items,
                "total": total,
                "issue_summary": issue_summary,
                "applied_issue_filters": issue_filters,
            }
    except HTTPException:
        raise
    except Exception:
        return {"items": [], "total": 0, "issue_summary": {}}


class ProductTemplatePayload(BaseModel):
    template: str = ""


@app.get("/product-template")
def get_product_template():
    """Get default product SEO template text."""
    try:
        if not PRODUCT_TEMPLATE_FILE.exists():
            PRODUCT_TEMPLATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            PRODUCT_TEMPLATE_FILE.write_text(
                DEFAULT_PRODUCT_TEMPLATE,
                encoding="utf-8",
            )
        content = PRODUCT_TEMPLATE_FILE.read_text(encoding="utf-8")
        return {
            "template": content,
            "path": str(PRODUCT_TEMPLATE_FILE),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/product-template")
def save_product_template(payload: ProductTemplatePayload):
    """Persist default product SEO template text."""
    template = (payload.template or "").strip()
    if not template:
        raise HTTPException(status_code=400, detail="Template cannot be empty")
    try:
        PRODUCT_TEMPLATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        PRODUCT_TEMPLATE_FILE.write_text(template, encoding="utf-8")
        return {
            "ok": True,
            "path": str(PRODUCT_TEMPLATE_FILE),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/products/render-version")
def get_products_render_version():
    return {
        "docx_render_version": DOCX_RENDER_VERSION,
        "product_template_file": str(PRODUCT_TEMPLATE_FILE),
        "template_exists": PRODUCT_TEMPLATE_FILE.exists(),
    }

class ProductUpdatePayload(BaseModel):
    short_description: Optional[str] = None
    description: Optional[str] = None
    short_ref_images: Optional[str] = None
    full_ref_images: Optional[str] = None
    acf_seo_extra_info: Optional[str] = None
    aioseo_title: Optional[str] = None
    aioseo_description: Optional[str] = None
    catalog_text: Optional[str] = None
    slug: Optional[str] = None


class ProductBatchSyncPayload(BaseModel):
    ids: list[int] = []
    fields: list[str] = []
    only_changed: bool = True


class ProductSingleSyncPayload(BaseModel):
    fields: list[str] = []
    only_changed: bool = True


@app.post("/products/{product_id}/sync-seo")
def sync_product_seo(product_id: int, payload: ProductSingleSyncPayload | None = None):
    """Sync one product's current local SEO fields to WooCommerce immediately."""
    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    _ensure_product_category_columns()

    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute(
                """
                SELECT id, name, short_description, description,
                       acf_seo_extra_info, aioseo_title, aioseo_description,
                       category_names, image_urls, short_ref_images, full_ref_images
                FROM product_items
                WHERE id = ?
                """,
                (product_id,),
            )
            row = c.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Product not found")
            item = dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    sync_fields = _normalize_product_sync_fields(payload.fields if payload else [])
    only_changed = True if payload is None else bool(payload.only_changed)
    sync_result = _sync_selected_product_fields_to_wp(
        product_id=product_id,
        item=item,
        fields=sync_fields,
        only_changed=only_changed,
    )

    if not bool(sync_result.get("skipped")):
        try:
            with get_db_connection() as conn:
                c = conn.cursor()
                c.execute(
                    """
                    UPDATE product_items
                    SET status = 'updated',
                        error_reason = NULL,
                        updated_at = datetime('now')
                    WHERE id = ?
                    """,
                    (product_id,),
                )
                conn.commit()
        except Exception:
            pass

    return {
        "ok": True,
        "product_id": product_id,
        "name": item.get("name", ""),
        "selected_fields": sync_fields,
        "synced_fields": sync_result.get("synced_fields", []),
        "skipped": bool(sync_result.get("skipped")),
        "synced_meta": _pick_product_meta(
            sync_result.get("remote", {}) if isinstance(sync_result, dict) else {},
            ["short_description", "product_extra_info——seo", "_aioseo_title", "_aioseo_description"],
        ),
    }


@app.post("/products/sync-seo-batch")
def sync_product_seo_batch(payload: ProductBatchSyncPayload):
    """Sync selected products' current local SEO fields to WooCommerce."""
    ids = [int(i) for i in payload.ids if int(i) > 0]
    if not ids:
        raise HTTPException(status_code=400, detail="No valid product IDs provided")
    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    _ensure_product_category_columns()

    placeholders = ",".join(["?"] * len(ids))
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute(
                f"""
                SELECT id, name, short_description, description,
                       acf_seo_extra_info, aioseo_title, aioseo_description,
                       category_names, image_urls, short_ref_images, full_ref_images
                FROM product_items
                WHERE id IN ({placeholders})
                ORDER BY id ASC
                """,
                ids,
            )
            rows = [dict(r) for r in c.fetchall()]

            if not rows:
                raise HTTPException(status_code=404, detail="No matching products found")

            sync_fields = _normalize_product_sync_fields(payload.fields or [])
            only_changed = bool(payload.only_changed)
            applied = 0
            skipped = 0
            failed: list[dict[str, Any]] = []
            for item in rows:
                product_id = int(item["id"])
                try:
                    sync_result = _sync_selected_product_fields_to_wp(
                        product_id=product_id,
                        item=item,
                        fields=sync_fields,
                        only_changed=only_changed,
                    )
                    if bool(sync_result.get("skipped")):
                        skipped += 1
                    else:
                        c.execute(
                            """
                            UPDATE product_items
                            SET status = 'updated',
                                error_reason = NULL,
                                updated_at = datetime('now')
                            WHERE id = ?
                            """,
                            (product_id,),
                        )
                        applied += 1
                except Exception as e:
                    msg = str(e)
                    c.execute(
                        """
                        UPDATE product_items
                        SET status = 'error',
                            error_reason = ?,
                            updated_at = datetime('now')
                        WHERE id = ?
                        """,
                        (msg[:500], product_id),
                    )
                    failed.append(
                        {
                            "product_id": product_id,
                            "name": item.get("name", ""),
                            "error": msg,
                        }
                    )
            conn.commit()

            return {
                "ok": True,
                "requested": len(ids),
                "found": len(rows),
                "applied": applied,
                "skipped": skipped,
                "failed": len(failed),
                "selected_fields": sync_fields,
                "only_changed": only_changed,
                "errors": failed[:10],
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/products/{product_id}")
def update_product(product_id: int, payload: ProductUpdatePayload):
    """Update product details in the local database."""
    if not DB_PATH.exists():
        return {"ok": False, "detail": "Database not found"}
    _ensure_product_category_columns()
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            updates = []
            values = []
            if payload.short_description is not None:
                updates.append("short_description=?")
                values.append(payload.short_description)
            if payload.description is not None:
                updates.append("description=?")
                values.append(payload.description)
            if payload.short_ref_images is not None:
                updates.append("short_ref_images=?")
                values.append(payload.short_ref_images)
            if payload.full_ref_images is not None:
                updates.append("full_ref_images=?")
                values.append(payload.full_ref_images)
            if payload.acf_seo_extra_info is not None:
                updates.append("acf_seo_extra_info=?")
                values.append(payload.acf_seo_extra_info)
            if payload.aioseo_title is not None:
                updates.append("aioseo_title=?")
                values.append(payload.aioseo_title)
            if payload.aioseo_description is not None:
                updates.append("aioseo_description=?")
                values.append(payload.aioseo_description)
            if payload.catalog_text is not None:
                updates.append("catalog_text=?")
                values.append(payload.catalog_text)
            if payload.slug is not None:
                updates.append("slug=?")
                values.append(payload.slug)
            
            if not updates:
                return {"ok": True}
                
            values.append(product_id)
            c.execute(f"UPDATE product_items SET {','.join(updates)} WHERE id=?", values)
            conn.commit()
            return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class ProductRunPayload(BaseModel):
    template: str = ""
    language: str = ""
    limit: int = 0
    force: bool = False
    skipScan: bool = True
    ids: list[int] = []


class ProductGenerateFieldPayload(BaseModel):
    field: str
    short_description: str = ""
    description: str = ""
    short_ref_images: str = ""
    full_ref_images: str = ""
    current_value: str = ""
    language: str = "en"
    short_template: str = ""
    full_template: str = ""
    seo_keywords: str = ""


class ProductBatchGeneratePayload(BaseModel):
    ids: list[int] = []
    fields: list[str] = []
    language: str = "en"
    short_template: str = ""
    full_template: str = ""


def _strip_html(value: str) -> str:
    import re
    return re.sub(r"<[^>]+>", " ", value or "").strip()


def _truncate(value: str, max_len: int) -> str:
    text = (value or "").strip()
    return text if len(text) <= max_len else text[:max_len].strip()


def _truncate_words(value: str, max_words: int) -> str:
    text = (value or "").strip()
    if not text:
        return ""
    words = [w for w in text.split() if w]
    if len(words) <= max_words:
        return " ".join(words)
    return " ".join(words[:max_words]).strip()


def _ensure_html(value: str, fallback: str = "") -> str:
    text = str(value or "").strip() or str(fallback or "").strip()
    if not text:
        return ""
    return text if re.search(r"<[^>]+>", text) else f"<p>{text}</p>"


def _parse_image_refs(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        out = [str(v).strip() for v in value if str(v).strip()]
        return list(dict.fromkeys(out))

    text = str(value or "").strip()
    if not text:
        return []

    if text.startswith("[") and text.endswith("]"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                out = [str(v).strip() for v in parsed if str(v).strip()]
                return list(dict.fromkeys(out))
        except Exception:
            pass

    parts = re.split(r"[\r\n,]+", text)
    out = [p.strip() for p in parts if p.strip()]
    return list(dict.fromkeys(out))


def _pick_image_mime(source: str, content_type: str = "") -> str:
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype.startswith("image/"):
        return ctype
    guessed, _ = mimetypes.guess_type(source)
    if guessed and guessed.startswith("image/"):
        return guessed
    return "image/jpeg"


def _load_image_inline_part(source: str, timeout: float = 20.0) -> Optional[dict[str, Any]]:
    src = str(source or "").strip()
    if not src:
        return None

    try:
        if src.startswith("file://"):
            local = Path(src.replace("file://", "", 1))
            if not local.exists() or not local.is_file():
                return None
            data = local.read_bytes()
            mime = _pick_image_mime(local.name)
        elif src.startswith("/"):
            local = Path(src)
            if not local.exists() or not local.is_file():
                return None
            data = local.read_bytes()
            mime = _pick_image_mime(local.name)
        elif src.startswith("http://") or src.startswith("https://"):
            resp = _http_request_with_proxy_fallback("GET", src, timeout=timeout, follow_redirects=True)
            if resp.status_code >= 400:
                return None
            data = resp.content
            mime = _pick_image_mime(src, resp.headers.get("content-type", ""))
        else:
            return None
    except Exception:
        return None

    if not data or len(data) > 5 * 1024 * 1024:
        return None
    if not str(mime).startswith("image/"):
        return None

    encoded = base64.b64encode(data).decode("ascii")
    return {"inline_data": {"mime_type": mime, "data": encoded}}


_LONG_TAIL_CACHE: dict[str, list[str]] = {}


def _parse_suggest_response(data: Any) -> list[str]:
    if not isinstance(data, list) or len(data) < 2:
        return []
    values = data[1]
    if not isinstance(values, list):
        return []
    out: list[str] = []
    for val in values:
        if isinstance(val, str):
            text = val.strip()
            if text:
                out.append(text)
    return out


def _discover_long_tail_keywords(seed: str, language: str = "en", limit: int = 12) -> list[str]:
    root = str(seed or "").strip()
    if not root:
        return []

    cache_key = f"{language.lower()}::{root.lower()}"
    if cache_key in _LONG_TAIL_CACHE:
        return _LONG_TAIL_CACHE[cache_key][:limit]

    lang = (language or "en").split("-")[0].lower()
    variants = [
        root,
        f"{root} manufacturer",
        f"{root} supplier",
        f"{root} wholesale",
        f"{root} OEM",
    ]

    found: list[str] = []
    for query in variants:
        q = quote_plus(query)
        urls = [
            f"https://suggestqueries.google.com/complete/search?client=firefox&hl={lang}&q={q}",
            f"https://api.bing.com/osjson.aspx?query={q}",
        ]
        for url in urls:
            try:
                resp = _http_request_with_proxy_fallback("GET", url, timeout=12, follow_redirects=True)
                if resp.status_code >= 400:
                    continue
                data = resp.json()
                for kw in _parse_suggest_response(data):
                    found.append(kw)
            except Exception:
                continue

    deduped: list[str] = []
    root_l = root.lower()
    for kw in found:
        norm = re.sub(r"\s+", " ", kw).strip()
        if not norm:
            continue
        if norm.lower() == root_l:
            continue
        if len(norm) < 6 or len(norm) > 120:
            continue
        if norm not in deduped:
            deduped.append(norm)

    _LONG_TAIL_CACHE[cache_key] = deduped[:50]
    return deduped[:limit]


def _parse_json_relaxed(raw: str) -> dict[str, Any]:
    text = str(raw or "").strip()
    if not text:
        return {}
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE | re.DOTALL).strip()
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, dict) else {}
    except Exception:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        try:
            value = json.loads(cleaned[start : end + 1])
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}
    return {}


def _to_plain_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    elif isinstance(value, (int, float, bool)):
        text = str(value)
    elif isinstance(value, list):
        text = "; ".join(str(v) for v in value if str(v).strip())
    else:
        text = str(value)
    text = _strip_html(text)
    return re.sub(r"\s+", " ", text).strip()


def _to_plain_list(value: Any) -> list[str]:
    if isinstance(value, list):
        out = [_to_plain_text(v) for v in value]
    elif isinstance(value, str):
        out = [_to_plain_text(v) for v in re.split(r"[\r\n;]+", value)]
    else:
        out = []
    return [item for item in out if item]


def _safe_html_text(value: Any, fallback: str = "") -> str:
    text = _to_plain_text(value) or _to_plain_text(fallback)
    return escape(text, quote=True)


def _upload_single_ref_image_to_wp(filepath: str, alt_text: str = "") -> str:
    """Upload a local image file to WordPress media library and return the source_url."""
    fpath = Path(filepath)
    if not fpath.exists() or not fpath.is_file():
        return ""

    creds = _resolve_cli_wp_credentials()
    wp_url = creds["wp_url"]
    wp_user = creds["wp_user"]
    wp_app_pass = creds["wp_app_pass"]

    if not wp_url or not wp_user or not wp_app_pass:
        return ""

    endpoint = f"{wp_url.rstrip('/')}/wp-json/wp/v2/media"
    content_type = mimetypes.guess_type(str(fpath))[0] or "image/jpeg"

    file_bytes = fpath.read_bytes()
    if not file_bytes:
        return ""

    files = {"file": (fpath.name, file_bytes, content_type)}

    try:
        resp = _http_request_with_proxy_fallback(
            "POST", endpoint, timeout=60,
            files=files, auth=(wp_user, wp_app_pass),
        )
        if resp.status_code >= 400:
            print(f"[wp-upload] Failed to upload {fpath.name}: HTTP {resp.status_code}")
            return ""
        data = resp.json()

        media_id = data.get("id")
        if media_id and alt_text:
            try:
                _http_request_with_proxy_fallback(
                    "POST", f"{endpoint}/{media_id}", timeout=30,
                    json={"alt_text": alt_text}, auth=(wp_user, wp_app_pass),
                )
            except Exception:
                pass

        source_url = data.get("source_url", "")
        print(f"[wp-upload] Uploaded {fpath.name} → {source_url}")
        return source_url
    except Exception as e:
        print(f"[wp-upload] Exception uploading {fpath.name}: {e}")
        return ""


def _ensure_ref_images_uploaded_to_wp(product_id: int, product_name: str = "") -> list[str]:
    """Scan product_ref_images/{product_id}/, upload any new images to WP, return list of WP URLs.

    Cached in .wp_urls.json next to the images so each file is only uploaded once.
    """
    img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
    if not img_dir.exists():
        return []

    cache_file = img_dir / ".wp_urls.json"
    cached: dict[str, str] = {}
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text())
        except Exception:
            cached = {}

    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
    wp_urls: list[str] = []
    updated = False

    for fpath in sorted(img_dir.iterdir()):
        if not fpath.is_file() or fpath.suffix.lower() not in image_exts:
            continue
        # Skip catalog images — they are AI-only context, not for HTML <img src>
        if fpath.name.startswith("catalog_"):
            continue
        if fpath.name in cached and cached[fpath.name]:
            wp_urls.append(cached[fpath.name])
        else:
            alt_text = f"{product_name} product detail" if product_name else ""
            wp_url = _upload_single_ref_image_to_wp(str(fpath), alt_text)
            if wp_url:
                cached[fpath.name] = wp_url
                wp_urls.append(wp_url)
                updated = True

    if updated:
        try:
            cache_file.write_text(json.dumps(cached, indent=2))
        except Exception:
            pass

    print(f"[wp-ref-upload] product_id={product_id}, found {len(wp_urls)} WP URLs for HTML <img src>")
    return wp_urls


def _pick_image_url(images: list[str], index: int) -> str:
    if index < len(images):
        return images[index]
    return images[0] if images else ""


def _render_docx_style_full_description(
    product_name: str,
    images: list[str],
    blocks: dict[str, Any],
    alt_texts: dict[str, str] | None = None,
) -> str:
    heading_style = "font-size: 24px; margin-bottom: 15px; color: #222;"
    para_style = "font-size: 16px; line-height: 2.0; color: #333;"
    ordered_list_style = "font-size: 16px; line-height: 2; color: #333; margin-left: 25px; margin-bottom: 15px;"

    cta_raw = _safe_html_text(blocks.get("cta_text"), "Get a Quote")
    # Force short CTA — max 6 words, fallback to default
    cta_text = cta_raw if len(cta_raw.split()) <= 6 else "Get a Quote"

    install_steps = _to_plain_list(blocks.get("installation_steps"))
    install_list_html = ""
    if install_steps:
        install_items = "".join(f"<li>{escape(item, quote=True)}</li>" for item in install_steps[:8])
        install_list_html = f'<ol style="{ordered_list_style}">{install_items}</ol>'

    clearfix = '<div style="clear: both;"></div>'

    def image_panel(src: str, alt_text: str, float_side: str = "left") -> str:
        safe_alt = escape(alt_text or product_name or "Product image", quote=True)
        if src:
            return (
                f'<div style="float: {float_side}; width: 38%; background-color: #f7f7f7; '
                'border-radius: 12px; overflow: hidden;">'
                f'<img loading="lazy" style="width: 100%; height: auto; display: block;" '
                f'src="{escape(src, quote=True)}" alt="{safe_alt}" />'
                "</div>"
            )
        return (
            f'<div style="float: {float_side}; width: 38%; min-height: 200px; background-color: #f7f7f7; '
            'text-align: center; padding-top: 80px; border-radius: 12px; overflow: hidden;">'
            f'<span style="font-size: 14px; color: #666;">{safe_alt}</span>'
            "</div>"
        )

    _alt_texts = alt_texts or {}

    def section_row(index: int, img_src: str, heading: str, body: str, extra_html: str = "", block_key: str = "") -> str:
        """Render one image + one topic section, alternating left/right."""
        alt_text = _alt_texts.get(block_key) or f"{product_name} - {heading}"
        img_float = "left" if index % 2 == 0 else "right"
        text_float = "right" if index % 2 == 0 else "left"
        img_html = image_panel(img_src, alt_text, img_float)
        text_html = (
            f'<div style="float: {text_float}; width: 58%;">'
            f'<h2 style="{heading_style}">{escape(heading, quote=True)}</h2>'
            f'<p style="{para_style}">{_safe_html_text(body)}</p>'
            f'{extra_html}'
            f'</div>'
        )
        return (
            f'<!-- Section {index + 1} -->'
            f'<div style="overflow: hidden; margin-bottom: 60px;">'
            f'{img_html}{text_html}'
            f'{clearfix}</div>'
        )

    # Define sections: (block_key, heading, fallback_block_key, extra_html)
    section_defs: list[tuple[str, str, str, str]] = [
        ("design_concept", "Design Concept", "design", ""),
        ("materials_craftsmanship", "Materials & Craftsmanship", "materials", ""),
        ("functionality_user_experience", "Functionality & User Experience", "functionality", ""),
        ("installation_options", "Installation Options", "installation_intro", install_list_html),
        ("applications", "Applications", "", ""),
        ("technical_specifications", "Technical Specifications", "specs", ""),
    ]

    sections_html = []
    for i, (block_key, heading, fallback_key, extra) in enumerate(section_defs):
        body = blocks.get(block_key) or blocks.get(fallback_key) or ""
        if not _to_plain_text(body):
            continue
        img_src = _pick_image_url(images, i)
        sections_html.append(section_row(i, img_src, heading, body, extra, block_key))

    # About + Contact section (always last, with CTA)
    about = blocks.get("about_manufacturer") or ""
    contact = blocks.get("contact_us") or ""
    if _to_plain_text(about) or _to_plain_text(contact):
        idx = len(sections_html)
        img_src = _pick_image_url(images, idx)
        alt_text = _alt_texts.get("about_manufacturer") or f"{product_name} - About the Manufacturer"
        cta_html = (
            '<div style="margin-top: 20px;">'
            '<a style="display: inline-block; padding: 14px 36px; '
            'background-color: #4CAF50; color: #ffffff; font-size: 16px; font-weight: 600; '
            'text-decoration: none; border-radius: 30px; letter-spacing: 0.5px; '
            'transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(76, 175, 80, 0.3);" '
            'href="mailto:shenzhenaolq@gmail.com" target="_blank" rel="noopener">'
            f'{cta_text}</a></div>'
        )
        img_float = "left" if idx % 2 == 0 else "right"
        text_float = "right" if idx % 2 == 0 else "left"
        img_html = image_panel(img_src, alt_text, img_float)
        text_html = (
            f'<div style="float: {text_float}; width: 58%;">'
            f'<h2 style="{heading_style}">About the Manufacturer</h2>'
            f'<p style="{para_style}">{_safe_html_text(about)}</p>'
            f'<h2 style="{heading_style}">Contact Us</h2>'
            f'<p style="{para_style}">{_safe_html_text(contact)}</p>'
            f'{cta_html}'
            f'</div>'
        )
        about_section = (
            f'<!-- Section {idx + 1} -->'
            f'<div style="overflow: hidden; margin-bottom: 60px;">'
            f'{img_html}{text_html}'
            f'{clearfix}</div>'
        )
        sections_html.append(about_section)

    return f"<!-- {DOCX_RENDER_VERSION} -->{''.join(sections_html)}"


def _generate_docx_style_description_html(
    *,
    api_key: str,
    item: dict[str, Any],
    language: str,
    short_template: str,
    full_template: str,
    long_tail: list[str],
    reference_images: list[str],
    html_images: list[str] | None = None,
    seo_keywords: str = "",
) -> str:
    product_name = str(item.get("name") or "").strip() or "Product"
    short_desc = str(item.get("short_description") or "").strip()
    full_desc = str(item.get("description") or "").strip()

    keyword_block = ""
    if long_tail:
        keyword_lines = "\n".join(f"- {kw}" for kw in long_tail)
        keyword_block = f"""
Long-tail keyword candidates (use naturally):
{keyword_lines}
"""

    template_block = ""
    if short_template:
        template_block += f"\nShort template hints:\n{short_template}\n"
    if full_template:
        template_block += f"\nFull template hints:\n{full_template}\n"

    catalog_text = str(item.get("catalog_text") or "").strip()
    catalog_block = ""
    if catalog_text:
        catalog_block = f"""
Product Catalog Reference Text (provided by user from product brochure/catalog):
\"\"\"
{catalog_text}
\"\"\"
Use the facts, specs, and descriptions from this catalog text as primary reference material.
"""

    # Build image analysis instruction
    num_images = len(reference_images)
    image_analysis_instruction = ""
    if num_images > 0:
        image_analysis_instruction = f"""
CRITICAL — Reference Images Analysis ({num_images} image(s) attached):
You MUST carefully examine EVERY attached image and extract ALL visible information including:
- Product dimensions, measurements, size annotations shown in images
- Material textures, colors, finishes visible in product photos
- Component names, part labels, text overlays on images
- Installation diagrams, step-by-step visual instructions
- Product variants (single/double/triple), model numbers
- Packaging details, accessories included
- Any text, labels, specifications, or certifications visible in the images
- Design features like magnetic lock, hollow bottom, wall mount mechanism etc.

DO NOT write generic marketing copy. Every claim must be backed by what you can SEE in the images or read from the source text / catalog content.
"""

    seo_kw_block = ""
    if seo_keywords:
        seo_kw_block = f"""
=== CRITICAL: Core SEO Keywords (provided by user) ===
{seo_keywords}

These are the PRIMARY target keywords for this product. They MUST appear prominently:
1. Use the exact core keyword phrase in the "design_concept" section's FIRST sentence.
2. Include the core keyword (or close variant) in at least 3 out of the 7 main sections.
3. Weave core keywords into section headings-friendly phrasing (they will become H2/H3 text context).
4. The "technical_specifications" and "applications" sections MUST each contain at least one core keyword.
5. "alt_texts" MUST include the core keyword in at least 3 entries.
Do NOT over-stuff — use naturally, but these keywords MUST be clearly present throughout the description.
=== END Core SEO Keywords ===
"""

    prompt = f"""You are an expert B2B commercial product copywriter for industrial and commercial buyers.
Write DETAILED, SPECIFIC section content for a WooCommerce product full description page.
Each section will be displayed as ONE image + ONE text block side by side.

Language: {language}
Product: {product_name}

Short Description Source:
\"\"\"
{short_desc}
\"\"\"

Full Description Source:
\"\"\"
{full_desc}
\"\"\"
{template_block}
{catalog_block}
{image_analysis_instruction}
{keyword_block}
{seo_kw_block}

Output STRICT JSON only with keys:
{{
  "design_concept": "...",
  "materials_craftsmanship": "...",
  "functionality_user_experience": "...",
  "installation_options": "...",
  "installation_steps": ["...", "..."],
  "applications": "...",
  "technical_specifications": "...",
  "about_manufacturer": "...",
  "contact_us": "...",
  "cta_text": "...",
  "alt_texts": {{
    "design_concept": "descriptive SEO alt text for design concept image",
    "materials_craftsmanship": "descriptive SEO alt text for materials image",
    "functionality_user_experience": "descriptive SEO alt text for functionality image",
    "installation_options": "descriptive SEO alt text for installation image",
    "applications": "descriptive SEO alt text for applications image",
    "technical_specifications": "descriptive SEO alt text for specifications image",
    "about_manufacturer": "descriptive SEO alt text for manufacturer image"
  }}
}}

Rules:
- No HTML in JSON values. Plain text only.
- Each section: write 4-8 detailed sentences with SPECIFIC product facts extracted from images and catalog content. NO generic filler.
- MUST include concrete details: exact dimensions, material names (e.g. ABS, PP, stainless steel 304), capacities (e.g. 300ml, 500ml), model numbers, color options — all extracted from images and source text.
- If catalog text is provided, you MUST incorporate its specific facts (specs, features, selling points) into the relevant sections. Do not ignore it.
- If reference images show text, labels, dimensions, or diagrams, you MUST describe and reference those specific details.
- B2B tone: write for procurement managers, facility managers, and project buyers.
- Naturally incorporate B2B commercial intent phrases: bulk order, wholesale pricing, OEM/ODM customization, commercial-grade, factory direct supply, MOQ, project supply, trade pricing, private label, after-sales support, sample available, FOB/CIF pricing, volume discount.
- Use 2-4 long-tail search phrases naturally across all sections.
- "applications": list specific B2B scenarios (hotel chains, hospital procurement, airport facilities, commercial property management, shopping mall fit-out, school campus projects).
- "technical_specifications": mention ALL specs visible in images — dimensions, capacity, material grade, weight, certifications (CE/RoHS/FCC). Be as specific as possible.
- "installation_steps": extract from installation diagrams in images if available. Be specific about tools, steps, and positioning methods shown.
- "about_manufacturer": emphasize factory capability, production capacity, export experience, ISO quality management, OEM/ODM service.
- "alt_texts": descriptive, keyword-rich, 8-15 words each, include product type and B2B keyword. If core SEO keywords are provided, include them in at least 3 alt_texts.
- "cta_text": MUST be short — max 5 words, e.g. "Get a Quote", "Request Pricing", "Contact Us Now". Do NOT write a full sentence.
- IMPORTANT: If the user provided Core SEO Keywords above, they are your TOP PRIORITY for keyword placement. They must appear naturally but clearly throughout the output — especially in design_concept, applications, and technical_specifications sections.
"""

    raw = _gemini_generate_text(
        api_key,
        prompt,
        "gemini-2.0-flash",
        image_sources=reference_images,
    )
    blocks = _parse_json_relaxed(raw)
    if not blocks:
        fallback_text = _to_plain_text(full_desc) or _to_plain_text(short_desc) or product_name
        blocks = {
            "design_concept": fallback_text,
            "materials_craftsmanship": fallback_text,
            "functionality_user_experience": fallback_text,
            "installation_options": "Wall-mounted or countertop installation depending on model.",
            "installation_steps": [
                "Choose a suitable location with convenient access.",
                "Install using the provided mounting accessories if required.",
                "Load consumables and test normal operation.",
            ],
            "applications": "Suitable for hotel chains, commercial offices, shopping malls, schools, hospitals, and public facilities. Ideal for bulk procurement and project supply.",
            "technical_specifications": fallback_text,
            "about_manufacturer": "OEM factory since 2002 with extensive export experience. We support custom branding, wholesale orders, and project-based supply with competitive MOQ and lead times.",
            "contact_us": "Contact our sales team for trade pricing, OEM customization, and bulk order support.",
            "cta_text": "Get a Quote",
        }

    # Extract alt_texts from Gemini response (or use empty dict)
    alt_texts = blocks.pop("alt_texts", None)
    if not isinstance(alt_texts, dict):
        alt_texts = {}

    # html_images: WP-hosted URLs for <img src>; fall back to reference_images (which may be local paths)
    images_for_html = html_images if html_images else reference_images
    html = _render_docx_style_full_description(product_name, images_for_html, blocks, alt_texts)
    return html, alt_texts


def _normalize_acf_card_text(value: str, fallback_source: str, product_name: str) -> str:
    import re

    text = _strip_html(value or "").strip()
    fallback = _strip_html(fallback_source or "").strip() or (product_name or "").strip()

    if not text:
        text = fallback

    # Remove common CTA fragments that don't belong to subtitle-style copy.
    text = re.sub(
        r"(?i)\b(send inquiry now|get a quote|contact us|learn more|buy now|order now)\b",
        "",
        text,
    )
    text = re.sub(
        r"(?i)\b(best|top[-\s]?quality|premium|world[-\s]?class|perfect|ultimate|amazing|excellent)\b",
        "",
        text,
    )
    text = re.sub(r"\s+", " ", text).strip(" ,;")

    # Keep only the first 2-3 concise sentences for card copy.
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    if len(sentences) > 3:
        text = " ".join(sentences[:3]).strip()

    # Keep compact subtitle length, hard cap at 50 words.
    words = [w for w in text.split() if w]
    if len(words) < 18:
        text = fallback
    text = _truncate_words(text, 50)

    # Ensure proper ending punctuation for card subtitle readability.
    if text and text[-1] not in ".!?":
        text = f"{text}."
    return text


def _gemini_generate_text(
    api_key: str,
    prompt: str,
    model_name: str = "gemini-2.0-flash",
    image_sources: Optional[list[str]] = None,
) -> str:
    image_sources = image_sources or []
    if image_sources:
        parts: list[dict[str, Any]] = [{"text": prompt}]
        for source in image_sources[:16]:
            inline_part = _load_image_inline_part(source)
            if inline_part:
                parts.append(inline_part)

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model_name}:generateContent?key={api_key}"
        )
        payload = {"contents": [{"parts": parts}]}
        with httpx.Client(timeout=90, follow_redirects=True) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        content = candidates[0].get("content") or {}
        text_parts = [
            str(p.get("text", "")).strip()
            for p in (content.get("parts") or [])
            if isinstance(p, dict)
        ]
        return "\n".join([t for t in text_parts if t]).strip()

    try:
        import google.generativeai as genai

        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(model_name)
        response = model.generate_content(prompt)
        return (response.text or "").strip()
    except ModuleNotFoundError:
        # Fallback to HTTP API when SDK is not installed in the runtime.
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model_name}:generateContent?key={api_key}"
        )
        payload = {
            "contents": [
                {
                    "parts": [{"text": prompt}],
                }
            ]
        }
        with httpx.Client(timeout=60, follow_redirects=True) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        content = candidates[0].get("content") or {}
        parts = content.get("parts") or []
        text_parts = [str(p.get("text", "")).strip() for p in parts if isinstance(p, dict)]
        return "\n".join([t for t in text_parts if t]).strip()


PRODUCT_AI_FIELDS = {
    "short_description",
    "description",
    "acf_seo_extra_info",
    "aioseo_title",
    "aioseo_description",
}

ACF_CARD_STYLE_GUIDE = """ACF card subtitle style reference:
- Natural, readable card copy like website carousel descriptions.
- 2 short sentences preferred (max 3).
- Sentence 1: what the product is + 1 core capability.
- Sentence 2: practical material/usage benefit for commercial use.
- Neutral B2B tone; factual and concise; no hype.
- Use only facts supported by Short Description + Full Description.

Good style examples (format reference only):
1) "This wall-mounted dispenser supports liquid, foam, and spray output. Its durable ABS body and 1000ml tank help reduce refill frequency in schools, offices, and public washrooms."
2) "The automatic sensor dispenser enables touch-free hand hygiene for high-traffic areas. It uses a refillable bottle design with stable output for hotels, hospitals, and commercial restrooms."
"""


def _generate_single_product_field_value(
    *,
    api_key: str,
    item: dict[str, Any],
    field: str,
    language: str = "en",
    short_template: str = "",
    full_template: str = "",
    current_value: str = "",
    seo_keywords: str = "",
    html_images: list[str] | None = None,
) -> str:
    if field not in PRODUCT_AI_FIELDS:
        raise ValueError(f"Invalid field: {field}")

    short_desc = str(item.get("short_description") or "").strip()
    full_desc = str(item.get("description") or "").strip()
    current_value = (current_value or str(item.get(field) or "")).strip()
    language = (language or "en").strip()
    short_template = (short_template or "").strip()
    full_template = (full_template or "").strip()

    field_rules = {
        "short_description": (
            "Generate ONLY WooCommerce short_description in HTML. "
            "1-2 concise paragraphs, factual B2B tone, with concrete product facts."
        ),
        "description": (
            "Generate ONLY WooCommerce full description in HTML. "
            "Use clear section structure and include concrete facts from source text and reference images."
        ),
        "acf_seo_extra_info": (
            "Generate ONLY ACF SEO extra info for a product card subtitle under the product title. "
            "Must synthesize BOTH Existing Short Description and Existing Full Description. "
            "Output plain text only (no HTML), 2 short sentences preferred (max 3), 20-45 words preferred, hard max 50 words, factual and concise, no CTA phrases."
        ),
        "aioseo_title": (
            "Generate ONLY AIOSEO title (the SEO <title> tag). Plain text only (no HTML). Max 60 chars. Must not be empty.\n"
            "SEO title best practices:\n"
            "- Put the PRIMARY keyword at the very beginning.\n"
            "- Follow the pattern: Primary Keyword + Key Benefit/Spec + Brand or Category.\n"
            "  Examples: 'Magnetic Shower Gel Bracket for Hotels | Wall-Mounted Dispenser Holder'\n"
            "            'Commercial Automatic Soap Dispenser | Touchless Wall Mount'\n"
            "            'Stainless Steel Hand Dryer for Restrooms | High Speed 10s Dry'\n"
            "- Use '|' or '-' as separator, NOT commas listing specs.\n"
            "- Do NOT just list specs with commas (BAD: 'Soap Holder, 300ml, Magnetic, ABS').\n"
            "- Make it read like a compelling search result title that people want to click.\n"
            "- Include the most important search term a B2B buyer would type in Google.\n"
            "- If user provided core SEO keywords, the FIRST keyword MUST appear in the title.\n"
        ),
        "aioseo_description": (
            "Generate ONLY AIOSEO meta description. Plain text only (no HTML). Max 160 chars. Must not be empty.\n"
            "Meta description best practices:\n"
            "- Write a compelling 1-2 sentence summary that encourages clicks from Google search results.\n"
            "- Include the primary keyword naturally within the first 60 characters.\n"
            "- Mention a key benefit or unique selling point (e.g., material, application, feature).\n"
            "- End with a soft CTA like 'Bulk pricing available' or 'OEM & ODM supported'.\n"
            "- Do NOT just list specs. Write a readable, persuasive sentence.\n"
            "  Example: 'Wall-mounted magnetic shower gel bracket for hotels and spas. Durable ABS construction, single/double/triple options. OEM customization available.'\n"
            "- If user provided core SEO keywords, weave them naturally into the description.\n"
        ),
    }

    wc_images = _parse_image_refs(item.get("image_urls"))
    short_images = _parse_image_refs(item.get("short_ref_images")) or wc_images[:3]
    full_images = _parse_image_refs(item.get("full_ref_images")) or wc_images[:6]
    reference_images: list[str] = []
    if field == "short_description":
        reference_images = short_images[:4]
    elif field == "description":
        reference_images = full_images[:16]  # Allow more images for richer AI context
    else:
        reference_images = (short_images + full_images + wc_images)[:4]

    template_block = ""
    if short_template:
        template_block += f"""
Short Description Template Guidance:
\"\"\"
{short_template}
\"\"\"
"""
    if full_template:
        template_block += f"""
Full Description Template Guidance:
\"\"\"
{full_template}
\"\"\"
"""

    seed_keyword = _strip_html(item.get("name") or "")
    category_names = _strip_html(item.get("category_names") or "")
    if category_names:
        seed_keyword = f"{seed_keyword} {category_names.split(',')[0].strip()}"
    long_tail = _discover_long_tail_keywords(seed_keyword, language=language, limit=12)
    keyword_block = ""
    if long_tail:
        keyword_lines = "\n".join([f"- {kw}" for kw in long_tail])
        keyword_block = f"""
Search-derived long-tail keyword candidates:
{keyword_lines}

Keyword usage rules:
- Use naturally and semantically; no stuffing.
- short_description: use 1-2 keyword phrases when natural.
- description: use 2-4 keyword phrases when natural.
- aioseo_title/aioseo_description: prefer one strong long-tail phrase if it fits.
"""

    # User-specified core SEO keywords
    seo_keywords = (seo_keywords or "").strip()
    user_keywords_block = ""
    if seo_keywords and field in ("aioseo_title", "aioseo_description", "acf_seo_extra_info", "short_description", "description"):
        user_keywords_block = f"""
User-specified core SEO keywords (MUST incorporate into the output):
{seo_keywords}

These are the primary target keywords provided by the user. You MUST naturally include
at least one of these keywords in the generated content. For aioseo_title, try to place
the most important keyword near the beginning. For aioseo_description, weave the keywords
naturally into the text.
"""

    image_block = ""
    if reference_images:
        image_block = (
            f"Reference images are attached ({len(reference_images)} image(s)). "
            "Extract visible product facts from images and keep claims factual."
        )

    catalog_text = str(item.get("catalog_text") or "").strip()
    catalog_block = ""
    if catalog_text:
        catalog_block = f"""
Product Catalog Reference Text (provided by user from product brochure/catalog):
\"\"\"
{catalog_text}
\"\"\"
Use the facts, specs, and descriptions from this catalog text as primary reference material.
"""

    if field == "description":
        html, alt_texts = _generate_docx_style_description_html(
            api_key=api_key,
            item=item,
            language=language,
            short_template=short_template,
            full_template=full_template,
            long_tail=long_tail,
            reference_images=reference_images,
            html_images=html_images,
            seo_keywords=seo_keywords,
        )
        return html, alt_texts

    prompt = f"""You are an expert WooCommerce SEO copywriter.
Language: {language}
Product Name: {item.get('name', '')}

Existing Short Description:
\"\"\"
{short_desc}
\"\"\"

Existing Full Description:
\"\"\"
{full_desc}
\"\"\"

Current Value of Target Field ({field}):
\"\"\"
{current_value}
\"\"\"

{template_block}
{catalog_block}
{keyword_block}
{user_keywords_block}

Task:
{field_rules[field]}
{image_block}

Output requirements:
- Return ONLY the final content for this single field.
- No JSON, no markdown code fences, no explanations.
- For acf_seo_extra_info: plain text only, no HTML tags, no bullet points, no CTA.
- Do NOT copy unrelated industry wording. Adapt style only, based on this product's actual facts.

{ACF_CARD_STYLE_GUIDE if field == "acf_seo_extra_info" else ""}
"""

    text = _gemini_generate_text(
        api_key,
        prompt,
        "gemini-2.0-flash",
        image_sources=reference_images,
    )

    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()

    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = json.loads(text)
            text = str(parsed.get("value") or parsed.get(field) or "").strip()
        except Exception:
            pass

    if field == "short_description":
        fallback = short_desc or _truncate_words(_strip_html(full_desc), 60) or str(item.get("name", ""))
        text = _ensure_html(text, fallback)
    elif field == "description":
        fallback = full_desc or short_desc or str(item.get("name", ""))
        text = _ensure_html(text, fallback)
    elif field == "acf_seo_extra_info":
        fallback = _strip_html(f"{short_desc} {full_desc}") or str(item.get("name", ""))
        text = _normalize_acf_card_text(text, fallback, str(item.get("name", "")))
    elif field == "aioseo_title":
        text = _truncate(_strip_html(text) or str(item.get("name", "")), 60)
    elif field == "aioseo_description":
        fallback = _strip_html(short_desc) or _strip_html(full_desc) or str(item.get("name", ""))
        text = _truncate(_strip_html(text) or fallback, 160)

    return text


def _build_product_metadata_payload(item: dict[str, Any]) -> dict[str, Any]:
    acf_value = item.get("acf_seo_extra_info") or ""
    return {
        "short_description": item.get("short_description") or "",
        "description": item.get("description") or "",
        "meta_data": [
            {"key": "short_description", "value": acf_value},
            {"key": "product_extra_info——seo", "value": acf_value},
            {"key": "_aioseo_title", "value": item.get("aioseo_title") or ""},
            {"key": "_aioseo_description", "value": item.get("aioseo_description") or ""},
        ],
    }


class AltTextsPayload(BaseModel):
    alt_texts: dict[str, str] = {}


@app.post("/products/{product_id}/alt-texts")
def update_product_alt_texts(product_id: int, payload: AltTextsPayload):
    """Save edited alt texts and re-render description HTML with updated alt texts."""
    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    _ensure_product_category_columns()

    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute(
                "SELECT id, name, description, description_alt_texts, image_urls, full_ref_images FROM product_items WHERE id = ?",
                (product_id,),
            )
            row = c.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Product not found")
            item = dict(row)

            # Merge existing alt_texts with edits
            existing = {}
            raw_existing = item.get("description_alt_texts") or ""
            if raw_existing:
                try:
                    existing = json.loads(raw_existing)
                except Exception:
                    pass
            merged_alt_texts = {**existing, **payload.alt_texts}

            # Re-render description HTML with new alt texts
            desc_html = item.get("description") or ""
            if f"<!-- {DOCX_RENDER_VERSION}" in desc_html or "<!-- DOCX_STYLE_TEMPLATE" in desc_html:
                product_name = item.get("name") or "Product"
                for section_key, new_alt_val in payload.alt_texts.items():
                    heading = ALT_TEXT_SECTION_HEADINGS.get(section_key, "")
                    if heading:
                        old_alt = f"{product_name} - {heading}"
                        old_alt_escaped = escape(old_alt, quote=True)
                        new_alt_escaped = escape(new_alt_val, quote=True)
                        desc_html = desc_html.replace(f'alt="{old_alt_escaped}"', f'alt="{new_alt_escaped}"')
                    # Also replace if it was previously a custom alt text
                    old_custom = existing.get(section_key, "")
                    if old_custom and old_custom != new_alt_val:
                        old_custom_escaped = escape(old_custom, quote=True)
                        new_alt_escaped = escape(new_alt_val, quote=True)
                        desc_html = desc_html.replace(f'alt="{old_custom_escaped}"', f'alt="{new_alt_escaped}"')

            alt_texts_json = json.dumps(merged_alt_texts, ensure_ascii=False)
            c.execute(
                "UPDATE product_items SET description = ?, description_alt_texts = ?, updated_at = datetime('now') WHERE id = ?",
                (desc_html, alt_texts_json, product_id),
            )
            conn.commit()

            return {"ok": True, "alt_texts": merged_alt_texts}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Mapping from block key to section heading (for alt text replacement)
ALT_TEXT_SECTION_HEADINGS = {
    "design_concept": "Design Concept",
    "materials_craftsmanship": "Materials & Craftsmanship",
    "functionality_user_experience": "Functionality & User Experience",
    "installation_options": "Installation Options",
    "applications": "Applications",
    "technical_specifications": "Technical Specifications",
    "about_manufacturer": "About the Manufacturer",
}


@app.post("/products/{product_id}/ref-images")
async def upload_product_ref_images(
    product_id: int,
    files: List[UploadFile] = File(...),
    category: str = Form("product"),
):
    """Upload reference images for a product (product images, detail page screenshots, etc.)."""
    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    _ensure_product_category_columns()

    img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
    img_dir.mkdir(parents=True, exist_ok=True)

    saved = []
    import time
    base_ts = int(time.time() * 1000)
    for idx, f in enumerate(files):
        data = await f.read()
        if not data:
            continue
        ext = Path(f.filename or "image.png").suffix or ".png"
        # Use category prefix + timestamp + index to avoid collisions
        fname = f"{category}_{base_ts + idx}{ext}"
        fpath = img_dir / fname
        fpath.write_bytes(data)
        saved.append({"filename": fname, "category": category, "size": len(data)})

    return {"ok": True, "uploaded": len(saved), "files": saved}


@app.get("/products/{product_id}/ref-images")
def list_product_ref_images(product_id: int):
    """List all reference images for a product."""
    img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
    if not img_dir.exists():
        return {"images": []}
    images = []
    for f in sorted(img_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
            images.append({
                "filename": f.name,
                "category": f.name.split("_")[0] if "_" in f.name else "product",
                "size": f.stat().st_size,
                "url": f"/products/{product_id}/ref-images/{f.name}",
            })
    return {"images": images}


@app.get("/products/{product_id}/generation-history")
def get_generation_history(product_id: int, field: str = "", limit: int = 20):
    """Get generation history for a product, optionally filtered by field."""
    _ensure_generation_history_table()
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            if field:
                c.execute(
                    "SELECT id, product_id, field, value, created_at FROM generation_history "
                    "WHERE product_id = ? AND field = ? ORDER BY id DESC LIMIT ?",
                    (product_id, field, limit),
                )
            else:
                c.execute(
                    "SELECT id, product_id, field, value, created_at FROM generation_history "
                    "WHERE product_id = ? ORDER BY id DESC LIMIT ?",
                    (product_id, limit),
                )
            rows = [dict(r) for r in c.fetchall()]
            return {"history": rows}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/products/{product_id}/ref-images/{filename}")
def serve_product_ref_image(product_id: int, filename: str):
    """Serve a product reference image."""
    img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
    fpath = img_dir / filename
    if not fpath.exists() or not fpath.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    ct = mimetypes.guess_type(fpath.name)[0] or "image/png"
    return Response(content=fpath.read_bytes(), media_type=ct)


@app.delete("/products/{product_id}/ref-images/{filename}")
def delete_product_ref_image(product_id: int, filename: str):
    """Delete a product reference image."""
    img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
    fpath = img_dir / filename
    if fpath.exists() and fpath.is_file():
        fpath.unlink()
    return {"ok": True}


@app.post("/products/{product_id}/generate-field")
def generate_product_field(product_id: int, payload: ProductGenerateFieldPayload):
    field = (payload.field or "").strip()
    if field not in PRODUCT_AI_FIELDS:
        raise HTTPException(status_code=400, detail=f"Invalid field: {field}")

    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    _ensure_product_category_columns()

    api_key = _get_gemini_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API key in settings")

    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute(
                """
                SELECT id, name, short_description, description,
                       acf_seo_extra_info, aioseo_title, aioseo_description,
                       category_names, image_urls, short_ref_images, full_ref_images
                FROM product_items
                WHERE id = ?
                """,
                (product_id,),
            )
            row = c.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Product not found")
            item = dict(row)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    try:
        base_item = {
            **item,
            "short_description": (payload.short_description or item.get("short_description") or "").strip(),
            "description": (payload.description or item.get("description") or "").strip(),
            "short_ref_images": (payload.short_ref_images or item.get("short_ref_images") or "").strip(),
            "full_ref_images": (payload.full_ref_images or item.get("full_ref_images") or "").strip(),
        }

        # Auto-upload user-uploaded ref images to WordPress and use their WP URLs
        # for <img src> in the description HTML.
        html_images: list[str] | None = None
        if field == "description":
            product_name = str(item.get("name") or "").strip()
            wp_ref_urls = _ensure_ref_images_uploaded_to_wp(product_id, product_name)
            print(f"[generate-field] product_id={product_id}, wp_ref_urls={wp_ref_urls}")
            print(f"[generate-field] catalog_text present: {bool((item.get('catalog_text') or '').strip())}")
            if wp_ref_urls:
                html_images = wp_ref_urls

            # Always feed ALL local image paths (product + catalog) to Gemini for AI context
            img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
            image_exts = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
            local_paths = [
                str(fp) for fp in sorted(img_dir.iterdir())
                if fp.is_file() and fp.suffix.lower() in image_exts
            ] if img_dir.exists() else []
            if local_paths:
                existing = _parse_image_refs(base_item.get("full_ref_images"))
                merged = list(dict.fromkeys(local_paths + existing))
                base_item["full_ref_images"] = ",".join(merged)
                print(f"[generate-field] feeding {len(local_paths)} local images to Gemini")

        result = _generate_single_product_field_value(
            api_key=api_key,
            item=base_item,
            field=field,
            language=payload.language or "en",
            short_template=payload.short_template or "",
            full_template=payload.full_template or "",
            current_value=(payload.current_value or item.get(field) or "").strip(),
            seo_keywords=payload.seo_keywords or "",
            html_images=html_images,
        )
        if isinstance(result, tuple):
            text, alt_texts = result
        else:
            text, alt_texts = result, {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gemini generate failed: {e}")

    # Save generation history
    _save_generation_history(product_id, field, text)

    resp: dict[str, Any] = {
        "ok": True,
        "field": field,
        "value": text,
        "docx_render_version": DOCX_RENDER_VERSION if field == "description" else "",
    }
    if alt_texts:
        resp["alt_texts"] = alt_texts
    return resp


@app.post("/products/generate-batch")
def generate_product_fields_batch(payload: ProductBatchGeneratePayload):
    """Generate selected AI SEO fields for selected products and store in local DB."""
    ids = [int(i) for i in payload.ids if int(i) > 0]
    fields = [str(f).strip() for f in payload.fields if str(f).strip()]

    if not ids:
        raise HTTPException(status_code=400, detail="No valid product IDs provided")
    if not fields:
        raise HTTPException(status_code=400, detail="No fields selected")

    invalid = [f for f in fields if f not in PRODUCT_AI_FIELDS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Invalid fields: {', '.join(invalid)}")

    if not DB_PATH.exists():
        raise HTTPException(status_code=404, detail="Database not found")
    _ensure_product_category_columns()

    api_key = _get_gemini_api_key()
    if not api_key:
        raise HTTPException(status_code=400, detail="Missing Gemini API key in settings")

    placeholders = ",".join(["?"] * len(ids))
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute(
                f"""
                SELECT id, name, short_description, description,
                       acf_seo_extra_info, aioseo_title, aioseo_description,
                       category_names, image_urls, short_ref_images, full_ref_images
                FROM product_items
                WHERE id IN ({placeholders})
                ORDER BY id ASC
                """,
                ids,
            )
            items = [dict(r) for r in c.fetchall()]
            if not items:
                raise HTTPException(status_code=404, detail="No matching products found")

            updated_products = 0
            generated_fields = 0
            failed: list[dict[str, Any]] = []

            for item in items:
                product_id = int(item["id"])
                updates: dict[str, str] = {}

                # Auto-upload ref images for description field
                batch_html_images: list[str] | None = None
                if "description" in fields:
                    pname = str(item.get("name") or "").strip()
                    wp_ref_urls = _ensure_ref_images_uploaded_to_wp(product_id, pname)
                    if wp_ref_urls:
                        batch_html_images = wp_ref_urls

                    # Always feed ALL local image paths to Gemini for AI context
                    img_dir = Path(DB_PATH).parent / "product_ref_images" / str(product_id)
                    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
                    local_paths = [
                        str(fp) for fp in sorted(img_dir.iterdir())
                        if fp.is_file() and fp.suffix.lower() in image_exts
                    ] if img_dir.exists() else []
                    if local_paths:
                        existing = _parse_image_refs(item.get("full_ref_images"))
                        merged = list(dict.fromkeys(local_paths + existing))
                        item["full_ref_images"] = ",".join(merged)

                for field in fields:
                    try:
                        result = _generate_single_product_field_value(
                            api_key=api_key,
                            item={**item, **updates},
                            field=field,
                            language=payload.language or "en",
                            short_template=payload.short_template or "",
                            full_template=payload.full_template or "",
                            html_images=batch_html_images if field == "description" else None,
                        )
                        if isinstance(result, tuple):
                            value, alt_texts = result
                            if alt_texts:
                                updates["description_alt_texts"] = json.dumps(alt_texts, ensure_ascii=False)
                        else:
                            value = result
                        updates[field] = value
                        _save_generation_history(product_id, field, value)
                        generated_fields += 1
                    except Exception as e:
                        failed.append(
                            {
                                "product_id": product_id,
                                "name": item.get("name", ""),
                                "field": field,
                                "error": str(e),
                            }
                        )

                if updates:
                    set_sql = ", ".join([f"{k}=?" for k in updates.keys()])
                    values = list(updates.values()) + [product_id]
                    c.execute(
                        f"""
                        UPDATE product_items
                        SET {set_sql},
                            status = 'generated',
                            error_reason = NULL,
                            updated_at = datetime('now')
                        WHERE id = ?
                        """,
                        values,
                    )
                    updated_products += 1
            conn.commit()

            return {
                "ok": True,
                "requested": len(ids),
                "found": len(items),
                "updated_products": updated_products,
                "generated_fields": generated_fields,
                "failed": len(failed),
                "errors": failed[:20],
            }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/product-run")
def product_run(payload: ProductRunPayload):
    """Run AI product SEO generation via Node CLI."""
    template_text = (payload.template or "").strip()
    if not template_text and PRODUCT_TEMPLATE_FILE.exists():
        template_text = PRODUCT_TEMPLATE_FILE.read_text(encoding="utf-8").strip()
    if not template_text:
        raise HTTPException(
            status_code=400,
            detail="Template is required. Save a default template first.",
        )

    # CLI expects --template to be a file path, so write effective template text
    template_dir = Path("data")
    template_dir.mkdir(parents=True, exist_ok=True)
    template_file = template_dir / "product_template_runtime.txt"
    template_file.write_text(template_text, encoding="utf-8")

    args = ["node", "--import", "tsx", "src/cli.ts", "product-run",
            "--template", str(template_file.resolve())]
    if payload.language:
        args.extend(["--language", payload.language])
    if payload.limit > 0:
        args.extend(["--limit", str(payload.limit)])
    if payload.force:
        args.append("--force")
    if payload.skipScan:
        args.append("--skip-scan")
    if payload.ids:
        args.extend(["--ids", ",".join(map(str, payload.ids))])

    start_task("product-run", args, _build_product_task_env())
    return {"ok": True, "message": "Product SEO generation started"}


@app.get("/product-review")
def product_review(status: str = "pending", limit: int = 50):
    """List generated product SEO pending review."""
    if not DB_PATH.exists():
        return []
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            c.execute("""
                SELECT gs.id, gs.product_id, gs.short_description, gs.description,
                       gs.acf_seo_extra_info, gs.aioseo_title, gs.aioseo_description,
                       gs.generator, gs.review_status,
                       p.name as product_name, p.permalink as product_permalink
                FROM generated_product_seo gs
                JOIN product_items p ON p.id = gs.product_id
                WHERE gs.review_status = ?
                ORDER BY gs.id DESC
                LIMIT ?
            """, (status, limit))
            return [dict(row) for row in c.fetchall()]
    except Exception:
        return []


class ProductReviewBatchPayload(BaseModel):
    ids: list[int] = []
    status: str = "approved"


@app.post("/product-review")
def product_review_batch(payload: ProductReviewBatchPayload):
    """Batch approve/apply product SEO results."""
    if not payload.ids or not DB_PATH.exists():
        return {"ok": False, "detail": "No IDs or DB not found"}
    try:
        with get_db_connection() as conn:
            c = conn.cursor()
            placeholders = ",".join(["?"] * len(payload.ids))

            if payload.status == "applied":
                # Fetch generated data and sync to WP
                c.execute(f"""
                    SELECT gs.*, p.name as product_name
                    FROM generated_product_seo gs
                    JOIN product_items p ON p.id = gs.product_id
                    WHERE gs.id IN ({placeholders})
                """, payload.ids)
                rows = [dict(r) for r in c.fetchall()]

                # Update review status
                c.execute(
                    f"UPDATE generated_product_seo SET review_status = 'applied' WHERE id IN ({placeholders})",
                    payload.ids
                )
                conn.commit()

                applied_count = 0
                failed: list[dict[str, Any]] = []
                for r in rows:
                    product_id = int(r["product_id"])
                    try:
                        _sync_product_metadata_to_wp(product_id, _build_product_metadata_payload(r))
                        # Sync AIOSEO fields via custom plugin endpoint (wp_aioseo_posts table)
                        try:
                            _sync_aioseo_fields_to_wp(
                                product_id, dict(r), ["aioseo_title", "aioseo_description"]
                            )
                        except Exception as aioseo_err:
                            print(f"[WARN] AIOSEO sync failed for product {product_id}: {aioseo_err}")
                        c.execute(
                            """
                            UPDATE product_items
                            SET status = 'updated',
                                error_reason = NULL,
                                updated_at = datetime('now')
                            WHERE id = ?
                            """,
                            (product_id,),
                        )
                        applied_count += 1
                    except Exception as sync_err:
                        msg = str(sync_err)
                        c.execute(
                            """
                            UPDATE product_items
                            SET status = 'error',
                                error_reason = ?,
                                updated_at = datetime('now')
                            WHERE id = ?
                            """,
                            (msg[:500], product_id),
                        )
                        failed.append(
                            {
                                "product_id": product_id,
                                "product_name": r.get("product_name", ""),
                                "error": msg,
                            }
                        )
                conn.commit()

                return {
                    "ok": True,
                    "applied": applied_count,
                    "failed": len(failed),
                    "errors": failed[:10],
                }
            else:
                c.execute(
                    f"UPDATE generated_product_seo SET review_status = ? WHERE id IN ({placeholders})",
                    [payload.status] + payload.ids
                )
                conn.commit()
                return {"ok": True, "updated": len(payload.ids)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
