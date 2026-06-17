import ipaddress
import re
from typing import Iterable, List, Optional
from urllib.parse import urlparse


DEFAULT_PUBLIC_IMAGE_HOSTS = [
    "xhscdn.com",
    "xiaohongshu.com",
]


def normalize_remote_public_url(raw_url: str) -> str:
    normalized = str(raw_url or "").split("#", 1)[0].strip()
    if not normalized:
        return ""
    if normalized.startswith("//"):
        normalized = f"https:{normalized}"
    elif normalized.startswith("http://"):
        normalized = normalized.replace("http://", "https://", 1)
    return normalized


def _normalized_allowed_hosts(allowed_hosts: Optional[Iterable[str]]) -> List[str]:
    values = [
        str(item).strip().lower()
        for item in (allowed_hosts or DEFAULT_PUBLIC_IMAGE_HOSTS)
        if str(item).strip()
    ]
    return values or list(DEFAULT_PUBLIC_IMAGE_HOSTS)


def is_safe_public_url(url: str, *, allowed_hosts: Optional[Iterable[str]] = None) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return False

        hostname = (parsed.hostname or "").strip().lower()
        if not hostname:
            return False
        if hostname in {"localhost", "0.0.0.0"} or hostname.endswith(".local"):
            return False

        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        except ValueError:
            if re.match(r"^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)", hostname):
                return False

        normalized_allowed_hosts = _normalized_allowed_hosts(allowed_hosts)
        return any(hostname == allowed or hostname.endswith(f".{allowed}") for allowed in normalized_allowed_hosts)
    except Exception:
        return False
