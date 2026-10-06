var major = parseInt(String(process.versions && process.versions.node).split(".")[0], 10); if (!(major >= 18)) { process.stderr.write("Intent Check needs Node 18 or newer (found " + process.versions.node + "), so it is not running. Update Node to use it.\n"); process.exit(0); }
// Line 1 must stay old syntax (no ?. or ??): on Node < 18 the hook exits 0 instead of failing,
// so a broken hook can never loop the agent (Claude Code bug #96148). It says why on stderr, once
// per run, instead of failing silently.
import("../lib/main.js").then(function (m) { return m.main(process.argv.slice(2)); }).catch(function (e) {
  process.stderr.write("Intent Check could not start (" + String((e && (e.code || e.name)) || "error") + "), so it is not running. Reinstall the plugin if this keeps happening.\n");
  process.exit(0);
});
