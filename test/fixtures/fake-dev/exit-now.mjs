// Stand-in for a dev command that fails before serving anything.
console.log("starting up");
console.error("fake dev failure: port in use");
process.exit(3);
