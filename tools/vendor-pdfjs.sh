#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Replaces app/vendor/pdfjs/ with the files MochiReader uses from pdf.js: the library and its worker, as Mozilla
# publishes them in the pdfjs-dist package of a pinned version, checked against its SHA-256. The version is only ever
# moved by hand, after testing, together with the pdfjs-dist version in package.json that the tests read PDFs with.
set -euo pipefail

readonly PDFJS_VERSION=5.7.284
readonly PDFJS_SHA256=f14db72530dec74fe666910e246242b9bb698df30f0e06622c4471b340a0413d
readonly ARCHIVE_URL="https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${PDFJS_VERSION}.tgz"
# Only what reading the text and drawing a figure need: no viewer, no CMaps, no standard fonts, no WebAssembly.
readonly KEPT_FILES=(
  build/pdf.min.mjs
  build/pdf.worker.min.mjs
  LICENSE
)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${repo_root}/app/vendor/pdfjs"

download_dir="$(mktemp -d)"
trap 'rm -rf "${download_dir}"' EXIT

curl --fail --silent --show-error --location "${ARCHIVE_URL}" --output "${download_dir}/pdfjs.tgz"
found="$(sha256sum "${download_dir}/pdfjs.tgz" | cut -d' ' -f1)"
if [[ "${found}" != "${PDFJS_SHA256}" ]]; then
  echo "pdfjs-dist ${PDFJS_VERSION}: SHA-256 ${found}, expected ${PDFJS_SHA256}" >&2
  exit 1
fi
tar -xzf "${download_dir}/pdfjs.tgz" -C "${download_dir}"

# Check every file before removing anything, so a failed run keeps the old copy.
for file in "${KEPT_FILES[@]}"; do
  if [[ ! -f "${download_dir}/package/${file}" ]]; then
    echo "pdfjs-dist ${PDFJS_VERSION} has no ${file}" >&2
    exit 1
  fi
done

rm -rf "${target}"
mkdir -p "${target}"
for file in "${KEPT_FILES[@]}"; do
  cp "${download_dir}/package/${file}" "${target}/$(basename "${file}")"
done

echo "app/vendor/pdfjs now holds pdf.js ${PDFJS_VERSION}"
