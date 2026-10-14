// POST /score — see _shared/score.ts.
import { handleScore } from "../_shared/score.ts";
import { backend, openAiKey, prompts } from "../_shared/env.ts";
import { serve } from "../_shared/serve.ts";

serve("score", (req) => handleScore(req, { backend: backend(), prompts: prompts(), openAiKey: openAiKey() }));
