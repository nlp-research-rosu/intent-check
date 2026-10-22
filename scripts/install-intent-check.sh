#!/bin/sh
set -eu

base=https://github.com/nlp-research-rosu/intent-check/releases/download/__INTENT_CHECK_RELEASE_TAG__
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=intent-check-darwin-arm64.tar.gz ;;
  Darwin-x86_64) asset=intent-check-darwin-x64.tar.gz ;;
  Linux-x86_64) asset=intent-check-linux-x64.tar.gz ;;
  Linux-aarch64|Linux-arm64) asset=intent-check-linux-arm64.tar.gz ;;
  *) echo "intent-check: unsupported platform $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

destination=${INTENT_CHECK_INSTALL_DIR:-"${HOME}/.local/bin"}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)
marker="$destination/.intent-check.sha256"
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
existing=$(command -v intent-check 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$destination/intent-check" ]; then
  echo "intent-check: another intent-check command is on PATH at $existing" >&2
  exit 1
fi
if [ -L "$destination/intent-check" ]; then
  echo "intent-check: refusing to replace a symlink at $destination/intent-check" >&2
  exit 1
fi
if [ -e "$destination/intent-check" ]; then
  if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$(hash_file "$destination/intent-check")" ]; then
    echo "intent-check: refusing to replace an unrelated executable at $destination/intent-check" >&2
    exit 1
  fi
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/intent-check-install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 -LsSf "$base/$asset" -o "$work/$asset"
curl --proto '=https' --tlsv1.2 -LsSf "$base/$asset.sha256" -o "$work/checksum"
expected=$(awk '{print $1}' "$work/checksum")
actual=$(hash_file "$work/$asset")
test "$actual" = "$expected" || { echo "intent-check: checksum mismatch" >&2; exit 1; }

tar -xzf "$work/$asset" -C "$work"
install -m 0755 "$work/intent-check" "$destination/intent-check"
hash_file "$destination/intent-check" > "$marker"
"$destination/intent-check" --version

quote() {
  quoted=$1
  if [ "${2:-sh}" = fish ]; then
    quoted=$(printf '%s' "$quoted" | sed 's/\\/\\\\/g')
  fi
  printf "'%s'" "$(printf '%s' "$quoted" | sed "s/'/'\\\\''/g")"
}
env_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/intent-check
mkdir -p "$env_dir"
env_dir=$(cd "$env_dir" && pwd)
quoted_destination=$(quote "$destination")
printf 'case ":$PATH:" in\n  *:%s:*) ;;\n  *) export PATH=%s:"$PATH" ;;\nesac\n' \
  "$quoted_destination" "$quoted_destination" > "$env_dir/env"
source_line=". $(quote "$env_dir/env")"
add_to_profile() {
  mkdir -p "$(dirname "$1")"
  if ! grep -Fqx "$source_line" "$1" 2>/dev/null; then
    printf '\n%s\n' "$source_line" >> "$1"
  fi
}
login_shell=${SHELL:-/bin/sh}
case "${login_shell##*/}" in
  zsh) add_to_profile "${ZDOTDIR:-$HOME}/.zshenv" ;;
  bash)
    add_to_profile "$HOME/.bashrc"
    if [ -f "$HOME/.bash_profile" ]; then
      add_to_profile "$HOME/.bash_profile"
    elif [ -f "$HOME/.bash_login" ]; then
      add_to_profile "$HOME/.bash_login"
    else
      add_to_profile "$HOME/.profile"
    fi
    ;;
  fish)
    quoted_destination=$(quote "$destination" fish)
    printf 'if not contains -- %s $PATH\n  set -gx PATH %s $PATH\nend\n' \
      "$quoted_destination" "$quoted_destination" > "$env_dir/env.fish"
    source_line="source $(quote "$env_dir/env.fish" fish)"
    add_to_profile "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/intent-check.fish"
    ;;
  sh|dash|ksh|ash) add_to_profile "$HOME/.profile" ;;
  *) echo "intent-check: add $destination to PATH in your $login_shell configuration"; exit 0 ;;
esac
printf 'Open a new terminal, or run this command in your current shell:\n  %s\n' "$source_line"
echo "Then run intent-check health and intent-check semantics."
