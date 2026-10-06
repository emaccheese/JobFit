// GET/POST /account — see _shared/account.ts.
import { handleAccount } from "../_shared/account.ts";
import { backend, billingProvider } from "../_shared/env.ts";
import { serve } from "../_shared/serve.ts";

serve("account", (req) => handleAccount(req, { backend: backend(), billingConfigured: billingProvider() !== null }));
