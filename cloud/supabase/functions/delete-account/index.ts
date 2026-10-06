// POST /delete-account — see _shared/delete-account.ts.
import { handleDeleteAccount } from "../_shared/delete-account.ts";
import { backend } from "../_shared/env.ts";
import { serve } from "../_shared/serve.ts";

serve("delete-account", (req) => handleDeleteAccount(req, { backend: backend() }));
