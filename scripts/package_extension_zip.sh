#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOWNLOADS_DIR="${PROJECT_ROOT}/public/downloads"
MANIFEST_TEMPLATE="${PROJECT_ROOT}/deploy/release-manifest.json"
MANIFEST_OUTPUT="${DOWNLOADS_DIR}/release-manifest.json"
EXTENSION_RELEASE_DIR="${PROJECT_ROOT}/extension/release"

mkdir -p "${DOWNLOADS_DIR}"

export PROJECT_ROOT EXTENSION_RELEASE_DIR MANIFEST_TEMPLATE MANIFEST_OUTPUT DOWNLOADS_DIR

python3 - <<'PY'
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
import zipfile

project_root = Path(os.environ["PROJECT_ROOT"])
release_dir = Path(os.environ["EXTENSION_RELEASE_DIR"])
manifest_template = Path(os.environ["MANIFEST_TEMPLATE"])
manifest_output = Path(os.environ["MANIFEST_OUTPUT"])
downloads_dir = Path(os.environ["DOWNLOADS_DIR"])

manifest = json.loads(manifest_template.read_text(encoding="utf-8"))
release_version = str(os.getenv("EXTENSION_RELEASE_VERSION") or manifest.get("latestVersion") or "0.1.0").strip()
release_id = str(os.getenv("EXTENSION_RELEASE_ID") or "").strip()
build_marker = str(os.getenv("EXTENSION_BUILD_MARKER") or "").strip()
preferred_env = os.getenv("PACKAGE_EXTENSION_SOURCE", "").strip()

if preferred_env:
    source_zip = Path(preferred_env)
else:
    expected_name = f"crx-xhs-marketing-extension-{release_version}-{release_id}.zip" if release_id else ""
    expected_path = release_dir / expected_name if expected_name else None
    if expected_path and expected_path.exists():
        source_zip = expected_path
    else:
        release_candidates = sorted(
            [candidate for candidate in release_dir.glob("*.zip") if candidate.is_file()],
            key=lambda candidate: candidate.stat().st_mtime,
            reverse=True,
        )
        if not release_candidates:
            raise SystemExit(
                "[package-extension] 未找到当前构建插件包。请先完成 extension 构建，"
                "或显式设置 PACKAGE_EXTENSION_SOURCE 指向本次构建产物。"
            )
        source_zip = release_candidates[0]

if not source_zip.exists() or not source_zip.is_file():
    raise SystemExit(f"[package-extension] 指定的插件包不存在: {source_zip}")

if not release_id:
    matched = re.match(r"crx-xhs-marketing-extension-[^-]+-(.+)\.zip$", source_zip.name)
    if matched:
        release_id = matched.group(1).strip()

if not build_marker:
    with zipfile.ZipFile(source_zip) as zip_file:
        main_candidates = [name for name in zip_file.namelist() if "/main.ts-" in name or name.startswith("assets/main.ts-")]
        if main_candidates:
            main_bundle = zip_file.read(main_candidates[0]).decode("utf-8", errors="ignore")
            matched = re.search(r'buildMarker:"([^"]+)"', main_bundle)
            if matched:
                build_marker = matched.group(1).strip()

zip_output_name = source_zip.name
zip_output = downloads_dir / zip_output_name
if source_zip.resolve() != zip_output.resolve():
    shutil.copyfile(source_zip, zip_output)

manifest["latestVersion"] = release_version
manifest["minSupportedVersion"] = str(
    manifest.get("minSupportedVersion")
    or "0.1.0"
).strip()
manifest["downloadUrl"] = f"/downloads/{zip_output.name}"
manifest["notes"] = (
    f"浏览器插件安装包发布完成。版本: {release_version} | "
    f"releaseId: {release_id or 'unknown'} | 源文件: {source_zip.name}"
)
manifest["publishedAt"] = datetime.now(timezone.utc).isoformat()
manifest["releaseId"] = release_id or None
manifest["buildMarker"] = build_marker or None
manifest_output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

print(f"[package-extension] copied {source_zip} -> {zip_output}")
print(f"[package-extension] wrote {manifest_output}")
PY
