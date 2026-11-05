if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error("Intent Check commands need Node.js 18 or newer.");
  process.exitCode = 1;
} else {
  import("../lib/main.js").then(async ({ main }) => {
    console.log(await main(process.argv.slice(2)));
  }).catch((error) => {
    console.error(`Intent Check: ${error.message}`);
    process.exitCode = 1;
  });
}
