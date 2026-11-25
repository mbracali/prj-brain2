#!/usr/bin/env bash
# macOS: double-click in Finder to launch the latest BRAIN2 from this folder.
exec "$(cd "$(dirname "$0")" && pwd)/brain2.sh" --detach
