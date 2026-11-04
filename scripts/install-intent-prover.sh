#!/bin/sh
set -eu

base=https://github.com/nlp-research-rosu/intent-check/releases/download/__INTENT_PROVER_RELEASE_TAG__
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) asset=intent-prover-darwin-arm64.tar.gz ;;
  Darwin-x86_64) asset=intent-prover-darwin-x64.tar.gz ;;
  Linux-x86_64) asset=intent-prover-linux-x64.tar.gz ;;
  Linux-aarch64|Linux-arm64) asset=intent-prover-linux-arm64.tar.gz ;;
  *) echo "intent-prover: unsupported platform $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

destination=${INTENT_PROVER_INSTALL_DIR:-"${HOME}/.local/bin"}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)
marker="$destination/.intent-prover.sha256"
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
existing=$(command -v intent-prover 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$destination/intent-prover" ]; then
  echo "intent-prover: another intent-prover command is on PATH at $existing" >&2
  exit 1
fi
if [ -L "$destination/intent-prover" ]; then
  echo "intent-prover: refusing to replace a symlink at $destination/intent-prover" >&2
  exit 1
fi
if [ -e "$destination/intent-prover" ]; then
  if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$(hash_file "$destination/intent-prover")" ]; then
    echo "intent-prover: refusing to replace an unrelated executable at $destination/intent-prover" >&2
    exit 1
  fi
fi

legacy=$(command -v intent-check 2>/dev/null || true)
if [ -z "$legacy" ] && [ -e "$destination/intent-check" ]; then
  legacy="$destination/intent-check"
fi
if [ "${INTENT_PROVER_REMOVE_LEGACY:-0}" = 1 ] && [ -n "$legacy" ]; then
  legacy_marker="$(dirname "$legacy")/.intent-check.sha256"
  if [ -L "$legacy" ] || [ ! -f "$legacy" ] || [ ! -f "$legacy_marker" ] ||
     [ "$(cat "$legacy_marker")" != "$(hash_file "$legacy")" ]; then
    echo "intent-prover: cannot identify a managed old binary at $legacy; remove it through its original installer" >&2
    exit 1
  fi
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/intent-prover-install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 -LsSf "$base/$asset" -o "$work/$asset"
curl --proto '=https' --tlsv1.2 -LsSf "$base/$asset.sha256" -o "$work/checksum"
expected=$(awk '{print $1}' "$work/checksum")
actual=$(hash_file "$work/$asset")
test "$actual" = "$expected" || { echo "intent-prover: checksum mismatch" >&2; exit 1; }

tar -xzf "$work/$asset" -C "$work"
"$work/intent-prover" --version
"$work/intent-prover" runtime
"$work/intent-prover" requirements --help >/dev/null
install -m 0755 "$work/intent-prover" "$destination/intent-prover"
hash_file "$destination/intent-prover" > "$marker"
"$destination/intent-prover" migrate
"$destination/intent-prover" config >/dev/null
if [ -n "$legacy" ]; then
  if [ "${INTENT_PROVER_REMOVE_LEGACY:-0}" = 1 ]; then
    rm "$legacy" "$legacy_marker"
    echo "Removed the verified old binary: $legacy"
  else
    echo "Deprecated binary found at $legacy. After authorizing removal, rerun with INTENT_PROVER_REMOVE_LEGACY=1."
  fi
fi

quote() {
  quoted=$1
  if [ "${2:-sh}" = fish ]; then
    quoted=$(printf '%s' "$quoted" | sed 's/\\/\\\\/g')
  fi
  printf "'%s'" "$(printf '%s' "$quoted" | sed "s/'/'\\\\''/g")"
}
env_dir=${XDG_CONFIG_HOME:-"$HOME/.config"}/intent-prover
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
    add_to_profile "${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/intent-prover.fish"
    ;;
  sh|dash|ksh|ash) add_to_profile "$HOME/.profile" ;;
  *) echo "intent-prover: add $destination to PATH in your $login_shell configuration"; exit 0 ;;
esac
printf 'Open a new terminal, or run this command in your current shell:\n  %s\n' "$source_line"
echo "Then run intent-prover health and intent-prover semantics."
