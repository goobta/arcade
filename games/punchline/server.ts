// Punchline's process entry point. The rules live in game.ts.
import { serve } from "@arcade/sdk";
import { createDefinition } from "./game.ts";

serve(createDefinition());
