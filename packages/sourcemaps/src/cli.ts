#!/usr/bin/env node
import process from "node:process";

import { run } from "./main.ts";

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
