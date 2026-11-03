use super::*;
use regex::Captures;
use std::collections::{HashMap, HashSet};

pub(super) fn never(path: &str) -> bool {
    re(r"(?i)(^|/)\.env(\.|$)|\.(pem|key|p12|pfx|kdbx|tfstate)$|(^|/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$|(^|/)credentials(\.(json|ya?ml|ini|txt))?$").is_match(path)
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
    pub fn new() -> Self {
        Self {
            keys: crate::auth::stored_keys().unwrap_or_default(),
        }
    }
    pub fn text(&self, input: &str) -> (String, u64) {
        let input = input.replace('\0', "");
        let input = input.as_str();
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
        // Preserve the separator in the replacement; bound the key at the start of the regex
        // rather than retrying its keyword suffix at every byte of a long identifier.
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
    pub fn diff(&self, diff: &str, content: &str) -> (String, u64) {
        let mut key_lines = HashSet::new();
        let mut block = false;
        for (i, line) in content.split('\n').enumerate() {
            if re(r"-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY").is_match(line) {
                block = true;
            }
            if block {
                key_lines.insert(i + 1);
            }
            if re(r"-----END[ A-Z0-9_-]{0,100}PRIVATE KEY").is_match(line) {
                block = false;
            }
        }
        let (text, mut count) = self.text(diff);
        let mut number = 0;
        let mut lines = Vec::new();
        let mut hunk = 0;
        let mut in_hunk = false;
        let mut touched = HashSet::new();
        let mut line_hunks = Vec::new();
        for line in text.split('\n') {
            if let Some(c) = re(r"^@@ -\d+(,\d+)? \+(\d+)(,\d+)? @@").captures(line) {
                number = c[2].parse().unwrap_or(0);
                hunk += 1;
                in_hunk = true;
                lines.push(line.into());
                line_hunks.push(None);
                continue;
            }
            if line.starts_with("diff --git ") {
                in_hunk = false;
            }
            line_hunks.push(in_hunk.then_some(hunk));
            if in_hunk && number > 0 && (line.starts_with('+') || line.starts_with(' ')) {
                if key_lines.contains(&number) {
                    touched.insert(hunk);
                }
                if key_lines.contains(&number) && !line.contains("‹redacted") {
                    lines.push(format!("{}‹redacted:private-key›", &line[..1]));
                    count += 1;
                } else {
                    lines.push(line.into());
                }
                number += 1;
            } else {
                lines.push(line.into());
            }
        }
        for (line, hunk) in lines.iter_mut().zip(line_hunks) {
            if hunk.is_some_and(|h| touched.contains(&h))
                && re(r"^-[A-Za-z0-9+/=]{16,}\s*$").is_match(line)
            {
                *line = "-‹redacted:private-key›".into();
                count += 1;
            }
        }
        (lines.join("\n"), count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redactor() -> Redactor {
        Redactor { keys: Vec::new() }
    }

    #[test]
    fn known_secret_formats_keep_line_counts() {
        let secrets = [
            (
                "private-key",
                format!(
                    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA{}\n{}\n-----END RSA PRIVATE KEY-----",
                    "x".repeat(40),
                    "y".repeat(60)
                ),
            ),
            ("aws-key", format!("AKIA{}", "QWERTYUIOPASDFGH")),
            (
                "github-token",
                format!("ghp_{}", "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5"),
            ),
            (
                "anthropic-key",
                format!("sk-ant-api03-{}", "Ab1_".repeat(22)),
            ),
            ("openai-key", format!("sk-proj-{}", "Zq8".repeat(14))),
            (
                "stripe-key",
                format!("sk_{}{}", "live_", "4eC39HqLyjWDarjtT1zdp7dc"),
            ),
            (
                "slack-token",
                format!("xoxb-{}", "123456789012-abcdefABCDEF"),
            ),
            (
                "google-key",
                format!("AIza{}", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6q"),
            ),
            (
                "jwt",
                [
                    "eyJhbGciOiJIUzI1NiJ9",
                    ".eyJzdWIiOiIxMjM0NTY3ODkwIn0",
                    ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
                ]
                .concat(),
            ),
            (
                "npm-token",
                format!("npm_{}", "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5"),
            ),
            (
                "twilio-key",
                format!("SK{}", "0123456789abcdef0123456789abcdef"),
            ),
        ];
        for (rule, secret) in secrets {
            let input = format!("before\nvalue = {secret} # tail\nafter\n");
            let (text, count) = redactor().text(&input);
            let sample = secret.split('\n').nth(1).unwrap_or(&secret);
            assert!(count >= 1, "no redaction for {rule}");
            assert!(!text.contains(sample), "{rule} survived: {text}");
            assert_eq!(
                text.split('\n').count(),
                input.split('\n').count(),
                "{rule}"
            );
            assert!(text.contains("‹redacted:"), "missing marker for {rule}");
        }
    }

    #[test]
    fn opaque_keys_are_masked_on_every_occurrence() {
        let redactor = Redactor {
            keys: vec!["plain-opaque-key-1".into(), "another opaque value".into()],
        };
        let (text, count) = redactor.text(
            "a = plain-opaque-key-1\nb = another opaque value\nc = short\nd = plain-opaque-key-1\n",
        );
        assert_eq!(count, 3);
        assert_eq!(
            text,
            "a = ‹redacted:intent-key›\nb = ‹redacted:intent-key›\nc = short\nd = ‹redacted:intent-key›\n"
        );
    }

    #[test]
    fn diff_assignments_bearer_tokens_and_base64_bodies_keep_markers() {
        let secret = "Xk29fLq8Zr4Tw7Vb";
        for line in [
            format!("+DB_PASSWORD={secret}"),
            format!("+export STRIPE_SECRET={secret}"),
            format!("+  \"password\": \"{secret}\","),
            format!("+os.environ[\"DB_PASSWORD\"] = \"{secret}\""),
            format!("+config = {{\"secret_key\": \"{secret}\"}}"),
            "+headers = {\"Authorization\": \"Bearer abcDEF123ghiJKL456mnoPQR\"}".into(),
            "+MIIEowIBAAKCAQEAy8Dbv8prpJ/0kKhlGeJYozo2t60EG8L0561g13R29LvMR5hy".into(),
        ] {
            let diff = format!("--- a/x.py\n+++ b/x.py\n@@ -1,0 +1,1 @@\n{line}\n");
            let (text, count) = redactor().text(&diff);
            assert!(count >= 1, "{line}");
            for secret in [secret, "abcDEF123ghi", "MIIEow"] {
                assert!(!text.contains(secret), "{text}");
            }
            assert_eq!(text.split('\n').count(), diff.split('\n').count());
            assert!(text.lines().nth(3).expect("diff line").starts_with('+'));
        }
        assert_eq!(
            redactor()
                .text("+a3f5b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1\n")
                .1,
            0
        );
        for line in [
            "authorization: bearer abcDEF123ghiJKL456mnoPQR",
            "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=",
            "Authorization: Token 9f8e7d6c5b4a39281706f5e4",
        ] {
            let (text, count) = redactor().text(line);
            assert_eq!(count, 1, "{line}");
            assert!(text.contains("‹redacted:bearer-token›"), "{text}");
        }
        let prose = "Token authentication handles expiry. Basic authentication is disabled.";
        assert_eq!(redactor().text(prose).0, prose);
    }

    #[test]
    fn pem_diff_context_and_removed_body_lines_are_masked() {
        let content = "x = 1\nKEY = '''\n-----BEGIN RSA PRIVATE KEY-----\nabcdefghij0123456789\nshort+line/ABC\nxyzXYZ0987654321\n-----END RSA PRIVATE KEY-----\n'''\n";
        let diff = "--- a/k.py\n+++ b/k.py\n@@ -4,2 +4,3 @@\n abcdefghij0123456789\n+short+line/ABC\n xyzXYZ0987654321\n";
        let text = redactor().diff(diff, content).0;
        for body in ["abcdefghij0123456789", "short+line/ABC", "xyzXYZ0987654321"] {
            assert!(!text.contains(body), "{text}");
        }
        assert!(text.lines().any(|line| line == " ‹redacted:private-key›"));
        assert!(text.lines().any(|line| line == "+‹redacted:private-key›"));
        let content = "-----BEGIN RSA PRIVATE KEY-----\nabcdefghij0123456789\nNEWLINEabc0123456789\n-----END RSA PRIVATE KEY-----\n";
        let diff = "--- a/k.pem.txt\n+++ b/k.pem.txt\n@@ -2,2 +2,2 @@\n abcdefghij0123456789\n-OLDLINExyz9876543210\n+NEWLINEabc0123456789\n";
        let text = redactor().diff(diff, content).0;
        for body in ["OLDLINE", "NEWLINE", "abcdefghij"] {
            assert!(!text.contains(body), "{text}");
        }
    }

    #[test]
    fn unclosed_pem_and_long_lines_stay_linear() {
        let line = "-----BEGIN RSA PRIVATE KEY-----\n";
        let big = line.repeat((1024 * 1024usize).div_ceil(line.len()));
        let start = Instant::now();
        assert_eq!(redactor().text(&big).0.len(), big.len());
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "PEM redaction took {:?}",
            start.elapsed()
        );
        assert!(
            !redactor()
                .text("-----BEGIN PRIVATE KEY-----\nMIIsecret\n-----END PRIVATE KEY-----")
                .0
                .contains("MIIsecret")
        );
        for unit in ["a", "password", "x.y-", "secret_", "ey"] {
            let line = unit.repeat(65536usize.div_ceil(unit.len()));
            let start = Instant::now();
            redactor().text(&line);
            assert!(
                start.elapsed() < Duration::from_secs(1),
                "{unit}: {:?}",
                start.elapsed()
            );
        }
        let start = Instant::now();
        redactor().text(&"token_".repeat(170000));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "large line: {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn url_password_is_masked_without_removing_host() {
        let (text, _) =
            redactor().text("DB = \"postgres://admin:s3cr3tP4ss@db.internal:5432/app\"");
        assert!(!text.contains("s3cr3tP4ss"));
        assert!(text.contains("db.internal"));
    }

    #[test]
    fn random_keyword_assignments_and_env_values_are_masked() {
        let (text, count) = redactor().text("api_key = \"Xk29fLq8Zr4Tw7Vb\"\nexport DATABASE_PASSWORD=Hq8w2Lz9Xk4Tb7Vm\nSTRIPE_TOKEN=Ab9dKq2Lx8Wz\n");
        assert_eq!(count, 3, "{text}");
        for value in ["Xk29fLq8Zr4Tw7Vb", "Hq8w2Lz9Xk4Tb7Vm", "Ab9dKq2Lx8Wz"] {
            assert!(!text.contains(value), "{value} survived");
        }
    }

    #[test]
    fn ordinary_code_is_unchanged() {
        let input = [
            "def apply_discount(price_cents: int, percent: int) -> int:",
            "    token = get_token(user)",
            "    password = request.form.password",
            "    auth_header = self.auth_header",
            "    secret_name = SECRET_NAME",
            "    tokens = tokenize(\"hello world\")",
            "    return price_cents - price_cents * percent // 100",
            "DEBUG=true",
            "LOG_LEVEL=info",
        ]
        .join("\n");
        assert_eq!(redactor().text(&input), (input, 0));
    }

    #[test]
    fn pem_diff_keeps_markers_and_line_count() {
        let input = [
            "@@ -0,0 +1,4 @@",
            "+-----BEGIN PRIVATE KEY-----",
            "+MIIBVQIBADANBgkqhkiG9w0BAQEFAASC",
            "+AT8wggE7AgEAAkEA",
            "+-----END PRIVATE KEY-----",
            "",
        ]
        .join("\n");
        let (text, _) = redactor().text(&input);
        assert_eq!(text.split('\n').count(), input.split('\n').count());
        assert!(!text.contains("MIIBVQ"));
        assert!(
            text.split('\n')
                .skip(2)
                .take(3)
                .all(|line| line.starts_with('+'))
        );
    }

    #[test]
    fn key_and_env_files_are_never_uploaded() {
        for path in [
            ".env",
            ".env.local",
            "config/.env.production",
            "certs/server.pem",
            "id_rsa",
            "keys/id_ed25519.pub",
            "aws/credentials",
            "credentials",
            "credentials.json",
            "config/credentials.yml",
            ".aws/credentials",
            "home/aws/credentials",
            "infra/terraform.tfstate",
        ] {
            assert!(never(path), "{path}");
        }
        for path in [
            "src/env.py",
            "pricing.py",
            "src/auth/login.py",
            "src/auth/credentials.py",
            "lib/credentials_store.go",
        ] {
            assert!(!never(path), "{path}");
            assert!(filter::include(path, ""), "{path}");
        }
    }
}
