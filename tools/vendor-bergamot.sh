#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Replaces app/vendor/bergamot/ with the translation engine of Firefox Translations, as the Bergamot project publishes
# it in the @browsermt/bergamot-translator package of a pinned version, checked against its SHA-256: the page side, the
# worker and its WebAssembly. The package carries no license text, so the MPL-2.0 text comes from the repository at a
# pinned commit. The version is only ever moved by hand, after testing.
set -euo pipefail

readonly BERGAMOT_VERSION=0.4.9
readonly BERGAMOT_SHA256=9011be93222d839d7448ffdf00549d53ce8f541fd782ffc79779d1756397c41f
readonly ARCHIVE_URL="https://registry.npmjs.org/@browsermt/bergamot-translator/-/bergamot-translator-${BERGAMOT_VERSION}.tgz"
readonly LICENSE_URL="https://raw.githubusercontent.com/browsermt/bergamot-translator/9271618ebbdc5d21ac4dc4df9e72beb7ce644774/LICENSE"
readonly KEPT_FILES=(
  translator.js
  worker/translator-worker.js
  worker/bergamot-translator-worker.js
  worker/bergamot-translator-worker.wasm
)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${repo_root}/app/vendor/bergamot"

download_dir="$(mktemp -d)"
trap 'rm -rf "${download_dir}"' EXIT

curl --fail --silent --show-error --location "${ARCHIVE_URL}" --output "${download_dir}/bergamot.tgz"
found="$(sha256sum "${download_dir}/bergamot.tgz" | cut -d' ' -f1)"
if [[ "${found}" != "${BERGAMOT_SHA256}" ]]; then
  echo "bergamot-translator ${BERGAMOT_VERSION}: SHA-256 ${found}, expected ${BERGAMOT_SHA256}" >&2
  exit 1
fi
tar -xzf "${download_dir}/bergamot.tgz" -C "${download_dir}"
curl --fail --silent --show-error --location "${LICENSE_URL}" --output "${download_dir}/LICENSE"
if ! grep -q 'Mozilla Public License Version 2.0' "${download_dir}/LICENSE"; then
  echo "bergamot-translator: the license text is not the MPL-2.0" >&2
  exit 1
fi

# Check every file before removing anything, so a failed run keeps the old copy.
for file in "${KEPT_FILES[@]}"; do
  if [[ ! -f "${download_dir}/package/${file}" ]]; then
    echo "bergamot-translator ${BERGAMOT_VERSION} has no ${file}" >&2
    exit 1
  fi
done

rm -rf "${target}"
for file in "${KEPT_FILES[@]}"; do
  mkdir -p "$(dirname "${target}/${file}")"
  cp "${download_dir}/package/${file}" "${target}/${file}"
done
cp "${download_dir}/LICENSE" "${target}/LICENSE"

echo "app/vendor/bergamot now holds bergamot-translator ${BERGAMOT_VERSION}"
