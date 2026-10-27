// Stand-in dev command that never serves HTTP. Records its pid (also its process-group id) for the test.
import { writeFileSync } from "node:fs";

writeFileSync(process.env.IMGTUNE_PIDFILE, String(process.pid));
setInterval(() => {}, 1000);
