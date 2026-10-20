// Prints the ZEROCI_E2E start and end lines the end-to-end test reads to
// measure how far jobs ran in parallel.
async function timed(name, body = () => {}) {
  console.log(`ZEROCI_E2E ${name} start ${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  body();
  console.log(`ZEROCI_E2E ${name} end ${Date.now()}`);
}

module.exports = { timed };
