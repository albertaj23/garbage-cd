# shellcheck shell=bash
# Sourced by setup.sh and start.sh. Finds the toolchains V2 needs and exports PATH/JAVA_HOME so
# the right ones are used even when the system defaults are different (for example JDK 25 or Node 25).
# Plain bash 3.2 compatible (macOS).

gcd_major() { # prints the major version number found in "$1"
  printf '%s' "$1" | sed -n 's/^[^0-9]*\([0-9][0-9]*\).*/\1/p' | head -n 1
}

gcd_find_node22() {
  local candidate
  for candidate in \
    "$(command -v node 2>/dev/null)" \
    /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node \
    "$HOME"/.nvm/versions/node/v22*/bin/node "$HOME"/.volta/tools/image/node/22*/bin/node \
    /usr/local/bin/node /usr/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    local version
    version=$("$candidate" --version 2>/dev/null) || continue
    [ "$(gcd_major "$version")" = "22" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

gcd_find_jdk21() { # prints a JAVA_HOME containing java and javac 21
  local home
  for home in \
    "${JAVA_HOME:-}" "$HOME/.jdk/temurin-21" \
    /usr/lib/jvm/*21* /usr/lib/jvm/*-21-* \
    /Library/Java/JavaVirtualMachines/*21*/Contents/Home \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home /opt/homebrew/opt/openjdk@21 \
    "$(dirname "$(dirname "$(command -v javac 2>/dev/null || true)")")"; do
    [ -n "$home" ] && [ -x "$home/bin/javac" ] && [ -x "$home/bin/java" ] || continue
    local version
    version=$("$home/bin/javac" -version 2>&1 | head -n 1)
    [ "$(gcd_major "$version")" = "21" ] && { printf '%s' "$home"; return 0; }
  done
  return 1
}

gcd_cmake_ok() { # CMake >= 3.15
  command -v cmake >/dev/null 2>&1 || return 1
  local version major minor
  version=$(cmake --version | head -n 1 | sed -n 's/^cmake version \([0-9.]*\).*/\1/p')
  major=${version%%.*}; minor=${version#*.}; minor=${minor%%.*}
  [ "${major:-0}" -gt 3 ] || { [ "${major:-0}" -eq 3 ] && [ "${minor:-0}" -ge 15 ]; }
}

gcd_cxx_ok() { # a compiler that accepts -std=c++17
  local cxx=${CXX:-c++} dir
  command -v "$cxx" >/dev/null 2>&1 || return 1
  dir=$(mktemp -d)
  printf '#include <optional>\nint main(){ std::optional<int> x = 1; return *x - 1; }\n' > "$dir/t.cpp"
  "$cxx" -std=c++17 "$dir/t.cpp" -o "$dir/t" >/dev/null 2>&1 && "$dir/t"
  local status=$?
  rm -rf "$dir"
  return $status
}
