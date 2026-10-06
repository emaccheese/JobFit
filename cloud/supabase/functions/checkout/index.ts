// POST /checkout — see _shared/billing.ts.
import { handleCheckout } from "../_shared/billing.ts";
import { backend, billingProvider } from "../_shared/env.ts";
import { serve } from "../_shared/serve.ts";

serve("checkout", (req) => handleCheckout(req, { backend: backend(), provider: billingProvider() }));
