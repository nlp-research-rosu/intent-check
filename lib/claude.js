// Claude Code output protocol (verified live on 2.1.283, research/02):
// - SessionStart / UserPromptSubmit: one stdout JSON object. systemMessage is shown to the
//   user; hookSpecificOutput.additionalContext goes to the model.
// - Stop (asyncRewake): exit 2 wakes the agent with stderr as the model-visible body. Claude Code
//   reads the first {-prefixed stdout line for rewakeSummary, the one-liner the user sees.
//   hookSpecificOutput must NOT carry hookEventName "Stop" (fails validation; security-guidance #2159).

export function contextOutput(eventName, { user, context }) {
  const o = {};
  if (user) o.systemMessage = user.slice(0, 9000);
  if (context) o.hookSpecificOutput = { hookEventName: eventName, additionalContext: context.slice(0, 9500) };
  return Object.keys(o).length ? JSON.stringify(o) + "\n" : "";
}

export function wakeOutput({ text, summary }) {
  return {
    stdout: JSON.stringify({ rewakeSummary: summary }) + "\n",
    stderr: text.slice(0, 9500) + "\n",
    code: 2,
  };
}
