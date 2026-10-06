var major = parseInt(String(process.versions && process.versions.node).split(".")[0], 10); function oldNode() { var msg = "Intent Check needs Node 18 or newer (found " + process.versions.node + "), so it is not running. Update Node to use it.\n"; var d = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA; var done = function () { process.exit(0); }; if (!d) { process.stderr.write(msg); return done(); } import("fs").then(function (m) { var fs = m.default || m; try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + "/.node-too-old-" + process.versions.node, "", { flag: "wx" }); process.stderr.write(msg); } catch (e) { if (!e || e.code !== "EEXIST") process.stderr.write(msg); } done(); }, function () { process.stderr.write(msg); done(); }); }
// Line 1 must stay old syntax (no ?. or ??): on Node < 18 the hook exits 0 instead of failing,
// so a broken hook can never loop the agent (Claude Code bug #96148). It says why on stderr, once
// per Node version and data dir (marker file .node-too-old-<version>), instead of on every hook.
if (!(major >= 18)) oldNode(); else import("../lib/main.js").then(function (m) { return m.main(process.argv.slice(2)); }).catch(function (e) {
  process.stderr.write("Intent Check could not start (" + String((e && (e.code || e.name)) || "error") + "), so it is not running. Reinstall the plugin if this keeps happening.\n");
  process.exit(0);
});
