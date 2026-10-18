#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
build_dir="$repo/build/java"
classes_dir="$build_dir/classes"
mkdir -p "$classes_dir"
find "$repo/java" -type f -name '*.java' -print > "$build_dir/sources.list"
javac -Xlint:all -Werror -d "$classes_dir" @"$build_dir/sources.list"
jar --create --file "$build_dir/gcd-java-tools.jar" -C "$classes_dir" .
printf 'Built %s\n' "$build_dir/gcd-java-tools.jar"
