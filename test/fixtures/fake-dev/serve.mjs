// Stand-in for `next dev` in test/server.test.ts. startNext appends `-p <port>`.
import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
createServer((req, res) => res.end("ok")).listen(port);
