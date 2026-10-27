import { Command } from "commander";
import { VERSION } from "./index.js";

const program = new Command("openteleport")
  .version(VERSION)
  .description("Move your AI agent between apps in one command.");

program.parse();
