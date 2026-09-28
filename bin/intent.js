var major = parseInt(String(process.versions && process.versions.node).split(".")[0], 10); if (!(major >= 18)) { process.exit(0); }
// Line 1 must stay old syntax (no ?. or ??): on Node < 18 the hook exits 0 instead of failing,
// so a broken hook can never loop the agent (Claude Code bug #96148).
import("../lib/main.js").then(function (m) { return m.main(process.argv.slice(2)); }).catch(function () { process.exit(0); });
