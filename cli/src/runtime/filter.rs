use super::*;
use std::collections::{HashMap, HashSet};

pub(super) const VENDOR: &[&str] = &[
    "node_modules",
    "vendor",
    "dist",
    "build",
    "third_party",
    ".git",
    ".intent",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    "__generated__",
    "bower_components",
];
pub(super) fn ext(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}
pub(super) fn language(path: &str) -> &'static str {
    match ext(path).as_str() {
        ".py" | ".pyi" => "python",
        ".js" | ".mjs" | ".cjs" | ".jsx" => "javascript",
        ".ts" | ".mts" | ".cts" | ".tsx" => "typescript",
        ".go" => "go",
        ".rs" => "rust",
        ".java" => "java",
        ".kt" | ".kts" => "kotlin",
        ".c" | ".h" => "c",
        ".cc" | ".cpp" | ".cxx" | ".hpp" | ".hh" | ".hxx" => "cpp",
        ".cs" => "csharp",
        ".swift" => "swift",
        ".rb" => "ruby",
        ".php" => "php",
        ".sol" => "solidity",
        ".vy" => "vyper",
        ".scala" => "scala",
        ".sh" | ".bash" | ".zsh" => "shell",
        ".lua" => "lua",
        ".dart" => "dart",
        ".ex" | ".exs" => "elixir",
        ".erl" => "erlang",
        ".hs" => "haskell",
        ".ml" => "ocaml",
        ".clj" => "clojure",
        ".jl" => "julia",
        ".zig" => "zig",
        ".m" => "objective-c",
        ".mm" => "objective-c",
        ".pl" | ".pm" => "perl",
        ".groovy" => "groovy",
        ".fs" => "fsharp",
        ".nim" => "nim",
        ".r" => "r",
        ".move" => "move",
        ".cairo" => "cairo",
        ".html" => "html",
        ".vue" => "vue",
        ".svelte" => "svelte",
        _ => "text",
    }
}
pub(super) fn test_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    parts[..parts.len() - 1]
        .iter()
        .copied()
        .any(|p| ["tests", "__tests__", "test", "spec", "__mocks__"].contains(&p))
        || re(r"^test_|_test\.[^.]+$|\.(spec|test)\.[^.]+$")
            .is_match(parts.last().copied().unwrap_or(""))
}
pub(super) fn classify(path: &str) -> &'static str {
    let p = path.replace('\\', "/");
    let parts: Vec<_> = p.split('/').collect();
    let base = parts.last().copied().unwrap_or("");
    if p.is_empty()
        || p.starts_with('/')
        || p.starts_with("../")
        || redact::never(&p)
        || parts[..parts.len() - 1].iter().any(|p| VENDOR.contains(p))
        || test_path(&p)
        || re(r"\.min\.[^.]+$").is_match(base)
        || config_name(base)
    {
        return "no";
    }
    let ext = ext(path);
    if language(path) == "text" {
        return "no";
    }
    if parts
        .windows(2)
        .take(parts.len().saturating_sub(2))
        .any(|pair| pair == ["pages", "api"])
        || (parts.contains(&"app") && ["route.ts", "route.js"].contains(&base))
    {
        return "yes";
    }
    if [".jsx", ".tsx", ".vue", ".svelte", ".html"].contains(&ext.as_str()) {
        return "needs-content";
    }
    if parts[..parts.len() - 1]
        .iter()
        .any(|p| ["components", "ui", "views", "pages", "layouts", "styles"].contains(p))
    {
        return if re(r"^\.[cm]?[jt]sx?$").is_match(&ext) {
            "needs-content"
        } else {
            "no"
        };
    }
    "yes"
}
fn config_name(base: &str) -> bool {
    re(r"(?i)^([\w.-]+\.config\.[cm]?[jt]s|\.[\w-]+rc\.[cm]?js|gulpfile\.[cm]?js|gruntfile\.[cm]?js|setup\.py|conftest\.py|manage\.py)$").is_match(base)
}
pub(super) fn skip_reason(path: &str) -> &'static str {
    if test_path(path) {
        "test"
    } else if path.split('/').any(|s| VENDOR.contains(&s)) {
        "vendor"
    } else if config_name(path.rsplit('/').next().unwrap_or("")) {
        "config"
    } else if [
        ".css", ".scss", ".less", ".html", ".jsx", ".tsx", ".vue", ".svelte",
    ]
    .contains(&ext(path).as_str())
        || classify(path) == "needs-content"
    {
        "styling or markup"
    } else {
        "other"
    }
}
pub(super) fn candidate(path: &str) -> bool {
    !redact::never(path) && (classify(path) != "no" || skip_reason(path) != "other")
}

// Byte masking keeps newlines and source offsets. Templates recurse only for ${...} code.
fn mask(bytes: &mut [u8]) {
    for b in bytes {
        if *b != b'\n' {
            *b = b' ';
        }
    }
}
fn code(bytes: &mut [u8], mut i: usize, brace: bool) -> usize {
    let mut depth = usize::from(brace);
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'{' {
            depth += usize::from(brace);
            i += 1;
            continue;
        }
        if c == b'}' {
            i += 1;
            if brace {
                depth -= 1;
                if depth == 0 {
                    return i;
                }
            }
            continue;
        }
        if c == b'`' {
            bytes[i] = b' ';
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'`' {
                    bytes[i] = b' ';
                    i += 1;
                    break;
                }
                if bytes[i] == b'\\' {
                    let end = (i + 2).min(bytes.len());
                    mask(&mut bytes[i..end]);
                    i = end;
                    continue;
                }
                if bytes[i] == b'$' && bytes.get(i + 1) == Some(&b'{') {
                    mask(&mut bytes[i..i + 2]);
                    i = code(bytes, i + 2, true);
                    continue;
                }
                if bytes[i] != b'\n' {
                    bytes[i] = b' ';
                }
                i += 1;
            }
            continue;
        }
        let mut end = None;
        if c == b'\'' || c == b'"' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != c {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            end = Some((j + 1).min(bytes.len()));
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            end = Some(
                bytes[i..]
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|j| i + j)
                    .unwrap_or(bytes.len()),
            );
        } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            end = Some(
                bytes[i + 2..]
                    .windows(2)
                    .position(|s| s == b"*/")
                    .map(|j| i + 4 + j)
                    .unwrap_or(bytes.len()),
            );
        } else if c == b'/' {
            let previous = bytes[..i]
                .iter()
                .rev()
                .find(|b| !b" \t\r".contains(b))
                .copied()
                .unwrap_or(b'\n');
            if b"\n(,=:[!&|?{};".contains(&previous) {
                let mut j = i + 1;
                let mut class = false;
                while j < bytes.len() && bytes[j] != b'\n' {
                    if bytes[j] == b'\\' {
                        j += 2;
                        continue;
                    }
                    if bytes[j] == b'[' {
                        class = true;
                    }
                    if bytes[j] == b']' {
                        class = false;
                    }
                    if bytes[j] == b'/' && !class {
                        j += 1;
                        while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                            j += 1;
                        }
                        break;
                    }
                    j += 1;
                }
                end = Some(j.min(bytes.len()));
            }
        }
        if let Some(end) = end {
            mask(&mut bytes[i..end]);
            i = end;
        } else {
            i += 1;
        }
    }
    i
}
pub(super) fn include(path: &str, content: &str) -> bool {
    match classify(path) {
        "no" => return false,
        "yes" => return true,
        _ => {}
    }
    if re(r#"(^|[\s;{])["']use server["']"#).is_match(content) {
        return true;
    }
    let script_only = [".html", ".vue", ".svelte"].contains(&ext(path).as_str());
    let source = if script_only {
        let live = re(r"(?s)<!--.*?-->").replace_all(content, "");
        re(r"(?is)<script\b([^>]*)>(.*?)</script>")
            .captures_iter(&live)
            .filter(|c| {
                !re(r"(?i)\bsrc\s*=").is_match(&c[1])
                    && re(r#"(?i)(^|\s)type\s*=\s*["']?([^"'\s>]*)"#)
                        .captures(&c[1])
                        .is_none_or(|m| {
                            ["module", "text/javascript", "application/javascript"]
                                .contains(&m[2].to_lowercase().as_str())
                        })
            })
            .map(|c| c[2].to_owned())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        content.into()
    };
    let mut bytes = source.into_bytes();
    code(&mut bytes, 0, false);
    let code = String::from_utf8_lossy(&bytes);
    let flow = re(r"\b(if|for|while|switch)\s*\(|\bcase\b[^\n:;{}]*:|\btry\s*\{|\s\?\s")
        .find_iter(&code)
        .count();
    if flow >= 3 {
        return true;
    }
    let mut starts = HashSet::new();
    for m in re(r"\bfunction\b[^(){}]*\(").find_iter(&code) {
        let mut i = m.end();
        let mut depth = 1;
        while i < bytes.len() && depth > 0 {
            if bytes[i] == b'(' {
                depth += 1;
            } else if bytes[i] == b')' {
                depth -= 1;
            }
            i += 1;
        }
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b'{') {
            starts.insert(i);
        }
    }
    for m in re(r"=>\s*\{").find_iter(&code) {
        starts.insert(m.end() - 1);
    }
    for c in re(
        r"(?m)(^|[{,;])[ \t]*(?:(?:async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{",
    )
    .captures_iter(&code)
    {
        if !["if", "for", "while", "switch", "catch", "function"].contains(&&c[2]) {
            starts.insert(c.get(0).expect("Method match").end() - 1);
        }
    }
    let mut stack = Vec::new();
    let mut pairs = HashMap::new();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'{' {
            stack.push(i);
        } else if *b == b'}'
            && let Some(start) = stack.pop()
        {
            pairs.insert(start, i);
        }
    }
    if starts.iter().any(|start| {
        pairs.get(start).is_some_and(|end| {
            code[start + 1..*end]
                .lines()
                .filter(|s| !s.trim().is_empty())
                .count()
                >= 6
        })
    }) {
        return true;
    }
    let arithmetic = re(r"\bMath\.\w+\s*\(|[*/%]").find_iter(&code).count();
    let comparisons = re(r"[=!]==?|<=|>=").find_iter(&code).count();
    script_only && arithmetic >= 1 && flow + arithmetic + comparisons >= 3
}
