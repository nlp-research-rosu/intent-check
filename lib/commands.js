// Explicit diagnostics. Sign-in and plugin updates are separate user-invoked commands.
import { apiKey, apiUrl, dataDir, pluginVersion, credentialsFile, credentialsProblem, disabledReason } from "./config.js";
import { checkKey, notApprovedText } from "./api.js";

function accountLine(response) {
  if (!response) return "not connected; run intent-prover login";
  if (response.ok) return "key accepted";
  if (response.status === 401) return "key rejected; run intent-prover login";
  if (response.code === "ACCESS_NOT_APPROVED") return notApprovedText();
  return "could not reach the service";
}

export async function doctorCommand() {
  const key = apiKey();
  const reason = disabledReason();
  const problem = key.key ? null : credentialsProblem();
  const response = key.key ? await checkKey(key.key) : null;
  const lines = [
    `Intent Prover v${pluginVersion()}: explicit Scan and Prove`,
    `Service: ${apiUrl()}`,
    `Account: ${accountLine(response)}`,
    `Key source: ${key.source === "env" ? "INTENT_API_KEY" : key.key ? credentialsFile() : "none"}`,
    `Local Scan state: ${dataDir()}`,
    "Automatic hooks and reviews: none",
  ];
  if (reason) lines.push(`${reason}=1 blocks plugin Scan commands. Remove it before scanning.`);
  if (problem) lines.push(`Credentials: ${problem}`);
  lines.push("Scan commands wait for results. Resume an interrupted Scan: scan collect [task-id]");
  return lines.join("\n");
}
