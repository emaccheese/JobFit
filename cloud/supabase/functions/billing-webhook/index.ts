// POST /billing-webhook — see _shared/billing.ts. Called by the payment
// provider, not a user, so it's deployed without Supabase's JWT check
// (config.toml) and trusts only the provider's signature.
import { handleBillingWebhook } from "../_shared/billing.ts";
import { backend, billingProvider } from "../_shared/env.ts";
import { serve } from "../_shared/serve.ts";

serve("billing-webhook", (req) => handleBillingWebhook(req, { backend: backend(), provider: billingProvider() }));
