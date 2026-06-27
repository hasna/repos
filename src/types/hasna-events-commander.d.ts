declare module "@hasna/events/commander" {
  import type { Command } from "commander";

  export function registerEventsCommands(
    program: Command,
    options?: { source?: string },
  ): void;
}
