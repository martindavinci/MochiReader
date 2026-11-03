#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Replaces app/vendor/foliate/ with the files MochiReader uses from foliate-js
# at a pinned commit. The foliate-js README warns that its API can change at any
# time, so the commit is only ever moved by hand, after testing.
set -euo pipefail

readonly FOLIATE_COMMIT=78914aef4466eb960965702401634c2cb348e9b1
readonly ARCHIVE_URL="https://codeload.github.com/johnfactotum/foliate-js/tar.gz/${FOLIATE_COMMIT}"
readonly KEPT_FILES=(
  view.js
  epub.js
  epubcfi.js
  paginator.js
  fixed-layout.js
  overlayer.js
  progress.js
  text-walker.js
  vendor/zip.js
  vendor/fflate.js
  LICENSE
)
# foliate lets a section run scripts only for a WebKit bug, and this app only runs on WebView2. A CSP with 'self' is not
# enough: a book could still name a script of the app, which would run in its frame next to the Tauri IPC.
readonly SANDBOXED_FILES=(paginator.js fixed-layout.js)
readonly FOLIATE_SANDBOX='allow-same-origin allow-scripts'
# foliate-js ships zip.js and fflate minified and without their license texts.
readonly ZIP_JS_LICENSE_URL="https://raw.githubusercontent.com/gildas-lormeau/zip.js/841affffeaa2bd840f3cb26686142c7eb8ee7cbf/LICENSE"
readonly FFLATE_LICENSE_URL="https://raw.githubusercontent.com/101arrowz/fflate/dcb3714a6c25db3a2748641019c5277413d09714/LICENSE"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${repo_root}/app/vendor/foliate"
licenses="${repo_root}/tools/vendored-licenses"

fetch() {
  curl --fail --silent --show-error --location "$@"
}

download_dir="$(mktemp -d)"
trap 'rm -rf "${download_dir}"' EXIT

fetch "${ARCHIVE_URL}" | tar -xzf - -C "${download_dir}"
source_dir="${download_dir}/foliate-js-${FOLIATE_COMMIT}"
fetch "${ZIP_JS_LICENSE_URL}" --output "${download_dir}/zip.js-LICENSE"
fetch "${FFLATE_LICENSE_URL}" --output "${download_dir}/fflate-LICENSE"

# Check every file before removing anything, so a failed run keeps the old copy.
for file in "${KEPT_FILES[@]}"; do
  if [[ ! -f "${source_dir}/${file}" ]]; then
    echo "foliate-js ${FOLIATE_COMMIT} has no ${file}" >&2
    exit 1
  fi
done

for file in "${SANDBOXED_FILES[@]}"; do
  if ! grep -q "'${FOLIATE_SANDBOX}'" "${source_dir}/${file}"; then
    echo "foliate-js ${FOLIATE_COMMIT} has no sandbox to close in ${file}" >&2
    exit 1
  fi
  sed -i -e '/`allow-scripts` is needed for events because of WebKit bug/,+1d' \
    -e "s/'${FOLIATE_SANDBOX}'/'allow-same-origin'/" "${source_dir}/${file}"
done

rm -rf "${target}"
for file in "${KEPT_FILES[@]}"; do
  mkdir -p "$(dirname "${target}/${file}")"
  cp "${source_dir}/${file}" "${target}/${file}"
done
mkdir -p "${licenses}"
cp "${download_dir}/zip.js-LICENSE" "${download_dir}/fflate-LICENSE" "${licenses}/"

echo "app/vendor/foliate now holds foliate-js ${FOLIATE_COMMIT}"
