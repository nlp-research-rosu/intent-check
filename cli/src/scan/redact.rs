use super::support::re;
use regex::Captures;
use std::collections::HashMap;

pub(super) fn never(path: &str) -> bool {
    re(r"(?i)(^|/)\.env(\.|$)|\.(pem|key|p12|pfx|kdbx|tfstate)$|(^|/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$|(^|/)credentials(\.(json|ya?ml|ini|txt))?$|(^|/)\.?aws/credentials$").is_match(path)
}
fn entropy(value: &str) -> f64 {
    let mut counts = HashMap::<char, f64>::new();
    let mut n = 0.;
    for c in value.chars() {
        *counts.entry(c).or_insert(0.) += 1.;
        n += 1.;
    }
    counts
        .values()
        .map(|count| {
            let p = count / n;
            -p * p.log2()
        })
        .sum()
}
fn secret(value: &str) -> bool {
    if re(r"^[A-Za-z_][A-Za-z0-9_]*$").is_match(value) && !value.chars().any(|c| c.is_ascii_digit())
    {
        return false;
    }
    if re(r"^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$|[()]").is_match(value) {
        return false;
    }
    if re(r"^(process\.env|os\.environ|getenv|ENV\[|\$\{|\$[A-Z_]|<|\(|\[|self\.|this\.)")
        .is_match(value)
    {
        return false;
    }
    if re(r"(?i)^(true|false|null|none|undefined|changeme|password|secret|example)$")
        .is_match(value)
    {
        return false;
    }
    entropy(value) >= 3.5
}
const KEYWORDS: &str =
    r"secret|passw(?:or)?d|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth";
const SIMPLE: &[(&str, &str)] = &[
    (
        "aws-key",
        r"\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b",
    ),
    (
        "github-token",
        r"\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{82})\b",
    ),
    (
        "anthropic-key",
        r"\bsk-ant-[a-z]{3,6}\d{2}-[A-Za-z0-9_-]{80,}",
    ),
    (
        "openai-key",
        r"\bsk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}",
    ),
    (
        "stripe-key",
        r"\b(sk|rk)_(live|test|prod)_[A-Za-z0-9]{10,99}\b",
    ),
    ("slack-token", r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    (
        "slack-webhook",
        r"hooks\.slack\.com/(services|workflows|triggers)/[A-Za-z0-9+/]{43,56}",
    ),
    ("google-key", r"\bAIza[\w-]{35}\b"),
    (
        "jwt",
        r"\bey[A-Za-z0-9_-]{17,}\.ey[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{10,}",
    ),
    ("npm-token", r"\bnpm_[A-Za-z0-9]{36}\b"),
    ("sendgrid-key", r"\bSG\.[A-Za-z0-9_.-]{66}\b"),
    ("twilio-key", r"\bSK[0-9a-fA-F]{32}\b"),
];

pub(super) struct Redactor {
    keys: Vec<String>,
}
impl Redactor {
    pub(super) fn new() -> Self {
        Self {
            keys: crate::auth::stored_keys().unwrap_or_default(),
        }
    }
    pub(super) fn text(&self, input: &str) -> (String, u64) {
        let begin = re(r"-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----");
        let end = re(r"-----END[ A-Z0-9_-]{0,100}PRIVATE KEY( BLOCK)?-----");
        let mut text = String::new();
        let mut position = 0;
        let mut count = 0;
        while let Some(b) = begin.find_at(input, position) {
            let Some(e) = end.find_at(input, b.end()) else {
                break;
            };
            text.push_str(&input[position..b.start()]);
            for (i, line) in input[b.start()..e.end()].split('\n').enumerate() {
                if i == 0 {
                    text.push_str("‹redacted:private-key›");
                } else {
                    text.push('\n');
                    if let Some(c) = line.chars().next().filter(|c| "+- ".contains(*c)) {
                        text.push(c);
                    }
                }
            }
            position = e.end();
            count += 1;
        }
        text.push_str(&input[position..]);
        for key in &self.keys {
            count += text.matches(key).count() as u64;
            text = text.replace(key, "‹redacted:intent-key›");
        }
        for (name, pattern) in SIMPLE {
            let rule = re(pattern);
            count += rule.find_iter(&text).count() as u64;
            text = rule
                .replace_all(&text, format!("‹redacted:{name}›"))
                .into_owned();
        }
        text = re(r"(?i)\b((Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/-]{16,}=*)")
            .replace_all(&text, |c: &Captures| {
                if c[3].chars().any(|c| c.is_ascii_digit()) && !c[3].contains("‹redacted") {
                    count += 1;
                    format!("{}‹redacted:bearer-token›", &c[1])
                } else {
                    c[0].into()
                }
            })
            .into_owned();
        text = re(r"(?m)^([+\- ]?)([A-Za-z0-9+/]{60,}={0,2})$")
            .replace_all(&text, |c: &Captures| {
                if c[2].chars().any(|c| c.is_ascii_lowercase())
                    && c[2].chars().any(|c| c.is_ascii_uppercase())
                    && c[2].chars().any(|c| c.is_ascii_digit())
                {
                    count += 1;
                    format!("{}‹redacted:private-key›", &c[1])
                } else {
                    c[0].into()
                }
            })
            .into_owned();
        text = re(r"(?i)\b([a-z][a-z0-9+.-]{1,20}://[^\s:@/]{1,64}:)([^\s@/]{3,128})@")
            .replace_all(&text, |c: &Captures| {
                if c[2].starts_with("‹redacted") {
                    c[0].into()
                } else {
                    count += 1;
                    format!("{}‹redacted:url-credentials›@", &c[1])
                }
            })
            .into_owned();
        // The consumed separator replaces JS's negative lookbehind without backtracking.
        let pattern = format!(
            r#"(?i)(^|[^\w.-])([\w.-]{{0,64}}?(?:{KEYWORDS})[\w.-]{{0,64}})(["'`]?\]?\s*(?::=|=>|=|:)\s*["'`]?)([^\s"'`;,]{{8,}})"#
        );
        text = re(&pattern)
            .replace_all(&text, |c: &Captures| {
                if !c[4].contains("‹redacted") && secret(&c[4]) {
                    count += 1;
                    format!("{}{}{}‹redacted:keyword-assignment›", &c[1], &c[2], &c[3])
                } else {
                    c[0].into()
                }
            })
            .into_owned();
        text = re(r"(?m)^([+\- ]?\s*(?:export\s+)?)([A-Z][A-Z0-9_]{2,})(\s*=\s*)(\S{8,})$")
            .replace_all(&text, |c: &Captures| {
                if !c[4].contains("‹redacted")
                    && (re(&format!("(?i){KEYWORDS}")).is_match(&c[2]) || entropy(&c[4]) >= 3.5)
                    && secret(c[4].trim_matches(['\'', '"']))
                {
                    count += 1;
                    format!("{}{}{}‹redacted:env-line›", &c[1], &c[2], &c[3])
                } else {
                    c[0].into()
                }
            })
            .into_owned();
        (text, count)
    }
}
