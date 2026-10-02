# Permissions, single purpose and privacy practices

Answers for the Chrome Web Store dashboard's **Privacy practices** tab. Each
one matches what the code does; if the code changes, change these with it.

## Single purpose

Tino evaluates job postings against the user's CV and keeps track of the jobs
they evaluate.

## Permission justifications

| Permission | Why Tino needs it |
|---|---|
| `activeTab` | To read the job posting in the current tab when the user clicks Evaluate, uses the keyboard shortcut or the on-page button. |
| `scripting` | To run the posting reader in the tab the user asked to evaluate, and to register the optional on-page button on the job sites the user switched it on for. |
| `storage` | To keep the user's profiles, settings and tracked jobs in the browser. |
| `unlimitedStorage` | Tracked jobs keep each posting's text, so a long job search can pass Chrome's default 10 MB limit; without it, saving would start failing. |
| `alarms` | To resume the evaluation queue after Chrome suspends the extension's background worker. |
| `webNavigation` | To find the job-board frame inside company career sites that embed a Greenhouse board (`getAllFrames`), so the posting inside it can be read. |
| Host: `http://localhost/*`, `http://127.0.0.1/*` | To reach a model running on the user's own computer (LM Studio). |
| Host: `*://*.greenhouse.io/*` | To read Greenhouse job boards embedded in company career sites, which load in a frame from greenhouse.io. |
| Host: `https://api.openai.com/*` | For users who choose OpenAI, with their own API key, to score postings. |
| Optional host: `https://*/*`, `http://*/*` | Requested one site or job board at a time, only when the user switches on the on-page button there. Never requested broadly; the user can give each one back. |

**Remote code:** No. All code ships in the package; nothing is loaded or evaluated from elsewhere.

## Data usage (draft — review before submitting)

What Tino handles, in the dashboard's categories. "Collected" there includes
data sent off the device, which happens only when the user evaluates with a
model off their computer (another computer they allowed, or OpenAI with their
own key). Disclosing these conservatively is the safer reading.

| Category | Handled? | What and why |
|---|---|---|
| Personally identifiable information | Yes | The CV summary the user writes (it may include their name). Sent only to the model the user chose, to score postings. |
| Website content | Yes | The text of job postings the user asks Tino to evaluate. Sent only to the model the user chose. |
| Location | Yes, optional | City and region, only if the user turns that on; sent to the model with the profile. |
| Authentication information | Yes | The user's OpenAI API key, if they add one. Stored locally out of reach of web pages; sent only to OpenAI. |
| Health, financial and payment, personal communications, web history, user activity | No | |

**Certifications** (all true for Tino):
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://emaccheese.github.io/JobFit/privacy.html
