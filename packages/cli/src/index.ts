#!/usr/bin/env bun
import { run } from "./cli.js";

run(process.argv).catch((err) => {
	console.error(err);
	process.exit(1);
});
